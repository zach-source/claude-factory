// dispatch() must never use a `station:<name>` label from a Linear pull to pick a run's start
// station (claude-factory-b6c.27). `bd linear pull` copies every Linear label onto the bead it
// writes, with no filter. dispatch already honors `station:<name>` (beads.ts stationOf): it starts a
// run past the factory's own first stations. A Linear-side actor with write access to an issue can
// set `station:deploy` or `station:release` this way. The person later adds the `factory` label to
// work the bead. Without this fix, that run would skip triage, plan, implement, review and security.
//
// This test drives the real `dispatch()` through `factory beads`. It uses a fake `bd` and `herdr`,
// the same harness as start.test.ts. It does not stub stationOf directly.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `dispatch-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const claudeConfig = join(dir, 'claude-config')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${bin}:${laptop.PATH}`,
      CLAUDE_CONFIG_DIR: claudeConfig,
      FACTORY_SELF_UPDATE: '0',
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** fake bd: `ready` answers one bead carrying `station:deploy`, with or without a Linear
 * `external_ref`, depending on `extRef`. `children` is always empty (no bead here has one). Every
 * other call (claim, dolt remote list, sync) exits 0, so dispatch proceeds past them with no error. */
function fakeBd(extRef: string | undefined) {
  mkdirSync(bin, { recursive: true })
  const bead = JSON.stringify([
    {
      id: 'acme-1',
      title: 't',
      labels: ['factory', 'station:deploy'],
      ...(extRef && { external_ref: extRef }),
    },
  ])
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    `  ready) printf '%s' '${bead}';;`,
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

/** fake herdr: only `worktree create` answers, as start.test.ts's does */
function fakeHerdr() {
  const worktree = join(dir, 'worktree-stub')
  const script = [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${worktree}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'herdr'), script)
  chmodSync(join(bin, 'herdr'), 0o755)
}

function repo() {
  const r = join(dir, 'repo')
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  Bun.spawnSync([
    'git',
    '-C',
    r,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    'init',
  ])
  return r
}

function reset(extRef: string | undefined) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  const r = repo()
  fakeBd(extRef)
  fakeHerdr()
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
}

/** the new run's inbox: a GOTO line, if dispatch posted one */
function gotoOf(): { type: string; node: string }[] {
  const runsDir = join(home, 'runs')
  const id = readdirSync(runsDir)[0]!
  const inbox = join(runsDir, id, 'inbox.jsonl')
  if (!existsSync(inbox)) return [] // no GOTO: dispatch posted nothing to this run's inbox
  const lines = readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean)
  return lines.map(l => JSON.parse(l)).filter(e => e.type === 'GOTO')
}

test("dispatch never starts a run at a Linear-sourced bead's station:<name> label (claude-factory-b6c.27)", () => {
  reset('https://linear.app/acme/issue/STI-1')
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(gotoOf()).toEqual([]) // the run stays at the factory's own start station, not "deploy"
})

test('a station:<name> label a person wrote by hand (no Linear external_ref) still starts the run there', () => {
  reset(undefined)
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  const gotos = gotoOf()
  expect(gotos).toHaveLength(1)
  expect(gotos[0]!.node).toBe('deploy') // the control: proves dispatch really reaches stationOf here
})

// claude-factory-6as.2: dispatch's pre-check.
// A merged PR can already cite a ready bead.
// When it does, dispatch must reject the bead and must not start a run for it.
// A gh error must fail open: dispatch starts the run and logs the skip.
// This test uses its own harness, since the rig's repo needs a GitHub origin remote (originRef's
// gate). The harness adds a fake `gh` on PATH, next to the fake `bd`.
const pdir = join(tmpdir(), `dispatch-precheck-${process.pid}`)
const phome = join(pdir, 'home')
const pbin = join(pdir, 'bin')
const pClaudeConfig = join(pdir, 'claude-config')
const bdCallsLog = join(pdir, 'bd-calls.log')
const ghCallsLog = join(pdir, 'gh-calls.log')
const rejectedFlag = join(pdir, 'rejected.flag')

afterEach(() => rmSync(pdir, { recursive: true, force: true }))

function pfactory(args: string[], extraEnv: Record<string, string> = {}) {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: phome,
      PATH: `${pbin}:${laptop.PATH}`,
      CLAUDE_CONFIG_DIR: pClaudeConfig,
      FACTORY_SELF_UPDATE: '0',
      ...extraEnv,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const skipFlag = join(pdir, 'dispatch-skip.flag')

/** fake bd: `ready` answers one bead (`acme-1`, carrying `extra`), or `[]` once `rejected.flag` exists
 * (the real `bd reject` removes the `factory` label, which drops a bead out of `bd ready --label
 * factory` for good), or the same bead with `metadata.dispatch_skip` set once `update --set-metadata
 * dispatch_skip=<runId>` ran (claude-factory-6as.3's dedupe). `update ... --add-label rejected` writes
 * the rejected flag. Every call is logged. */
function fakePrecheckBd(extra: Record<string, unknown> = {}) {
  mkdirSync(pbin, { recursive: true })
  const bead = JSON.stringify([{ id: 'acme-1', title: 'fix it', labels: ['factory'], ...extra }])
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${bdCallsLog}"`,
    'case "$1" in',
    '  ready)',
    `    if [ -f "${rejectedFlag}" ]; then printf '%s' '[]'`,
    `    elif [ -f "${skipFlag}" ]; then skip=$(cat "${skipFlag}"); printf '%s' '[{"id":"acme-1","title":"fix it","labels":["factory"],"metadata":{"dispatch_skip":"'"$skip"'"}}]'`,
    `    else printf '%s' '${bead}'`,
    '    fi;;',
    "  children) printf '%s' '[]';;",
    '  update)',
    `    case " $* " in *" --add-label rejected "*) : > "${rejectedFlag}";; esac`,
    `    case "$*" in *dispatch_skip=*) echo "$*" | sed -n 's/.*dispatch_skip=\\([^ ]*\\).*/\\1/p' > "${skipFlag}";; esac`,
    '    exit 0;;',
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(pbin, 'bd'), script)
  chmodSync(join(pbin, 'bd'), 0o755)
}

/** fake gh: every call is logged; `$GH_FAIL` set makes it fail like a timeout or a rate limit; else it
 * answers `$GH_JSON` (a `gh pr list --json ...` shaped array, or `[]`) on stdout */
function fakeGh() {
  const script = [
    '#!/bin/sh',
    `echo "gh $*" >> "${ghCallsLog}"`,
    'if [ -n "$GH_FAIL" ]; then echo "gh: rate limited" >&2; exit 1; fi',
    'printf \'%s\' "$GH_JSON"',
  ].join('\n')
  writeFileSync(join(pbin, 'gh'), script)
  chmodSync(join(pbin, 'gh'), 0o755)
}

/** fake herdr: only `worktree create` answers, as `fakeHerdr` above does */
function fakePrecheckHerdr() {
  const worktree = join(pdir, 'worktree-stub')
  const script = [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${worktree}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ].join('\n')
  writeFileSync(join(pbin, 'herdr'), script)
  chmodSync(join(pbin, 'herdr'), 0o755)
}

/** a repo with a GitHub origin, so `originRef` reads this rig as GitHub (the pre-check's own gate) */
function precheckRepo() {
  const r = join(pdir, 'repo')
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  Bun.spawnSync(['git', '-C', r, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git'])
  Bun.spawnSync([
    'git',
    '-C',
    r,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    'init',
  ])
  return r
}

function precheckReset(extra: Record<string, unknown> = {}) {
  rmSync(pdir, { recursive: true, force: true })
  mkdirSync(pClaudeConfig, { recursive: true })
  writeFileSync(join(pClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(phome, { recursive: true })
  // labelPass() also calls gh, for an unrelated label check, now that the repo has a GitHub origin.
  // A fresh labels.stamp throttles it out of this pass, so every gh call a test sees is the pre-check's.
  writeFileSync(join(phome, 'labels.stamp'), '')
  const r = precheckRepo()
  fakePrecheckBd(extra)
  fakeGh()
  fakePrecheckHerdr()
  writeFileSync(join(phome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
}

const runDirs = () => (existsSync(join(phome, 'runs')) ? readdirSync(join(phome, 'runs')) : [])
const mergedPr = (title: string) =>
  JSON.stringify([
    {
      number: 57,
      url: 'https://github.com/acme/widget/pull/57',
      title,
      headRefName: 'factory/some-other-run',
      mergeCommit: { oid: 'deadbeef' },
    },
  ])

test('a merged PR citing the bead rejects it with one comment, and starts no run (claude-factory-6as.2)', () => {
  precheckReset()
  const out = pfactory(['beads'], { GH_JSON: mergedPr('fix: acme-1 lands the thing') })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(0)
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.filter(l => /^bd comment\b/.test(l))).toHaveLength(1)
  expect(calls.some(l => /^bd update\b/.test(l) && l.includes('--add-label rejected'))).toBe(true)
})

test('a second dispatch pass after a reject adds 0 new comments (the bead no longer shows in ready)', () => {
  precheckReset()
  const ghJson = mergedPr('fix: acme-1 lands the thing')
  pfactory(['beads'], { GH_JSON: ghJson })
  rmSync(join(phome, 'dispatch.stamp'), { force: true }) // the 30s throttle would else skip pass 2
  pfactory(['beads'], { GH_JSON: ghJson })
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.filter(l => /^bd comment\b/.test(l))).toHaveLength(1)
})

test('a bead with no matching merged PR starts a run normally', () => {
  precheckReset()
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1)
})

test('gh failing (or timing out) fails open: the run still starts, with one dispatch.json row', () => {
  precheckReset()
  const out = pfactory(['beads'], { GH_FAIL: '1' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1)
  const rows = JSON.parse(readFileSync(join(phome, 'dispatch.json'), 'utf8')) as {
    id: string
    error?: string
  }[]
  expect(rows.some(r => r.id === 'acme-1' && /pre-check skipped/.test(r.error ?? ''))).toBe(true)
})

test('a person-requeued bead (rejected_by=dispatch metadata) starts, with 0 gh calls', () => {
  precheckReset({ metadata: { rejected_by: 'dispatch' } })
  const out = pfactory(['beads'], { GH_JSON: mergedPr('fix: acme-1 lands the thing') })
  expect(out.code).toBe(0)
  expect(existsSync(ghCallsLog)).toBe(false)
  expect(runDirs()).toHaveLength(1)
})

test('FACTORY_PRECHECK=0 turns the whole check off: 0 gh calls, the run starts as before', () => {
  precheckReset()
  const out = pfactory(['beads'], {
    FACTORY_PRECHECK: '0',
    GH_JSON: mergedPr('fix: acme-1 lands the thing'),
  })
  expect(out.code).toBe(0)
  expect(existsSync(ghCallsLog)).toBe(false)
  expect(runDirs()).toHaveLength(1)
})

// claude-factory-6as.3: a live run can hold a ready, unassigned bead (it lost its own claim, to a
// reaper, say). dispatch must not start a second run for it, and must leave one comment naming the
// run, deduped across passes by a `dispatch_skip` metadata stamp.
const MINI: Factory = {
  name: 'lifecycle',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { done: 'done' } } },
}
/** run.json + state.json for a run sitting at a live node (not done/aborted), holding `bead`. `run.factory`
 * must be a real file `loadFactory` can read (the beads pass's track() loop opens it for every run with a
 * bead), so this writes `MINI` as its own on-disk factory JSON, as watch.test.ts's `parkedRun` does. */
function liveRun(id: string, bead: string) {
  const actor = createActor(compile(MINI)).start()
  const f = join(pdir, 'mini.json')
  if (!existsSync(f)) writeFileSync(f, JSON.stringify(MINI))
  const d = join(phome, 'runs', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: f,
      repo: 'n/a',
      goal: 'g',
      ws: 'ws1',
      worktree: 'n/a',
      branch: 'b',
      bead,
    }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
}

test('a ready, unassigned bead a live run already holds gets one comment, and starts no second run', () => {
  precheckReset()
  liveRun('other-run', 'acme-1')
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toEqual(['other-run']) // no new run for acme-1
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.filter(l => /^bd comment\b/.test(l))).toHaveLength(1)
  expect(calls.some(l => /^bd update\b/.test(l) && l.includes('dispatch_skip=other-run'))).toBe(true)
  // claude-factory-6as.4: `factory metrics` counts a live-run skip from this file, not from bd
  const lines = readFileSync(join(phome, 'precheck.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  expect(lines.filter((l: { kind: string }) => l.kind === 'live-run')).toHaveLength(1)
})

test('a second pass adds 0 new comments for a bead a live run already holds', () => {
  precheckReset()
  liveRun('other-run', 'acme-1')
  pfactory(['beads'], { GH_JSON: '[]' })
  rmSync(join(phome, 'dispatch.stamp'), { force: true }) // the 30s throttle would else skip pass 2
  pfactory(['beads'], { GH_JSON: '[]' })
  expect(runDirs()).toEqual(['other-run'])
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.filter(l => /^bd comment\b/.test(l))).toHaveLength(1)
})

/** run.json + state.json for an ended (aborted) run that still names `bead`. Unlike `liveRun`, the
 * run's node here is `'aborted'`, so dispatch's `linked` map drops it and the bead looks unowned.
 * Only the candidate loop's own scan for a run with this bead (cli.ts, `runBranches`) can still find
 * it, through the PR's head branch. */
function endedRun(id: string, bead: string) {
  const f = join(pdir, 'mini.json')
  if (!existsSync(f)) writeFileSync(f, JSON.stringify(MINI))
  const actor = createActor(compile(MINI)).start()
  actor.send({ type: 'ABORT', at: Date.now() })
  const d = join(phome, 'runs', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: f,
      repo: 'n/a',
      goal: 'g',
      ws: 'ws1',
      worktree: 'n/a',
      branch: 'b',
      bead,
    }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
}

const mergedPrByHead = (title: string, headRefName: string) =>
  JSON.stringify([
    {
      number: 57,
      url: 'https://github.com/acme/widget/pull/57',
      title,
      headRefName,
      mergeCommit: { oid: 'deadbeef' },
    },
  ])

// claude-factory-6as.6: a merged PR can close a bead's work with no bead id in its title, when the PR
// is the ended run's own branch (`factory/<runId>`). dispatch's runBranches scan must still catch
// this, by matching the PR's `headRefName` against the ended run's branch, not its title.
test('a merged PR matching only by an ended run’s head branch (no bead id in the title) still rejects (claude-factory-6as.6)', () => {
  precheckReset()
  endedRun('ended-run', 'acme-1')
  const out = pfactory(['beads'], { GH_JSON: mergedPrByHead('fix: tidy up the thing', 'factory/ended-run') })
  expect(out.code).toBe(0)
  expect(runDirs()).toEqual(['ended-run']) // no new run started for acme-1
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.filter(l => /^bd comment\b/.test(l))).toHaveLength(1)
  expect(calls.some(l => /^bd update\b/.test(l) && l.includes('--add-label rejected'))).toBe(true)
})
