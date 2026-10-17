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

// dispatch() orders its candidates by the pm's plan, when one is fresh (claude-factory-dun.3).
// `bd ready` here always lists acme-1 then acme-2. The rig's maxRuns is 1.
// So dispatch starts exactly one of them each pass. Which one shows whether the plan's order won.

/** fake bd: `ready` lists acme-1 then acme-2, top-level `factory` beads, each with the given
 * priority. `children` is always empty (claude-factory-dun.3). */
function fakeBdTwo(p1: number, p2: number) {
  mkdirSync(bin, { recursive: true })
  const beads = JSON.stringify([
    { id: 'acme-1', title: 't1', labels: ['factory'], priority: p1 },
    { id: 'acme-2', title: 't2', labels: ['factory'], priority: p2 },
  ])
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    `  ready) printf '%s' '${beads}';;`,
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

function resetTwo(p1: number, p2: number) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  const r = repo()
  fakeBdTwo(p1, p2)
  fakeHerdr()
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle', maxRuns: 1 }]),
  )
}

/** the one run dispatch started (maxRuns 1): which bead it holds, from its run.json */
function startedBead(): string | undefined {
  const runsDir = join(home, 'runs')
  if (!existsSync(runsDir)) return undefined
  const id = readdirSync(runsDir)[0]
  if (!id) return undefined
  return (JSON.parse(readFileSync(join(runsDir, id, 'run.json'), 'utf8')) as { bead?: string }).bead
}

const writePlan = (at: number, ids: string[]) =>
  writeFileSync(
    join(home, 'plan.json'),
    JSON.stringify({
      at,
      rigs: { a: { items: ids.map(id => ({ id, title: id, priority: 0, why: '' })), findings: [] } },
      proposals: [],
    }),
  )

test('a fresh plan ranking acme-2 first: dispatch starts acme-2, not the bd-order acme-1 (claude-factory-dun.3)', () => {
  resetTwo(2, 2)
  writePlan(Date.now(), ['acme-2', 'acme-1'])
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-2')
})

test('a plan exactly 2h old (and older) is stale: dispatch falls back to bd order (acme-1 first)', () => {
  resetTwo(2, 2)
  writePlan(Date.now() - 2 * 60 * 60_000 - 1000, ['acme-2', 'acme-1'])
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1')
})

test('no plan.json: dispatch uses bd order (acme-1 first)', () => {
  resetTwo(2, 2)
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1')
})

test("a corrupt plan.json ('not json') reads as no plan: acme-1 starts, dispatch.json carries no new error", () => {
  resetTwo(2, 2)
  writeFileSync(join(home, 'plan.json'), 'not json')
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1')
  expect(JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'))).toEqual([])
})

test("a plan.json missing 'rigs' reads as no plan: acme-1 starts, dispatch.json carries no new error (claude-factory-dun.17d)", () => {
  resetTwo(2, 2)
  writeFileSync(join(home, 'plan.json'), JSON.stringify({ at: Date.now(), proposals: [] }))
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1')
  expect(JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'))).toEqual([])
})

test("a plan.json whose 'proposals' is not an array reads as no plan (claude-factory-dun.17d)", () => {
  resetTwo(2, 2)
  writeFileSync(
    join(home, 'plan.json'),
    JSON.stringify({ at: Date.now(), rigs: { a: { items: [], findings: [] } }, proposals: 'nope' }),
  )
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1')
})

test("a plan.json whose rig entry has no 'items'/'findings' arrays reads as no plan, not a throw (claude-factory-dun.18)", () => {
  resetTwo(2, 2)
  writeFileSync(join(home, 'plan.json'), JSON.stringify({ at: Date.now(), rigs: { a: {} }, proposals: [] }))
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1') // bd order: the malformed plan changed nothing
  expect(JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'))).toEqual([])
})

test("a plan.json with a null finding reads as no plan, not a throw: dispatch keeps bd order, not the plan's own ranking (claude-factory-dun.20)", () => {
  resetTwo(2, 2)
  writeFileSync(
    join(home, 'plan.json'),
    JSON.stringify({
      at: Date.now(),
      // ranks acme-2 first: were this plan accepted, dispatch would start acme-2 instead
      // (claude-factory-dun.3's own test proves that). A null finding must reject the whole plan.
      rigs: {
        a: {
          items: [
            { id: 'acme-2', title: 'acme-2', priority: 0, why: '' },
            { id: 'acme-1', title: 'acme-1', priority: 0, why: '' },
          ],
          findings: [null],
        },
      },
      proposals: [],
    }),
  )
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1') // bd order: the malformed plan changed nothing
  expect(JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8'))).toEqual([])
})

test("a rig named like an Object.prototype member and absent from a valid plan's rigs still falls back to bd order (claude-factory-dun.18)", () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  const r = repo()
  fakeBdTwo(2, 2)
  fakeHerdr()
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'constructor', repo: r, factory: 'lifecycle', maxRuns: 1 }]),
  )
  writeFileSync(join(home, 'plan.json'), JSON.stringify({ at: Date.now(), rigs: {}, proposals: [] }))
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1') // a plain rigs['constructor'] lookup would find Object.prototype.constructor
})

test('a planned P3 never starts before a real P2: priority always sorts ahead of the plan', () => {
  resetTwo(2, 3) // acme-1 is P2, acme-2 is P3
  writePlan(Date.now(), ['acme-2', 'acme-1']) // the pm ranks the P3 first
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(startedBead()).toBe('acme-1') // P2 still wins
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

/** fake gh: it logs every call. `$GH_FAIL` set makes every call fail, like a timeout or a rate
 * limit. `$GH_FAIL_HEAD` set makes only a `--head` call fail (claude-factory-6as.9). Else it answers
 * `$GH_JSON` (a `gh pr list --json ...` shaped array, or `[]`) on stdout. */
function fakeGh() {
  const script = [
    '#!/bin/sh',
    `echo "gh $*" >> "${ghCallsLog}"`,
    'if [ -n "$GH_FAIL" ]; then echo "gh: rate limited" >&2; exit 1; fi',
    'case "$*" in',
    '  *--head*) if [ -n "$GH_FAIL_HEAD" ]; then echo "gh: rate limited" >&2; exit 1; fi;;',
    'esac',
    'printf \'%s\' "$GH_JSON"',
  ].join('\n')
  writeFileSync(join(pbin, 'gh'), script)
  chmodSync(join(pbin, 'gh'), 0o755)
}

/** fake bd: `ready` answers two beads, `acme-1` and `acme-2`, both unassigned and labeled `factory`
 * (claude-factory-6as.9's 2-candidate pass). Otherwise the same as `fakePrecheckBd`. */
function fakePrecheckBdTwo() {
  mkdirSync(pbin, { recursive: true })
  const beadsJson = JSON.stringify(
    ['acme-1', 'acme-2'].map(id => ({ id, title: 'fix it', labels: ['factory'] })),
  )
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${bdCallsLog}"`,
    'case "$1" in',
    `  ready) printf '%s' '${beadsJson}';;`,
    "  children) printf '%s' '[]';;",
    '  update)',
    `    case " $* " in *" --add-label rejected "*) : > "${rejectedFlag}";; esac`,
    '    exit 0;;',
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(pbin, 'bd'), script)
  chmodSync(join(pbin, 'bd'), 0o755)
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

// claude-factory-6as.9: a hung or rate-limited gh costs up to 4 calls of 15s, for each candidate.
// One candidate can already prove gh broken for this pass. Dispatch must not pay that cost again
// for the rest. It must fail every other candidate open, with no further gh call.
test('a gh failure for the first candidate fails every later candidate open with no further gh call (claude-factory-6as.9)', () => {
  precheckReset()
  fakePrecheckBdTwo()
  const out = pfactory(['beads'], { GH_FAIL: '1' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(2) // both acme-1 and acme-2 start: gh broken fails every candidate open
  const ghCalls = readFileSync(ghCallsLog, 'utf8').trim().split('\n')
  expect(ghCalls).toHaveLength(1) // only the first candidate's own (failed) gh call; the second makes none
})

// claude-factory-6as.9: a `--head` call is a supplementary lookup, for a PR with no bead id in its
// title. A failed `--head` call must not discard a hit `--search` already found for the same bead.
test('a --search hit still rejects the bead even when a --head call for its run branch fails (claude-factory-6as.9)', () => {
  precheckReset()
  endedRun('ended-run', 'acme-1')
  const out = pfactory(['beads'], { GH_JSON: mergedPr('fix: acme-1 lands the thing'), GH_FAIL_HEAD: '1' })
  expect(out.code).toBe(0)
  expect(runDirs()).toEqual(['ended-run']) // no new run started for acme-1
  const bdCalls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(bdCalls.filter(l => /^bd comment\b/.test(l))).toHaveLength(1)
  expect(bdCalls.some(l => /^bd update\b/.test(l) && l.includes('--add-label rejected'))).toBe(true)
  const ghCalls = readFileSync(ghCallsLog, 'utf8').trim().split('\n')
  expect(ghCalls.some(l => l.includes('--head'))).toBe(true) // the --head call ran, and failed
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

// claude-factory-6as.10: logPrecheck runs between bd's landed write and the comment that explains
// it. A bad precheck.jsonl (here, a directory in its place, so the durable append throws EISDIR)
// must cost `factory metrics` one row, never the bd comment.
test('an unwritable precheck.jsonl still leaves the live-run comment (claude-factory-6as.10)', () => {
  precheckReset()
  liveRun('other-run', 'acme-1')
  mkdirSync(join(phome, 'precheck.jsonl'))
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toEqual(['other-run'])
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.filter(l => /^bd comment\b/.test(l))).toHaveLength(1)
  expect(calls.some(l => /^bd update\b/.test(l) && l.includes('dispatch_skip=other-run'))).toBe(true)
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

// claude-factory-wnm: a requeue edge (A2, A3).
// track() must settle the run without closing or deferring the bead. The bead stays open, ready and
// factory-labeled, for the next dispatch to pick up. With a `to`, track() swaps the bead's
// factory:*/station:* labels. With none, it leaves them as the worker set them.
// Open children and an abort still win over a requeue edge (A3). REQUEUE_MAX stops a loop in a
// factory that always requeues.
const REQ: Factory = {
  name: 'lifecycle',
  start: 'implement',
  nodes: {
    implement: {
      prompt: 'do it',
      next: {
        ship: { to: 'done', requeue: { factory: 'release', station: 'deploy' } },
        again: { to: 'done', requeue: true },
      },
    },
  },
}

/** fake bd for the requeue tests: `show` answers `showJson`, `children` answers `childrenJson`
 * (`[]` by default, no open children). Every other call is logged and succeeds. */
function fakeRequeueBd(showJson: string, childrenJson = '[]') {
  mkdirSync(pbin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${bdCallsLog}"`,
    'case "$1" in',
    `  show) printf '%s' '${showJson}';;`,
    `  children) printf '%s' '${childrenJson}';;`,
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(pbin, 'bd'), script)
  chmodSync(join(pbin, 'bd'), 0o755)
}

function reqReset(showJson: string, childrenJson = '[]') {
  rmSync(pdir, { recursive: true, force: true })
  mkdirSync(pClaudeConfig, { recursive: true })
  writeFileSync(join(pClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(phome, { recursive: true })
  fakeRequeueBd(showJson, childrenJson) // no rigs.json: dispatch()/linearPass()/labelPass() no-op
}

/** fake bd whose `show` fails like a real query-time error (not bd's own "not found") */
function fakeRequeueBdShowFails() {
  mkdirSync(pbin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${bdCallsLog}"`,
    'case "$1" in',
    '  show) echo "Error fetching acme-1: dial tcp: i/o timeout" >&2; exit 1;;',
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(pbin, 'bd'), script)
  chmodSync(join(pbin, 'bd'), 0o755)
}

function reqResetShowFails() {
  rmSync(pdir, { recursive: true, force: true })
  mkdirSync(pClaudeConfig, { recursive: true })
  writeFileSync(join(pClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(phome, { recursive: true })
  fakeRequeueBdShowFails()
}

/** run.json + state.json for a run that just ended on outcome `ship` or `again`, both requeue edges */
function requeuedRun(id: string, bead: string, outcome: 'ship' | 'again') {
  const f = join(pdir, 'req.json')
  if (!existsSync(f)) writeFileSync(f, JSON.stringify(REQ))
  const actor = createActor(compile(REQ)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome, summary: 'moved on', at: Date.now() })
  const d = join(phome, 'runs', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    // repo must be a real directory: Bun.spawnSync's cwd (the bd() call in beads.ts) throws ENOENT
    // for a missing one, even with bd on PATH, and track() swallows that into t.error
    JSON.stringify({ id, factory: f, repo: pdir, goal: 'g', ws: 'ws1', worktree: pdir, branch: 'b', bead }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
}
const trackOf = (id: string) => JSON.parse(readFileSync(join(phome, 'runs', id, 'track.json'), 'utf8'))

test('a requeue {factory,station} edge swaps the old factory:*/station:* labels for the new ones, and counts the hop (A2)', () => {
  const showJson = JSON.stringify([
    { id: 'acme-1', title: 't', labels: ['factory', 'factory:lifecycle', 'station:implement'] },
  ])
  reqReset(showJson)
  requeuedRun('run-1', 'acme-1', 'ship')
  const out = pfactory(['beads'])
  expect(out.code).toBe(0)
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => l.startsWith('bd unclaim acme-1'))).toBe(true)
  expect(calls.filter(l => /^bd close\b/.test(l))).toHaveLength(0) // never closed
  expect(calls.filter(l => /^bd defer\b/.test(l))).toHaveLength(0) // never deferred
  const update = calls.find(l => l.startsWith('bd update acme-1'))!
  expect(update).toContain('--remove-label factory:lifecycle')
  expect(update).toContain('--remove-label station:implement')
  expect(update).toContain('--add-label factory --remove-label rejected')
  expect(update).toContain('--add-label factory:release')
  expect(update).toContain('--add-label station:deploy')
  expect(update).toMatch(
    /--set-metadata requeued_from=run-1 --set-metadata requeued_at=\S+ --set-metadata requeues=1/,
  )
  expect(trackOf('run-1')).toMatchObject({ isSettled: true, requeued: true })
})

test('a requeue: true edge leaves the worker-set factory:*/station:* labels as they are (A2)', () => {
  const showJson = JSON.stringify([
    { id: 'acme-1', title: 't', labels: ['factory', 'factory:release', 'station:implement'] },
  ])
  reqReset(showJson)
  requeuedRun('run-2', 'acme-1', 'again')
  const out = pfactory(['beads'])
  expect(out.code).toBe(0)
  const update = readFileSync(bdCallsLog, 'utf8')
    .trim()
    .split('\n')
    .find(l => l.startsWith('bd update acme-1'))!
  expect(update).not.toContain('--remove-label factory:release')
  expect(update).not.toContain('--remove-label station:implement')
  expect(update).toContain('--add-label factory --remove-label rejected')
  expect(trackOf('run-2')).toMatchObject({ isSettled: true, requeued: true })
})

test('open children still win over a requeue edge: the bead is released, not requeued or closed (A3)', () => {
  const showJson = JSON.stringify([{ id: 'acme-1', title: 't', labels: ['factory'] }])
  const childrenJson = JSON.stringify([{ id: 'acme-1.1', status: 'open' }])
  reqReset(showJson, childrenJson)
  requeuedRun('run-3', 'acme-1', 'ship')
  const out = pfactory(['beads'])
  expect(out.code).toBe(0)
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => l.startsWith('bd unclaim acme-1'))).toBe(true)
  expect(calls.filter(l => l.startsWith('bd update acme-1'))).toHaveLength(0) // no label swap: not requeued
  expect(calls.filter(l => /^bd defer\b/.test(l))).toHaveLength(0)
  expect(trackOf('run-3')).toMatchObject({ isSettled: true })
  expect(trackOf('run-3').requeued).toBeUndefined()
})

test('REQUEUE_MAX (5) stops the loop: a bead already requeued 5 times is deferred, not requeued again, and its requeues counter resets to 0 so an undefer does not defer again at once (A3, claude-factory-wnm.17)', () => {
  const showJson = JSON.stringify([
    {
      id: 'acme-1',
      title: 't',
      labels: ['factory', 'factory:lifecycle'],
      metadata: { requeued_from: 'run-0', requeues: 5 },
    },
  ])
  reqReset(showJson)
  requeuedRun('run-4', 'acme-1', 'ship')
  const out = pfactory(['beads'])
  expect(out.code).toBe(0)
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => /^bd defer acme-1\b/.test(l) && l.includes('requeued 5 times'))).toBe(true)
  const updates = calls.filter(l => l.startsWith('bd update acme-1'))
  expect(updates.some(l => l.includes('--add-label') || l.includes('--remove-label'))).toBe(false) // no label swap: deferred, not requeued
  expect(updates.some(l => l.includes('--set-metadata requeues=0'))).toBe(true) // resets the counter for the next undefer
  expect(trackOf('run-4')).toMatchObject({ isSettled: true })
  expect(trackOf('run-4').requeued).toBeUndefined()
})

test('a bd show failure during the REQUEUE_MAX check leaves the run unsettled for a retry, not deferred (claude-factory-wnm.10)', () => {
  reqResetShowFails()
  requeuedRun('run-5', 'acme-1', 'ship')
  const out = pfactory(['beads'])
  expect(out.code).toBe(0)
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.filter(l => /^bd defer\b/.test(l))).toHaveLength(0) // never read the failure as 0 requeues
  expect(calls.filter(l => l.startsWith('bd update acme-1'))).toHaveLength(0) // never requeued either
  const t = trackOf('run-5')
  expect(t.isSettled).toBeFalsy() // unsettled: the next pass retries the same check
  expect(t.error).toContain('Error fetching acme-1')
})

test('a retried tick whose requeue already landed for this run skips the REQUEUE_MAX cap (claude-factory-wnm.10)', () => {
  const showJson = JSON.stringify([
    {
      id: 'acme-1',
      title: 't',
      labels: ['factory', 'factory:release', 'station:deploy'],
      metadata: { requeued_from: 'run-6', requeues: 5 },
    },
  ])
  reqReset(showJson)
  requeuedRun('run-6', 'acme-1', 'ship')
  const out = pfactory(['beads'])
  expect(out.code).toBe(0)
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => /^bd defer\b/.test(l))).toBe(false) // the cap never fires for this run's own hop
  expect(calls.some(l => l.startsWith('bd update acme-1'))).toBe(true) // requeue() ran again (idempotent)
  expect(trackOf('run-6')).toMatchObject({ isSettled: true, requeued: true })
})

test('a run revived with GOTO after a requeue ending drops the stale requeued flag, so a later close does not count as a requeue (claude-factory-wnm.21)', () => {
  const showJson = JSON.stringify([
    { id: 'acme-1', title: 't', labels: ['factory', 'factory:lifecycle', 'station:implement'] },
  ])
  reqReset(showJson)
  requeuedRun('run-7', 'acme-1', 'ship')
  pfactory(['beads']) // first pass: the run ends on a requeue edge and settles
  expect(trackOf('run-7')).toMatchObject({ isSettled: true, requeued: true })

  // a person revives the ended run with a GOTO back into a working node
  const actor = createActor(compile(REQ)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ship', summary: 'moved on', at: 1 })
  actor.send({ type: 'GOTO', node: 'implement', at: 2 })
  writeFileSync(
    join(phome, 'runs', 'run-7', 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )

  const out = pfactory(['beads'])
  expect(out.code).toBe(0)
  const t = trackOf('run-7')
  expect(t.isSettled).toBe(false) // reopen() succeeded against the fake bd
  expect(t.requeued).toBeUndefined() // the stale flag from the ended run must not survive the revive
})

// claude-factory-wnm (A4, A6, A7): the `factory:<name>` dispatch label.
// A bead's `factory:<name>` label picks a different factory to compile the run from.
// `station:<name>` (already honored, claude-factory-b6c.27) still picks where in it to start.
// An unknown name must defer only that bead; the next candidate in the same rig still starts
// (A6). A requeued bead's pre-check must not reject it a second time for its own, already-landed
// PR (A7). This reuses the pre-check harness (pdir/phome/pbin), since it already gives the rig a
// GitHub origin and a fake `gh`.
const RELEASE_FIXTURE: Factory = {
  name: 'release',
  start: 'triage',
  nodes: {
    triage: { prompt: 'p', next: { done: 'done' } },
    deploy: { prompt: 'p', next: { done: 'done' } },
  },
}

/** writes a fixture factory to `<repo>/.factory/<name>.json`, where `namedFactorySource` looks first */
function writeFixtureFactory(repo: string, name: string, def: Factory) {
  mkdirSync(join(repo, '.factory'), { recursive: true })
  writeFileSync(join(repo, '.factory', `${name}.json`), JSON.stringify(def))
}

/** fake bd: `ready` answers exactly the beads given. Every call is logged, as `fakePrecheckBd` does. */
function fixtureBd(beads: Record<string, unknown>[]) {
  mkdirSync(pbin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${bdCallsLog}"`,
    'case "$1" in',
    `  ready) printf '%s' '${JSON.stringify(beads)}';;`,
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(pbin, 'bd'), script)
  chmodSync(join(pbin, 'bd'), 0o755)
}

function fixtureReset(beads: Record<string, unknown>[]) {
  rmSync(pdir, { recursive: true, force: true })
  mkdirSync(pClaudeConfig, { recursive: true })
  writeFileSync(join(pClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(phome, { recursive: true })
  writeFileSync(join(phome, 'labels.stamp'), '') // throttles labelPass's own unrelated gh call
  const r = precheckRepo()
  writeFixtureFactory(r, 'release', RELEASE_FIXTURE)
  fixtureBd(beads)
  fakeGh()
  fakePrecheckHerdr()
  writeFileSync(join(phome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
}

/** the pinned factory a started run compiled from (its `name` field), or undefined if none started */
function pinnedFactoryName(): string | undefined {
  const runsDir = join(phome, 'runs')
  if (!existsSync(runsDir)) return undefined
  const id = readdirSync(runsDir)[0]
  if (!id) return undefined
  const f = join(runsDir, id, 'factory.json')
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { name?: string }).name : undefined
}

function gotosOf(id: string): { type: string; node: string }[] {
  const inbox = join(phome, 'runs', id, 'inbox.jsonl')
  if (!existsSync(inbox)) return []
  return readFileSync(inbox, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(e => e.type === 'GOTO')
}

test('factory:<name> picks that named factory; station:<name> still starts it there (A4)', () => {
  fixtureReset([{ id: 'acme-1', title: 't', labels: ['factory', 'factory:release', 'station:deploy'] }])
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1)
  expect(pinnedFactoryName()).toBe('release')
  expect(gotosOf(runDirs()[0]!)).toMatchObject([{ type: 'GOTO', node: 'deploy' }])
})

test('station:<name> with no factory:<name> label keeps the rig factory (A4 control)', () => {
  fixtureReset([{ id: 'acme-1', title: 't', labels: ['factory', 'station:deploy'] }])
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(pinnedFactoryName()).toBe('lifecycle')
})

test('an unknown factory:<name> defers only that bead; the next candidate still starts (A6)', () => {
  fixtureReset([
    { id: 'acme-1', title: 't1', labels: ['factory', 'factory:nope'] },
    { id: 'acme-2', title: 't2', labels: ['factory'] },
  ])
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1) // acme-1 deferred, acme-2 starts
  const started = JSON.parse(readFileSync(join(phome, 'runs', runDirs()[0]!, 'run.json'), 'utf8')) as {
    bead?: string
  }
  expect(started.bead).toBe('acme-2')
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => l.startsWith('bd defer acme-1') && l.includes('no factory nope'))).toBe(true)
})

test('a requeued bead with a merged PR citing it starts with 0 gh calls (A7)', () => {
  fixtureReset([{ id: 'acme-1', title: 't', labels: ['factory'], metadata: { requeued_from: 'run-0' } }])
  const out = pfactory(['beads'], { GH_JSON: mergedPr('fix: acme-1 lands the thing') })
  expect(out.code).toBe(0)
  expect(existsSync(ghCallsLog)).toBe(false)
  expect(runDirs()).toHaveLength(1)
})

test('dispatch clears requeued_from/requeued_at right after starting the run that exemption was for (claude-factory-wnm.13)', () => {
  fixtureReset([{ id: 'acme-1', title: 't', labels: ['factory'], metadata: { requeued_from: 'run-0' } }])
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1)
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(
    calls.some(
      l =>
        l.startsWith('bd update acme-1') &&
        l.includes('--unset-metadata requeued_from') &&
        l.includes('--unset-metadata requeued_at'),
    ),
  ).toBe(true)
})

test('dispatch calls no unset-metadata for a bead with no requeued_from (claude-factory-wnm.13 control)', () => {
  fixtureReset([{ id: 'acme-1', title: 't', labels: ['factory'] }])
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1)
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => l.includes('--unset-metadata'))).toBe(false)
})

test('a bead with two factory: labels defers; the next candidate still starts (claude-factory-wnm.11)', () => {
  fixtureReset([
    { id: 'acme-1', title: 't1', labels: ['factory', 'factory:release', 'factory:lifecycle'] },
    { id: 'acme-2', title: 't2', labels: ['factory'] },
  ])
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1) // acme-1 deferred, acme-2 starts
  const started = JSON.parse(readFileSync(join(phome, 'runs', runDirs()[0]!, 'run.json'), 'utf8')) as {
    bead?: string
  }
  expect(started.bead).toBe('acme-2')
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => l.startsWith('bd defer acme-1') && l.includes('ambiguous factory labels'))).toBe(
    true,
  )
})

test('a bead with two station: labels defers; the next candidate still starts (claude-factory-wnm.11)', () => {
  fixtureReset([
    { id: 'acme-1', title: 't1', labels: ['factory', 'station:deploy', 'station:triage'] },
    { id: 'acme-2', title: 't2', labels: ['factory'] },
  ])
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1)
  const started = JSON.parse(readFileSync(join(phome, 'runs', runDirs()[0]!, 'run.json'), 'utf8')) as {
    bead?: string
  }
  expect(started.bead).toBe('acme-2')
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => l.startsWith('bd defer acme-1') && l.includes('ambiguous station labels'))).toBe(
    true,
  )
})

test('a factory:<name> file that fails to load defers only that bead; the next candidate still starts (claude-factory-wnm.14)', () => {
  fixtureReset([
    { id: 'acme-1', title: 't1', labels: ['factory', 'factory:broken'] },
    { id: 'acme-2', title: 't2', labels: ['factory'] },
  ])
  writeFixtureFactory(join(pdir, 'repo'), 'broken', {
    name: 'broken',
    start: 'triage',
    nodes: { triage: { prompt: 'p', next: { done: 'gone' } } },
  } as Factory)
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1) // acme-1 deferred, acme-2 starts
  const started = JSON.parse(readFileSync(join(phome, 'runs', runDirs()[0]!, 'run.json'), 'utf8')) as {
    bead?: string
  }
  expect(started.bead).toBe('acme-2')
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(
    calls.some(l => l.startsWith('bd defer acme-1') && l.includes('factory broken failed to load')),
  ).toBe(true)
})

test('a station:<name> the named factory lacks defers only that bead; the next candidate still starts (claude-factory-wnm.15)', () => {
  fixtureReset([
    { id: 'acme-1', title: 't1', labels: ['factory', 'factory:release', 'station:nope'] },
    { id: 'acme-2', title: 't2', labels: ['factory'] },
  ])
  const out = pfactory(['beads'], { GH_JSON: '[]' })
  expect(out.code).toBe(0)
  expect(runDirs()).toHaveLength(1) // acme-1 deferred, acme-2 starts
  const started = JSON.parse(readFileSync(join(phome, 'runs', runDirs()[0]!, 'run.json'), 'utf8')) as {
    bead?: string
  }
  expect(started.bead).toBe('acme-2')
  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(
    calls.some(l => l.startsWith('bd defer acme-1') && l.includes('station nope not in factory release')),
  ).toBe(true)
})

// claude-factory-wnm (A8): the full, end-to-end claim. A bead moves from one factory to another
// with no hand `factory start`. Run 1 (factory `lifecycle`) ends on a requeue edge, naming factory
// `release` and station `deploy`. `beadsPass()` runs track() then dispatch() in one call
// (cli.ts:2219-2271, called once here through `factory beads`): one pass settles run 1 (the
// requeue) and starts run 2, in the named factory, at the named station, for the same bead.
const E2E_FACTORY_1: Factory = {
  name: 'lifecycle',
  start: 'implement',
  nodes: {
    implement: {
      prompt: 'p',
      next: { ship: { to: 'done', requeue: { factory: 'release', station: 'deploy' } } },
    },
  },
}
const E2E_FACTORY_2: Factory = {
  name: 'release',
  start: 'triage',
  nodes: {
    triage: { prompt: 'p', next: { done: 'done' } },
    deploy: { prompt: 'p', next: { done: 'done' } },
  },
}

/** fake bd for the A8 harness. `show`/`children` answer the bead's pre-requeue state: both calls
 * `b.requeue` makes happen before its own `update`. `ready` answers its post-requeue state with no
 * condition: by the time dispatch() calls it, in the same pass, track() already settled run 1. */
function e2eBd() {
  mkdirSync(pbin, { recursive: true })
  const pre = JSON.stringify([
    { id: 'acme-1', title: 't', labels: ['factory', 'factory:lifecycle', 'station:implement'] },
  ])
  const post = JSON.stringify([
    {
      id: 'acme-1',
      title: 't',
      labels: ['factory', 'factory:release', 'station:deploy'],
      metadata: { requeued_from: 'run-1', requeues: 1 },
    },
  ])
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${bdCallsLog}"`,
    'case "$1" in',
    `  show) printf '%s' '${pre}';;`,
    `  ready) printf '%s' '${post}';;`,
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(pbin, 'bd'), script)
  chmodSync(join(pbin, 'bd'), 0o755)
}

function e2eReset() {
  rmSync(pdir, { recursive: true, force: true })
  mkdirSync(pClaudeConfig, { recursive: true })
  writeFileSync(join(pClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(phome, { recursive: true })
  writeFileSync(join(phome, 'labels.stamp'), '') // throttles labelPass's own, unrelated gh call
  // a real git repo: createRun()'s freshBase() runs `git rev-parse` in it, for a new run's base
  const r = precheckRepo()
  writeFixtureFactory(r, 'release', E2E_FACTORY_2)
  e2eBd()
  fakePrecheckHerdr()
  writeFileSync(join(phome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
  return r
}

test('a bead moves lifecycle -> release with no hand factory start (A8)', () => {
  const r = e2eReset()
  // run 1 already sits at `done`, having reported outcome `ship`: a requeue edge
  const f1 = join(pdir, 'factory-1.json')
  writeFileSync(f1, JSON.stringify(E2E_FACTORY_1))
  const actor = createActor(compile(E2E_FACTORY_1)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ship', summary: 'moved on', at: Date.now() })
  const d1 = join(phome, 'runs', 'run-1')
  mkdirSync(d1, { recursive: true })
  writeFileSync(
    join(d1, 'run.json'),
    JSON.stringify({
      id: 'run-1',
      factory: f1,
      repo: r,
      goal: 'g',
      ws: 'ws1',
      worktree: r,
      branch: 'b',
      bead: 'acme-1',
    }),
  )
  writeFileSync(join(d1, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))

  const out = pfactory(['beads']) // one pass: track() settles run 1, dispatch() starts run 2
  expect(out.code).toBe(0)

  const runs = runDirs()
  expect(runs).toHaveLength(2) // run-1 (now settled) and the new run dispatch started
  const run2Id = runs.find(id => id !== 'run-1')!
  const run2 = JSON.parse(readFileSync(join(phome, 'runs', run2Id, 'run.json'), 'utf8')) as { bead?: string }
  expect(run2.bead).toBe('acme-1') // the same bead, with no hand `factory start`
  const pinned = JSON.parse(readFileSync(join(phome, 'runs', run2Id, 'factory.json'), 'utf8')) as {
    name: string
  }
  expect(pinned.name).toBe('release') // followed the bead's factory:release label
  expect(gotosOf(run2Id)).toMatchObject([{ type: 'GOTO', node: 'deploy' }]) // started at station:deploy

  const calls = readFileSync(bdCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => l.startsWith('bd unclaim acme-1'))).toBe(true) // run 1 released the bead
  expect(calls.some(l => l.startsWith('bd update acme-1') && l.includes('--add-label factory:release'))).toBe(
    true,
  )
  expect(calls.some(l => l.startsWith('bd update acme-1') && l.includes('--claim'))).toBe(true) // run 2 claimed it
})
