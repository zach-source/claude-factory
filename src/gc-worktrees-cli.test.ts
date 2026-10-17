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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
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

/** a fake gh: `pr list --json ...` answers the given PRs; the call is logged for a count assertion */
function fakeGh(prs: { number: number; state: string; headRefName: string; headRefOid: string }[]) {
  mkdirSync(bin, { recursive: true })
  const body = JSON.stringify(prs).replaceAll("'", "'\\''")
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$*" >> ${join(dir, 'gh-calls.log')}\nif [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s' '${body}'; else exit 1; fi\n`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
}
const failGh = () => {
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'gh'), 0o755)
}

/** a fake bd: `show <id> --json` answers closed when a marker file for the id exists */
function fakeBd() {
  mkdirSync(bin, { recursive: true })
  const closedDir = join(dir, 'bd-closed')
  mkdirSync(closedDir, { recursive: true })
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `if [ "$1" = "show" ]; then`,
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

/** a bare "origin" and a clone the test treats as the rig's own repo, with `main` as the one commit
 * every branch starts from. The origin's URL reads as github.com (so cli.ts's forge check passes)
 * but `insteadOf` sends fetch/push to the real local bare repo. */
function makeRig(name: string) {
  const origin = join(dir, `${name}-origin.git`)
  const repo = join(dir, name)
  mkdirSync(origin, { recursive: true })
  git(dir, 'init', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '--quiet', origin, repo)
  writeFileSync(join(repo, 'README.md'), 'x')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/widget.git')
  git(repo, 'config', `url.file://${origin}.insteadOf`, 'https://github.com/acme/widget.git')
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
    { number: 1, state: 'CLOSED', headRefName: `factory/${closedId}`, headRefOid: closedHead },
    { number: 2, state: 'CLOSED', headRefName: `factory/${openId}`, headRefOid: openHead },
  ])
  const { closeBead } = fakeBd()
  closeBead('acme-1')
  const out = factory(['gc', '--worktrees'], { FACTORY_HERDR: herdr })
  expect(out.code).toBe(0)
  expect(git(repo, 'branch', '--list', `factory/${closedId}`)).toBe('')
  expect(git(repo, 'branch', '--list', `factory/${openId}`)).not.toBe('')
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
