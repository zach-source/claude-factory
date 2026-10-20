// Tests for `factory gc --worktrees` end to end (claude-factory-l38). src/gc.test.ts proves
// worktreePlan() itself; these tests prove cli.ts feeds it real git facts, carries out its plan
// with real `git worktree remove`, snapshot commits and CAS branch deletes, and leaves a live
// run and an unmerged branch untouched.
//
// Each test builds a real bare "origin" and a real clone as the rig's repo, with real
// `git worktree add` worktrees for each fixture run. `gh` and `herdr` are fake binaries on PATH
// (same pattern as src/watch.test.ts and src/gc-cli.test.ts); `bd` is faked only for the bead
// tests. The origin's URL is rewritten with `insteadOf` so it reads as github.com to the forge
// check in cli.ts, while `git fetch`/`push` still reach the real local bare repo.
import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createActor } from 'xstate'
import { deleteBranchCas } from './cli'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
// realpath'd: macOS's tmpdir() is a /var symlink to /private/var, and `git worktree list` answers
// with the resolved path, which would otherwise never string-match a path this file built
const dir = join(realpathSync(tmpdir()), `gc-wt-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'factory',
  GIT_AUTHOR_EMAIL: 'factory@localhost',
  GIT_COMMITTER_NAME: 'factory',
  GIT_COMMITTER_EMAIL: 'factory@localhost',
}
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...GIT_ENV } })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0', ...env },
    timeout: 30_000,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

type Pane = { pane_id: string; workspace_id: string; cwd?: string }
/** a fake herdr: `pane list` answers the given panes; everything else fails (never used here) */
function fakeHerdr(path: string, panes: Pane[]) {
  mkdirSync(bin, { recursive: true })
  const body = JSON.stringify({ result: { panes } })
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "pane" ] && [ "$2" = "list" ]; then printf '%s' '${body}'; else exit 1; fi\n`,
  )
  chmodSync(path, 0o755)
}
const noPanes = () => {
  fakeHerdr(join(bin, 'herdr'), [])
  return join(bin, 'herdr')
}

/** A fake `gh` answers `api graphql --paginate` with the given PRs. It splits the PRs into
 * NDJSON pages. Each page has up to 100 nodes.
 *
 * A real `gh --paginate` run sends many HTTP requests. This fake sends the data in one process
 * call. The call log shows exactly 1 call.
 *
 * The default value of `totalCount` is `prs.length`. If you set a higher value, a page reports
 * fewer nodes than `totalCount`. Then parsePrPages() must return null (AC4).
 *
 * `isCrossRepository` is optional on a PR entry. If you omit it, the fake shows an older `gh`
 * answer, or an incorrect answer (claude-factory-ulv).
 *
 * `JSON.stringify` removes an `undefined` key from the body. Then parsePrPages() must reject
 * that entry (fail closed, claude-factory-ph8.4). */
function fakeGh(
  prs: {
    number: number
    state: string
    headRefName: string
    headRefOid: string
    isCrossRepository?: boolean
  }[],
  opts: { totalCount?: number } = {},
) {
  mkdirSync(bin, { recursive: true })
  const totalCount = opts.totalCount ?? prs.length
  const pages: string[] = []
  for (let i = 0; i < prs.length || pages.length === 0; i += 100) {
    pages.push(JSON.stringify({ totalCount, nodes: prs.slice(i, i + 100) }))
  }
  const body = pages.join('\n').replaceAll("'", "'\\''")
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$*" >> ${join(dir, 'gh-calls.log')}\nif [ "$1" = "api" ] && [ "$2" = "graphql" ]; then printf '%s' '${body}'; else exit 1; fi\n`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
}
const failGh = () => {
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'gh'), 0o755)
}

/** a fake bd: `show <id> --json` answers closed when a marker file for the id exists. It logs every
 * `show` call to bd-calls.log (claude-factory-ulv: proves a fork bead's id is never looked up). */
function fakeBd() {
  mkdirSync(bin, { recursive: true })
  const closedDir = join(dir, 'bd-closed')
  mkdirSync(closedDir, { recursive: true })
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `if [ "$1" = "show" ]; then`,
      `  echo "$*" >> '${join(dir, 'bd-calls.log')}'`,
      `  if [ -f "${closedDir}/$2" ]; then`,
      `    printf '%s' '{"id":"'"$2"'","title":"t","status":"closed"}'`,
      '  else',
      `    printf '%s' '{"id":"'"$2"'","title":"t","status":"open"}'`,
      '  fi',
      'else',
      '  exit 1',
      'fi',
    ].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
  return { closeBead: (id: string) => writeFileSync(join(closedDir, id), '') }
}

/** a `git` shim on PATH that logs every fetch/ls-remote/push call (with GIT_TERMINAL_PROMPT) to
 * `logFile`, then runs the real git so every other call in the test still works (claude-factory-l38.12) */
const REAL_GIT = Bun.spawnSync(['which', 'git']).stdout.toString().trim()
function spyGit(logFile: string) {
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'if [ "$3" = "fetch" ] || [ "$3" = "ls-remote" ] || [ "$3" = "push" ]; then',
      `  printf '%s GIT_TERMINAL_PROMPT=%s\\n' "$*" "$GIT_TERMINAL_PROMPT" >> '${logFile}'`,
      'fi',
      `exec '${REAL_GIT}' "$@"`,
    ].join('\n'),
  )
  chmodSync(join(bin, 'git'), 0o755)
}

/** a `git` shim that, on `git -C <path> add ...`, logs `$GIT_INDEX_FILE` and the mode bits of its
 * directory (read before the real git runs, while the dir still exists), then runs the real git
 * (claude-factory-ulv: proves snapshotWorktree's index dir is private, not a shared tmpdir path). */
function spyGitIndex(logFile: string) {
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'if [ "$3" = "add" ] && [ -n "$GIT_INDEX_FILE" ]; then',
      '  d=$(dirname "$GIT_INDEX_FILE")',
      `  printf '%s %s\\n' "$GIT_INDEX_FILE" "$(ls -ld "$d" | awk '{print $1}')" >> '${logFile}'`,
      'fi',
      `exec '${REAL_GIT}' "$@"`,
    ].join('\n'),
  )
  chmodSync(join(bin, 'git'), 0o755)
}

/** a `git` shim on PATH (T2/T2b, claude-factory-0lt.2). `sub` and `sub2` match argv[3] and
 * argv[4]. On that match it prints `stderr`, then exits with `exitCode`. On every other call it
 * runs real git. `stderr` must hold no single quote. */
function failGit(sub: string, sub2: string | null, stderr: string, exitCode: number) {
  mkdirSync(bin, { recursive: true })
  const cond = sub2 ? `[ "$3" = "${sub}" ] && [ "$4" = "${sub2}" ]` : `[ "$3" = "${sub}" ]`
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      `if ${cond}; then`,
      `  printf '%s\\n' '${stderr}' >&2`,
      `  exit ${exitCode}`,
      'fi',
      `exec '${REAL_GIT}' "$@"`,
    ].join('\n'),
  )
  chmodSync(join(bin, 'git'), 0o755)
}

/** a bare "origin" and a clone the test treats as the rig's own repo, with `main` as the one commit
 * every branch starts from. The origin's URL reads as `originUrl` (default: a github.com URL, so
 * cli.ts's forge check passes) but `insteadOf` sends fetch/push to the real local bare repo. */
function makeRig(name: string, originUrl = 'https://github.com/acme/widget.git') {
  const origin = join(dir, `${name}-origin.git`)
  const repo = join(dir, name)
  mkdirSync(origin, { recursive: true })
  git(dir, 'init', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '--quiet', origin, repo)
  writeFileSync(join(repo, 'README.md'), 'x')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'remote', 'set-url', 'origin', originUrl)
  git(repo, 'config', `url.file://${origin}.insteadOf`, originUrl)
  git(repo, 'fetch', '--quiet', 'origin')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  return { origin, repo }
}

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}
const freshId = (name: string) =>
  `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const runDir = (id: string) => join(home, 'runs', id)

/** one run's worktree (a real `git worktree add`), run.json and state.json, as gc.worktreePlan()
 * needs it. `merged`: the branch is fast-forwarded into origin's main before the worktree is made,
 * so its tip is already an ancestor. `bead`: this run's bead id, for the bd-gated tests. */
function writeRun(
  repo: string,
  id: string,
  opts: { outcome: 'done' | 'aborted' | 'working'; finishedAt?: number; merged?: boolean; bead?: string },
): { worktree: string; branch: string } {
  const branch = `factory/${id}`
  const worktree = join(dir, 'wt', id)
  mkdirSync(join(dir, 'wt'), { recursive: true })
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, 'main')
  writeFileSync(join(worktree, `${id}.txt`), id)
  git(worktree, 'add', `${id}.txt`)
  git(worktree, 'commit', '-q', '-m', `work on ${id}`)
  git(worktree, 'push', '-q', 'origin', `${branch}:${branch}`)
  // `repo`'s HEAD stays on main throughout (the branch is checked out in its own worktree, and
  // git refuses the same branch checked out twice): a worktree and the shared repo see the same refs
  if (opts.merged) {
    git(repo, 'merge', '-q', '--ff-only', branch)
    git(repo, 'push', '-q', 'origin', 'main')
  }
  const d = runDir(id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo,
      goal: 'g',
      ws: `ws-${id}`,
      worktree,
      branch,
      ...(opts.bead && { bead: opts.bead }),
    }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  if (opts.outcome === 'done')
    actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 's', at: opts.finishedAt ?? 0 })
  else if (opts.outcome === 'aborted') actor.send({ type: 'ABORT', at: opts.finishedAt ?? 0 })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  return { worktree, branch }
}

function writeRigs(rigs: { name: string; repo: string }[]) {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify(rigs.map(r => ({ name: r.name, repo: r.repo, factory: 'ship' }))),
  )
}

const reset = () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
}

const DAY = 24 * 3_600_000
const OLD = Date.now() - 2 * 3_600_000 // finished 2h ago: past WORKTREE_MIN_AGE_MS (1h)

test('a: --dry-run lists what it would remove and changes nothing', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  const before = git(repo, 'worktree', 'list', '--porcelain')
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees', '--dry-run'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(out.out).toContain(`remove worktree ${worktree}`)
  expect(out.out).toContain(`remove branch factory/${id}`)
  expect(existsSync(worktree)).toBe(true)
  expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(before)
  expect(existsSync(join(home, 'gc-worktrees.jsonl'))).toBe(false)
})

test('b: a live pass removes the finished clean worktree, deletes the merged branch, and leaves a live run alone', () => {
  reset()
  const { repo, origin } = makeRig('r1')
  const doneId = freshId('done')
  const liveId = freshId('live')
  const { worktree: doneWt, branch: doneBranch } = writeRun(repo, doneId, {
    outcome: 'done',
    finishedAt: OLD,
    merged: true,
  })
  const { worktree: liveWt } = writeRun(repo, liveId, { outcome: 'working' })
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(out.out).toMatch(/reclaimed: 1 worktrees, 1 local \+ 1 remote branches, [\d.]+ [KMG]?B/)
  expect(existsSync(doneWt)).toBe(false)
  expect(existsSync(liveWt)).toBe(true) // the live run's worktree is untouched
  expect(git(repo, 'branch', '--list', doneBranch)).toBe('')
  expect(git(origin, 'branch', '--list', doneBranch)).toBe('')
  const lines = readFileSync(join(home, 'gc-worktrees.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  expect(lines.some(l => l.type === 'worktree' && l.run === doneId)).toBe(true)
  expect(lines.some(l => l.type === 'branch' && l.run === doneId)).toBe(true)
  expect(lines.some(l => l.type === 'remote' && l.run === doneId)).toBe(true)
  expect(lines.at(-1).type).toBe('pass')
  expect(lines.at(-1).errors).toBe(0)
})

test("c: an unmerged branch's worktree is removed, but the branch itself stays", () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: false })
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(existsSync(worktree)).toBe(false)
  expect(git(repo, 'branch', '--list', branch)).not.toBe('')
})

test('d: a dirty worktree is snapshotted to refs/factory-gc/<id> before it is removed', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: false })
  writeFileSync(join(worktree, 'scratch.txt'), 'uncommitted work')
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(existsSync(worktree)).toBe(false)
  const sha = git(repo, 'rev-parse', `refs/factory-gc/${id}`)
  expect(sha).not.toBe('')
  const files = git(repo, 'show', '--name-only', '--format=', sha)
  expect(files.split('\n')).toContain('scratch.txt')
})

test('T-a: the snapshot index lives in a private per-run dir, not the shared tmpdir (claude-factory-ulv)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: false })
  writeFileSync(join(worktree, 'scratch.txt'), 'uncommitted work')
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const logFile = join(dir, 'git-index.log')
  spyGitIndex(logFile)
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  const lines = readFileSync(logFile, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(1) // exactly one `add -A` during the snapshot
  const [indexFile, mode] = lines[0]!.split(' ')
  const indexDir = dirname(indexFile!)
  const tmp = realpathSync(tmpdir())
  expect(indexDir).not.toBe(tmpdir())
  expect(indexDir).not.toBe(tmp)
  // the first 10 chars are the owner-only mode bits; macOS appends an extra `@`/`+` flag after them
  expect(mode!.slice(0, 10)).toBe('drwx------')
  expect(existsSync(indexDir)).toBe(false) // removed in snapshotWorktree's finally
  expect(git(repo, 'rev-parse', `refs/factory-gc/${id}`)).not.toBe('')
})

test('e: gh exits 1: no branch is deleted, worktrees are still removed', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  failGh()
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(existsSync(worktree)).toBe(false)
  expect(git(repo, 'branch', '--list', branch)).not.toBe('')
})

test('f: herdr fails: no worktree is removed', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  mkdirSync(bin, { recursive: true })
  const badHerdr = join(bin, 'bad-herdr')
  writeFileSync(badHerdr, '#!/bin/sh\nexit 1\n')
  chmodSync(badHerdr, 0o755)
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: badHerdr })
  expect(out.code).toBe(0)
  expect(existsSync(worktree)).toBe(true)
})

test('g: a second pass while gc-worktrees.lock is held deletes nothing and exits 0', () => {
  reset()
  mkdirSync(join(home, 'gc-worktrees.lock'), { recursive: true })
  writeFileSync(join(home, 'gc-worktrees.lock', 'pid'), String(process.pid)) // this test process: "alive"
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(out.out).toContain('already running')
  expect(existsSync(worktree)).toBe(true)
})

test('j: git worktree remove failing keeps the worktree and its branch, and journals an error (claude-factory-l38.6)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const wtParent = join(dir, 'wt')
  chmodSync(wtParent, 0o555) // no write: git can't unlink the worktree's entries inside it
  try {
    const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
    expect(out.code).toBe(0)
    expect(out.out).toContain('reclaimed: 0 worktrees')
    expect(out.out).toContain('1 errors') // the report line must show the error count too (claude-factory-l38.17)
    expect(existsSync(worktree)).toBe(true) // removal failed: the worktree stays
    expect(git(repo, 'branch', '--list', branch)).not.toBe('') // the branch is never deleted for a failed worktree
    const lines = readFileSync(join(home, 'gc-worktrees.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
    expect(lines.some(l => l.type === 'error' && l.run === id)).toBe(true)
    expect(lines.at(-1).errors).toBe(1)
  } finally {
    chmodSync(wtParent, 0o755) // restore before afterEach's recursive rm
  }
})

test('k: a worktree whose git status fails is kept whole, never removed (claude-factory-l38.7)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeFileSync(join(worktree, '.git'), 'gitdir: /nonexistent-xyz\n') // breaks `git status` in this worktree
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(out.out).toContain(`keep worktree ${worktree} (run ${id}, reason: dirty-unknown)`)
  expect(out.out).toContain('reclaimed: 0 worktrees')
  expect(existsSync(worktree)).toBe(true)
  expect(git(repo, 'branch', '--list', branch)).not.toBe('')
})

test('l: a failed git add -A during the snapshot keeps the worktree, commits no empty tree (claude-factory-l38.8)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: false })
  const scratch = join(worktree, 'scratch.txt')
  writeFileSync(scratch, 'uncommitted work') // dirty-small: a snapshot is attempted
  // GIT_INDEX_FILE's path never gets created when `git add -A` fails this way: a naive `write-tree`
  // right after then reads as an empty index and succeeds with the well-known empty-tree sha, exit
  // 0, masking the add failure entirely (claude-factory-l38.8's "partial snapshot" risk)
  chmodSync(scratch, 0o000)
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  try {
    const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
    expect(out.code).toBe(0)
    expect(out.out).toContain('reclaimed: 0 worktrees')
    expect(existsSync(worktree)).toBe(true) // never force-removed on a failed snapshot
    expect(git(repo, 'branch', '--list', branch)).not.toBe('')
    expect(git(repo, 'for-each-ref', `refs/factory-gc/${id}`)).toBe('') // no bogus ref written
    const lines = readFileSync(join(home, 'gc-worktrees.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
    expect(lines.some(l => l.type === 'error' && l.run === id)).toBe(true)
    expect(lines.some(l => l.type === 'snapshot')).toBe(false)
  } finally {
    if (existsSync(scratch)) chmodSync(scratch, 0o644)
  }
})

test('m: a clean detached-HEAD worktree with a commit on no ref is snapshotted, not wiped bare (claude-factory-l38.9)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const worktree = join(dir, 'wt', id)
  mkdirSync(join(dir, 'wt'), { recursive: true })
  git(repo, 'worktree', 'add', '-q', '--detach', worktree, 'main')
  writeFileSync(join(worktree, 'unreachable.txt'), 'orphan commit')
  git(worktree, 'add', 'unreachable.txt')
  git(worktree, 'commit', '-q', '-m', 'commit on no ref')
  const orphanSha = git(worktree, 'rev-parse', 'HEAD') // reachable from no branch, remote or tag
  const d = runDir(id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo,
      goal: 'g',
      ws: `ws-${id}`,
      worktree,
      branch: `factory/${id}`,
    }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 's', at: OLD })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(existsSync(worktree)).toBe(false) // a finished run's worktree is still removed
  const refSha = git(repo, 'rev-parse', `refs/factory-gc/${id}`)
  expect(refSha).not.toBe('')
  expect(() => git(repo, 'merge-base', '--is-ancestor', orphanSha, refSha)).not.toThrow() // the orphan survives
})

test('n: a run whose run.json is unreadable counts as live, never folded into a shorter finished id (claude-factory-l38.10)', () => {
  reset()
  const { repo } = makeRig('r1')
  writeRun(repo, 'r1', { outcome: 'done', finishedAt: OLD, merged: true })
  const { worktree: forkWt, branch: forkBranch } = writeRun(repo, 'r1-2', { outcome: 'working' })
  writeFileSync(join(runDir('r1-2'), 'run.json'), '{not json') // corrupt: loadRun throws for this run
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(existsSync(forkWt)).toBe(true) // never folded into the finished parent r1 and removed
  expect(git(repo, 'branch', '--list', forkBranch)).not.toBe('')
})

test("o: a factory/* branch checked out in the rig's own main checkout is never deleted (claude-factory-l38.11)", () => {
  reset()
  const { repo, origin } = makeRig('r1')
  const id = freshId('ship')
  const branch = `factory/${id}`
  git(repo, 'checkout', '-q', '-b', branch, 'main') // the main checkout itself sits on this branch
  git(repo, 'push', '-q', 'origin', `${branch}:${branch}`) // same tip as main: trivially an ancestor
  const d = runDir(id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo,
      goal: 'g',
      ws: `ws-${id}`,
      worktree: join(dir, 'wt', id), // never created: this run has no separate worktree
      branch,
    }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 's', at: OLD })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(git(repo, 'branch', '--list', branch)).not.toBe('') // still a local branch
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch) // still checked out, untouched
  expect(git(origin, 'branch', '--list', branch)).not.toBe('')
})

test('h: 2 live runs among finished ones leaves 2 owned worktrees after a pass (AC11)', () => {
  reset()
  const { repo } = makeRig('r1')
  const live1 = writeRun(repo, freshId('live1'), { outcome: 'working' })
  const live2 = writeRun(repo, freshId('live2'), { outcome: 'working' })
  for (let i = 0; i < 4; i++)
    writeRun(repo, freshId(`done${i}`), { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  const left = git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter(l => l.startsWith('worktree '))
    .map(l => l.slice('worktree '.length))
  expect(left.sort()).toEqual([repo, live1.worktree, live2.worktree].sort())
})

test('a CLOSED PR with the bead closed deletes the branch; bead open keeps it', () => {
  reset()
  const { repo } = makeRig('r1')
  const closedId = freshId('closed')
  const openId = freshId('open')
  writeRun(repo, closedId, { outcome: 'done', finishedAt: OLD, bead: 'acme-1' })
  writeRun(repo, openId, { outcome: 'done', finishedAt: OLD, bead: 'acme-2' })
  const closedHead = git(repo, 'rev-parse', `factory/${closedId}`)
  const openHead = git(repo, 'rev-parse', `factory/${openId}`)
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([
    {
      number: 1,
      state: 'CLOSED',
      headRefName: `factory/${closedId}`,
      headRefOid: closedHead,
      isCrossRepository: false,
    },
    {
      number: 2,
      state: 'CLOSED',
      headRefName: `factory/${openId}`,
      headRefOid: openHead,
      isCrossRepository: false,
    },
  ])
  const { closeBead } = fakeBd()
  closeBead('acme-1')
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(git(repo, 'branch', '--list', `factory/${closedId}`)).toBe('')
  expect(git(repo, 'branch', '--list', `factory/${openId}`)).not.toBe('')
})

test('a cross-repo CLOSED PR with a closed bead never covers the tip, and gh is asked for isCrossRepository (claude-factory-ulv)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('fork')
  writeRun(repo, id, { outcome: 'done', finishedAt: OLD, bead: 'acme-1' })
  const head = git(repo, 'rev-parse', `factory/${id}`)
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([
    { number: 1, state: 'CLOSED', headRefName: `factory/${id}`, headRefOid: head, isCrossRepository: true },
  ])
  const { closeBead } = fakeBd()
  closeBead('acme-1')
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(git(repo, 'branch', '--list', `factory/${id}`)).not.toBe('')
  const calls = readFileSync(join(dir, 'gh-calls.log'), 'utf8')
  expect(calls).toContain('isCrossRepository')
  // beadClosedFacts must drop the fork PR before it ever looks at a bead (AC5): no `bd show acme-1`
  const bdCalls = existsSync(join(dir, 'bd-calls.log')) ? readFileSync(join(dir, 'bd-calls.log'), 'utf8') : ''
  expect(bdCalls).not.toContain('acme-1')
})

test('a PR answer missing isCrossRepository fails closed: the branch is kept, reason facts-unavailable (claude-factory-ulv)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  const head = git(repo, 'rev-parse', `factory/${id}`)
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  // no isCrossRepository key at all: an older `gh`, or a malformed answer
  fakeGh([{ number: 1, state: 'MERGED', headRefName: `factory/${id}`, headRefOid: head }])
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(git(repo, 'branch', '--list', `factory/${id}`)).not.toBe('')
})

// claude-factory-0u0 AC4: a host must not read as GitHub only because it ends in "github.com"
// (mygithub.com). Before this fix, githubSlug read the mygithub.com/acme/widget origin as
// GitHub's acme/widget. gc then called `gh pr list` for that unrelated repo, and used its CLOSED
// PR state here. This deleted a branch that this rig had not merged.
test('AC4: a mygithub.com origin never calls gh pr list, and a CLOSED-PR branch stays', () => {
  reset()
  const { repo } = makeRig('r1', 'https://mygithub.com/acme/widget.git')
  const id = freshId('closed')
  writeRun(repo, id, { outcome: 'done', finishedAt: OLD, bead: 'acme-1' })
  const head = git(repo, 'rev-parse', `factory/${id}`)
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([{ number: 1, state: 'CLOSED', headRefName: `factory/${id}`, headRefOid: head }])
  const { closeBead } = fakeBd()
  closeBead('acme-1')
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(git(repo, 'branch', '--list', `factory/${id}`)).not.toBe('') // stays: no PR facts for this host
  const log = join(dir, 'gh-calls.log')
  if (existsSync(log)) expect(readFileSync(log, 'utf8')).not.toContain('pr list')
})

/** a fake herdr that answers `tab create` and `pane run` the way a real worker launch needs
 * (same shape as src/gc-cli.test.ts's okHerdr, which proves the sibling prompts/ revival). */
function okHerdr(path: string) {
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "tab create") printf \'{"result":{"root_pane":{"pane_id":"p1"}}}\\n\' ;;',
      '  "pane run") exit 0 ;;',
      "  *) echo '{}' ;;",
      'esac',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
}

test('i: goto after gc recreates the removed worktree at the same path and starts a worker (AC12)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: false })
  writeRigs([{ name: 'r1', repo }])
  fakeGh([])
  expect(factory(['gc', '--worktrees'], { FACTORY_HERDR: noPanes() }).code).toBe(0)
  expect(existsSync(worktree)).toBe(false) // gc removed the worktree
  expect(git(repo, 'branch', '--list', branch)).not.toBe('') // unmerged: the branch stays

  expect(factory(['goto', id, 'implement']).code).toBe(0) // queues a GOTO; the next tick drains it
  const herdr = join(bin, 'ok-herdr-revive')
  okHerdr(herdr)
  const out = factory(['tick'], {
    FACTORY_HERDR: herdr,
    // no .claude.json at this path: isTrusted() hits its catch branch and reads as trusted
    CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config'),
    // tick's own finally block would otherwise kick a detached `factory gc` at this FACTORY_HOME
    FACTORY_GC: '0',
  })
  expect(out.code).toBe(0)
  const row = JSON.parse(out.out).runs.find((r: { id: string }) => r.id === id)
  expect(row.error).toBeFalsy()
  expect(row.pane).toBe('p1')
  expect(existsSync(worktree)).toBe(true) // recreated at the same path, from the surviving branch
  expect(readFileSync(join(worktree, `${id}.txt`), 'utf8')).toBe(id) // the branch's own commit
})

test('i: goto after gc refuses when the branch is also gone, and starts no worker (AC12)', () => {
  reset()
  const { repo, origin } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  fakeGh([])
  expect(factory(['gc', '--worktrees'], { FACTORY_HERDR: noPanes() }).code).toBe(0)
  expect(existsSync(worktree)).toBe(false)
  expect(git(repo, 'branch', '--list', branch)).toBe('') // merged: gc deleted the branch too
  expect(git(origin, 'branch', '--list', branch)).toBe('')

  expect(factory(['goto', id, 'implement']).code).toBe(0)
  const out = factory(['tick'], {
    FACTORY_HERDR: noPanes(),
    CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config'),
    FACTORY_GC: '0',
  })
  expect(out.code).toBe(0)
  const row = JSON.parse(out.out).runs.find((r: { id: string }) => r.id === id)
  expect(row.error).toContain('gc')
  expect(row.error).toContain(branch)
  expect(row.error).toContain(`refs/factory-gc/${id}`)
  expect(row.pane).toBeFalsy()
  expect(existsSync(worktree)).toBe(false) // still not recreated: there is nothing to recreate it from
})

test('p: --dry-run never fetches, so refs/remotes/origin stay exactly as before (claude-factory-l38.15)', () => {
  reset()
  const { repo, origin } = makeRig('r1')
  const id = freshId('ship')
  writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  // a second clone pushes a new branch straight to origin, behind what `repo` last fetched
  const other = join(dir, 'other')
  git(dir, 'clone', '--quiet', origin, other)
  git(other, 'checkout', '-q', '-b', 'factory/ghost')
  writeFileSync(join(other, 'ghost.txt'), 'x')
  git(other, 'add', 'ghost.txt')
  git(other, 'commit', '-q', '-m', 'ghost')
  git(other, 'push', '-q', 'origin', 'factory/ghost')
  const before = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)')
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees', '--dry-run'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(before)
  expect(git(repo, 'for-each-ref', 'refs/remotes/origin/factory/ghost')).toBe('') // never fetched
})

test('q: an unknown --rig name fails, naming the known rigs, and never holds the lock (claude-factory-l38.16)', () => {
  reset()
  const { repo } = makeRig('r1')
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  fakeGh([])
  const out = factory(['gc', '--worktrees', '--rig', 'nope'], { FACTORY_HERDR: herdr })
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('nope')
  expect(out.err).toContain('r1')
  expect(existsSync(join(home, 'gc-worktrees.lock'))).toBe(false)
})

test('r: gh api graphql reads every PR of the origin repo in one call, past the old 1000-PR cap (claude-factory-ph8)', () => {
  reset()
  const { repo } = makeRig('r1')
  const mergedId = freshId('ship')
  const openId = freshId('open')
  const { branch: mergedBranch } = writeRun(repo, mergedId, {
    outcome: 'done',
    finishedAt: OLD,
    merged: false,
  })
  const { branch: openBranch } = writeRun(repo, openId, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  const mergedHead = git(repo, 'rev-parse', mergedBranch)
  // There are 1050 PRs, in 11 pages of up to 100 each. The MERGED PR that kills the branch and
  // the OPEN PR that saves the branch both sit past index 1000. The old `gh pr list --limit
  // 1000` call was blind past that index.
  const prs = Array.from({ length: 1050 }, (_, i) => ({
    number: i,
    state: i === 1005 ? 'MERGED' : i === 1010 ? 'OPEN' : 'CLOSED',
    headRefName: i === 1005 ? mergedBranch : i === 1010 ? openBranch : `factory/other-${i}`,
    headRefOid: i === 1005 ? mergedHead : '0'.repeat(40),
    isCrossRepository: false,
  }))
  fakeGh(prs)
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  const calls = readFileSync(join(dir, 'gh-calls.log'), 'utf8').trim().split('\n')
  expect(calls.length).toBe(1)
  // the call must read the whole origin repo with --paginate and -f (never -F: claude-factory-ph8.5,
  // `-F` would read a repo named, for example, "2048" as a JSON number and break the GraphQL query forever)
  expect(calls[0]).toContain('--paginate')
  expect(calls[0]).toContain('-f owner=acme')
  expect(calls[0]).toContain('-f name=widget')
  // a MERGED PR past index 1000, head matching the branch tip: covered, so gc deletes the branch
  expect(git(repo, 'branch', '--list', mergedBranch)).toBe('')
  // a merged-ancestor branch with an OPEN PR past index 1000 on the same name: gc keeps it anyway
  expect(git(repo, 'branch', '--list', openBranch)).not.toBe('')
})

test('u: a page that reports fewer nodes than totalCount keeps every branch facts-unavailable (AC4)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  const herdr = noPanes()
  // the page's own node count (1) is less than its claimed totalCount (2): parsePrPages() must
  // return null rather than trust a partial page (AC4), so gc deletes no branch on this rig
  fakeGh(
    [
      {
        number: 1,
        state: 'CLOSED',
        headRefName: 'factory/other',
        headRefOid: '0'.repeat(40),
        isCrossRepository: false,
      },
    ],
    { totalCount: 2 },
  )
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(git(repo, 'branch', '--list', branch)).not.toBe('')
})

test('t: goto after gc says the fetch failed, not that gc did this, when origin is unreachable (claude-factory-l38.18)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  fakeGh([])
  expect(factory(['gc', '--worktrees'], { FACTORY_HERDR: noPanes() }).code).toBe(0)
  expect(existsSync(worktree)).toBe(false)
  expect(git(repo, 'branch', '--list', branch)).toBe('') // merged: gc deleted the branch too

  // break the remote so a revive's fetch fails outright, instead of succeeding and finding no branch
  git(repo, 'remote', 'set-url', 'origin', 'file:///nonexistent-xyz-gc-test')

  expect(factory(['goto', id, 'implement']).code).toBe(0)
  const out = factory(['tick'], {
    FACTORY_HERDR: noPanes(),
    CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config'),
    FACTORY_GC: '0',
  })
  expect(out.code).toBe(0)
  const row = JSON.parse(out.out).runs.find((r: { id: string }) => r.id === id)
  expect(row.error).toContain('fetch')
  expect(row.error).not.toContain('factory gc --worktrees removed')
  expect(row.pane).toBeFalsy()
})

test('s: deleteBranchCas refuses a local ref and a remote ref that both moved since the read (claude-factory-l38.14, AC7)', () => {
  reset()
  const { repo, origin } = makeRig('r1')
  const branch = 'factory/cas-test'
  git(repo, 'branch', branch, 'main')
  const oldSha = git(repo, 'rev-parse', branch)
  git(repo, 'push', '-q', 'origin', `${branch}:${branch}`)
  const wt2 = join(dir, 'wt2')
  git(repo, 'worktree', 'add', '-q', wt2, '-b', 'tmp2', 'main')
  writeFileSync(join(wt2, 'extra.txt'), 'x')
  git(wt2, 'add', 'extra.txt')
  git(wt2, 'commit', '-q', '-m', 'extra')
  const newSha = git(wt2, 'rev-parse', 'HEAD')
  git(repo, 'worktree', 'remove', wt2)
  git(repo, 'update-ref', `refs/heads/${branch}`, newSha)
  git(repo, 'push', '-q', '-f', 'origin', `${newSha}:refs/heads/${branch}`)
  const { localOk, remoteOk } = deleteBranchCas(repo, branch, oldSha, oldSha)
  expect(localOk).toBe(false)
  expect(remoteOk).toBe(false)
  expect(git(repo, 'branch', '--list', branch)).not.toBe('')
  expect(git(origin, 'branch', '--list', branch)).not.toBe('')
})

test("u: branchFacts' fetch and ls-remote, and deleteBranchCas' push, run with GIT_TERMINAL_PROMPT=0 (claude-factory-l38.12)", () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  fakeGh([])
  const logFile = join(dir, 'git-calls.log')
  spyGit(logFile)
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: noPanes(), GIT_TERMINAL_PROMPT: '1' })
  expect(out.code).toBe(0)
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
  expect(lines.find(l => l.includes(' fetch '))).toContain('GIT_TERMINAL_PROMPT=0')
  expect(lines.find(l => l.includes(' ls-remote '))).toContain('GIT_TERMINAL_PROMPT=0')
  expect(lines.find(l => l.includes(' push '))).toContain('GIT_TERMINAL_PROMPT=0')
})

test("x: reviveWorktree's ls-remote and fetch run with GIT_TERMINAL_PROMPT=0 (claude-factory-0lt.3, T3)", () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { branch } = writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  fakeGh([])
  expect(factory(['gc', '--worktrees'], { FACTORY_HERDR: noPanes() }).code).toBe(0)
  expect(git(repo, 'branch', '--list', branch)).toBe('') // merged: gc deleted it; revive must fetch

  expect(factory(['goto', id, 'implement']).code).toBe(0)
  const logFile = join(dir, 'git-calls.log')
  spyGit(logFile) // origin stays reachable: unlike test t, this run exercises fetch too, not just ls-remote
  const out = factory(['tick'], {
    FACTORY_HERDR: noPanes(),
    CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config'),
    FACTORY_GC: '0',
    GIT_TERMINAL_PROMPT: '1',
  })
  expect(out.code).toBe(0)
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
  expect(lines.find(l => l.includes(' ls-remote '))).toContain('GIT_TERMINAL_PROMPT=0')
  expect(lines.find(l => l.includes(' fetch '))).toContain('GIT_TERMINAL_PROMPT=0')
})

test('v: a failing push scrubs URL userinfo from the journaled error (claude-factory-0lt.2, T2)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  fakeGh([])
  failGit(
    'push',
    null,
    'fatal: unable to access https://e2e-user:e2e-tok3n@github.com/acme/widget.git/: e2e',
    128,
  )
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: noPanes() })
  expect(out.code).toBe(0)
  const text = readFileSync(join(home, 'gc-worktrees.jsonl'), 'utf8')
  expect(text).not.toContain('e2e-tok3n')
  expect(text).not.toContain('e2e-user')
  const lines = text
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  const errLine = lines.find(l => l.type === 'error' && l.run === id)
  expect(errLine).toBeDefined()
  expect(errLine.reason).toContain('https://github.com/acme/widget.git')
})

test('w: a failing "git worktree remove" scrubs URL userinfo from the journaled error (claude-factory-0lt.2, T2b)', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  writeRun(repo, id, { outcome: 'done', finishedAt: OLD, merged: true })
  writeRigs([{ name: 'r1', repo }])
  fakeGh([])
  failGit(
    'worktree',
    'remove',
    'error: unable to unlink file: see https://e2e-user:e2e-tok3n@github.com/acme/widget.git for help',
    1,
  )
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: noPanes() })
  expect(out.code).toBe(0)
  const text = readFileSync(join(home, 'gc-worktrees.jsonl'), 'utf8')
  expect(text).not.toContain('e2e-tok3n')
  expect(text).not.toContain('e2e-user')
  const lines = text
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  const errLine = lines.find(l => l.type === 'error' && l.run === id)
  expect(errLine).toBeDefined()
  expect(errLine.reason).toContain('https://github.com/acme/widget.git')
})

// --- claude-factory-192.12: a laptop-made run in the AX manager (FACTORY_IN_AX=1) ---

/** the AX manager's view of a run the laptop made: the laptop's repo is gone, the rig's clone is under
 * FACTORY_REPOS, and the worktree is not there. A fake kubectl says the AX controller is ready, so a tick
 * reaches spawn(); FACTORY_AX_IMAGE stays unset, so launchTask stops there with a message that names it. */
function axVm(name: string, origin: string) {
  const repos = join(dir, 'vm-repos')
  mkdirSync(repos, { recursive: true })
  git(dir, 'clone', '--quiet', origin, join(repos, name))
  const kubectl = join(bin, 'kubectl-ready')
  mkdirSync(bin, { recursive: true })
  const ready = JSON.stringify({
    metadata: { generation: 1 },
    spec: { replicas: 1 },
    status: { observedGeneration: 1, readyReplicas: 1, availableReplicas: 1 },
  })
  writeFileSync(kubectl, `#!/bin/sh\nprintf '%s' '${ready}'\n`)
  chmodSync(kubectl, 0o755)
  return {
    vmRepo: join(repos, name),
    env: {
      FACTORY_IN_AX: '1',
      FACTORY_REPOS: repos,
      FACTORY_KUBECTL: kubectl,
      FACTORY_HERDR: noPanes(),
      FACTORY_GC: '0',
      CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config'),
    },
  }
}
const readRaw = (id: string) => JSON.parse(readFileSync(join(runDir(id), 'run.json'), 'utf8'))
const patchRaw = (id: string, patch: Record<string, unknown>) =>
  writeFileSync(join(runDir(id), 'run.json'), JSON.stringify({ ...readRaw(id), ...patch }))
const BOGUS = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const rowOf = (out: { out: string }, id: string) =>
  JSON.parse(out.out).runs.find((r: { id: string }) => r.id === id)

/** a run as the laptop wrote it, moved to the AX manager: the laptop's worktree is not in the VM */
function laptopRun(opts: { merged: boolean; base?: string; gone?: boolean }) {
  reset()
  const { repo, origin } = makeRig('r1')
  const id = freshId('ship')
  const { worktree, branch } = writeRun(repo, id, { outcome: 'working', merged: opts.merged })
  const mainSha = git(repo, 'rev-parse', 'main')
  writeRigs([{ name: 'r1', repo }])
  if (opts.base) patchRaw(id, { base: opts.base })
  git(repo, 'worktree', 'remove', '--force', worktree)
  if (opts.gone) {
    git(origin, 'branch', '-D', branch) // gc'd after the merge: gone from origin and the laptop, before the VM clones
    git(repo, 'branch', '-D', branch)
  }
  return { repo, origin, id, branch, mainSha, laptopWorktree: worktree, vm: axVm('r1', origin) }
}

test('AX-a: spawn of a laptop run with no worktree makes it from origin/<branch> before brief() and keeps a valid base', () => {
  const t = laptopRun({ merged: false })
  const base = t.mainSha
  patchRaw(t.id, { base })
  const out = factory(['tick'], t.vm.env)
  expect(out.code).toBe(0)
  const row = rowOf(out, t.id)
  const vmWorktree = join(home, 'worktrees', t.id)
  expect(existsSync(vmWorktree)).toBe(true)
  expect(readFileSync(join(vmWorktree, `${t.id}.txt`), 'utf8')).toBe(t.id)
  expect(row.error).not.toContain('cannot change to')
  expect(row.error).not.toContain('Invalid revision range')
  expect(row.error).toContain('FACTORY_AX_IMAGE') // brief() ran; launchTask is the next step
  expect(readRaw(t.id).base).toBe(base) // a valid base stays
})

test('AX-b: a gone branch of a merged laptop run is made from origin/<default>, and a base the VM lacks is reset in run.json only', () => {
  const t = laptopRun({ merged: true, base: BOGUS, gone: true })
  writeFileSync(join(runDir(t.id), 'merged-before-move'), '') // migrate-to-ax wrote the proof
  const before = readRaw(t.id)
  const out = factory(['tick'], t.vm.env)
  expect(out.code).toBe(0)
  const row = rowOf(out, t.id)
  const vmWorktree = join(home, 'worktrees', t.id)
  expect(row.error).not.toContain('cannot change to')
  expect(row.error).not.toContain('Invalid revision range')
  expect(row.error).toContain('FACTORY_AX_IMAGE')
  expect(git(vmWorktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(t.branch)
  expect(git(vmWorktree, 'rev-parse', 'HEAD')).toBe(git(t.vm.vmRepo, 'rev-parse', 'origin/main'))
  const after = readRaw(t.id)
  expect(after.base).toBe(git(vmWorktree, 'rev-parse', 'HEAD'))
  expect({ ...after, base: undefined }).toEqual({ ...before, base: undefined }) // no mapped path written
  expect(out.err).toContain(t.id) // the recreate and the base reset are logged
})

test('AX-c: a run with gc.json and no branch still fails with the gc message, and never falls back to origin/<default>', () => {
  const t = laptopRun({ merged: true, gone: true })
  writeFileSync(join(runDir(t.id), 'gc.json'), '{}')
  const out = factory(['tick'], t.vm.env)
  expect(out.code).toBe(0)
  const row = rowOf(out, t.id)
  expect(row.error).toContain('gc')
  expect(row.error).toContain(t.branch)
  expect(existsSync(join(home, 'worktrees', t.id))).toBe(false)
})

test('AX-d: a laptop run with no merge marker and a gone branch fails naming the branch, and makes no worktree', () => {
  const t = laptopRun({ merged: false, gone: true })
  const out = factory(['tick'], t.vm.env)
  expect(out.code).toBe(0)
  const row = rowOf(out, t.id)
  expect(row.error).toContain(t.branch)
  expect(row.error).not.toContain('FACTORY_AX_IMAGE')
  expect(existsSync(join(home, 'worktrees', t.id))).toBe(false)
})

test('AX-e: a base the VM lacks resets to the fork point of a run with commits on a live origin branch, not to HEAD', () => {
  const t = laptopRun({ merged: false, base: BOGUS })
  const out = factory(['tick'], t.vm.env)
  expect(out.code).toBe(0)
  const vmWorktree = join(home, 'worktrees', t.id)
  expect(readRaw(t.id).base).toBe(t.mainSha)
  expect(git(vmWorktree, 'rev-parse', 'HEAD')).not.toBe(t.mainSha)
})

// --- migrate-to-ax --dry-run: the git checks (claude-factory-192.12.4) ---

test('MIG-a: a live run with an unpushed commit stops migrate-to-ax', () => {
  reset()
  const { repo } = makeRig('r1')
  const id = freshId('ship')
  const { worktree } = writeRun(repo, id, { outcome: 'working' })
  writeRigs([{ name: 'r1', repo }])
  writeFileSync(join(worktree, 'more.txt'), 'm')
  git(worktree, 'add', 'more.txt')
  git(worktree, 'commit', '-q', '-m', 'unpushed')
  const out = factory(['migrate-to-ax', '--dry-run'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('not on origin')
  expect(out.err).toContain(id)
})

test('MIG-b: a branch deleted upstream with a stale local origin ref stops migrate-to-ax', () => {
  reset()
  const { repo, origin } = makeRig('r1')
  const id = freshId('ship')
  const { branch } = writeRun(repo, id, { outcome: 'working' })
  writeRigs([{ name: 'r1', repo }])
  git(repo, 'config', 'fetch.prune', 'false') // a global fetch.prune would hide a missing --prune
  git(repo, 'fetch', '--quiet', 'origin') // the stale ref origin/<branch> exists here
  git(origin, 'branch', '-D', branch)
  const out = factory(['migrate-to-ax', '--dry-run'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('not on origin')
})

test('MIG-c: a failed fetch stops migrate-to-ax and names the repo', () => {
  reset()
  const { repo, origin } = makeRig('r1')
  const id = freshId('ship')
  writeRun(repo, id, { outcome: 'working' })
  writeRigs([{ name: 'r1', repo }])
  renameSync(origin, `${origin}.moved`)
  const out = factory(['migrate-to-ax', '--dry-run'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('could not fetch origin')
  expect(out.err).toContain(repo)
})

// --- migrate-to-ax: the merged-before-move marker (claude-factory-192.12.8) ---

/** a live run whose head is on origin/main and whose origin branch is gone */
function mergedGoneRun() {
  reset()
  const { repo, origin } = makeRig('r1')
  const id = freshId('ship')
  const { branch } = writeRun(repo, id, { outcome: 'working', merged: true })
  writeRigs([{ name: 'r1', repo }])
  git(origin, 'branch', '-D', branch)
  return { id, repo, marker: join(runDir(id), 'merged-before-move') }
}
const fakeAxNotFound = () => {
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'ax-notfound')
  writeFileSync(path, '#!/bin/sh\necho "task not found" >&2\nexit 1\n')
  chmodSync(path, 0o755)
  return { FACTORY_AX: path }
}

test('MIG-d: --dry-run names the recreate and writes no marker', () => {
  const t = mergedGoneRun()
  const out = factory(['migrate-to-ax', '--dry-run'])
  expect(out.code).toBe(0)
  expect(out.out).toContain(t.id)
  expect(existsSync(t.marker)).toBe(false)
})

test('MIG-e: a real migrate writes the marker before the manager-task check stops it', () => {
  const t = mergedGoneRun()
  const out = factory(['migrate-to-ax'], fakeAxNotFound())
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('not there')
  expect(existsSync(t.marker)).toBe(true)
})

test('MIG-f: a refused migrate writes no marker', () => {
  const t = mergedGoneRun()
  const other = freshId('ship')
  const { worktree } = writeRun(t.repo, other, { outcome: 'working' })
  writeFileSync(join(worktree, 'more.txt'), 'm')
  git(worktree, 'add', 'more.txt')
  git(worktree, 'commit', '-q', '-m', 'unpushed')
  const out = factory(['migrate-to-ax'], fakeAxNotFound())
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('not on origin')
  expect(existsSync(t.marker)).toBe(false)
})
