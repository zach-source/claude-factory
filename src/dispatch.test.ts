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
    "  list) printf '%s' '[]';;", // the flood guard's b.every() (claude-factory-8pc.5): no sweep-filed beads here
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
    "  list) printf '%s' '[]';;", // the flood guard's b.every() (claude-factory-8pc.5): no sweep-filed beads here
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
    "  list) printf '%s' '[]';;", // the flood guard's b.every() (claude-factory-8pc.5): no sweep-filed beads here
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
    "  list) printf '%s' '[]';;", // the flood guard's b.every() (claude-factory-8pc.5): no sweep-filed beads here
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

// claude-factory-8pc.5: the flood guard. dispatch() applies it per rig, before b.ready(), so a
// deferred or unlabeled bead never shows up as ready work the same pass. This harness's fake `bd`
// tracks which beads lost the `factory` label (a file per id), and its `ready` reads that state
// back: a real bd would reflect the same-pass label change this way too.
const gdir = join(tmpdir(), `dispatch-guard-${process.pid}`)
const ghome = join(gdir, 'home')
const gbin = join(gdir, 'bin')
const gClaudeConfig = join(gdir, 'claude-config')
const gCallsLog = join(gdir, 'bd-calls.log')

afterEach(() => rmSync(gdir, { recursive: true, force: true }))

function gfactory(args: string[], env: Record<string, string> = {}) {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: ghome,
      PATH: `${gbin}:${laptop.PATH}`,
      CLAUDE_CONFIG_DIR: gClaudeConfig,
      FACTORY_SELF_UPDATE: '0',
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** 6 sweep-filed beads for rig `a`, oldest (acme-1) to newest (acme-6): a cap of 5 holds back
 * acme-6. Only acme-2 carries an allowed `sweep-queue:*` label; the rest are "unclassed". `list`
 * (b.every()) answers all 6, with their real `created_by` and starting labels. `ready` answers only
 * the ones that still carry `factory`, reading the removal markers `update` writes below -- so it
 * reflects this same pass's own relabeling, as a real bd would. */
function fakeGuardBd() {
  mkdirSync(gbin, { recursive: true })
  const bead = (i: number) => ({
    id: `acme-${i}`,
    created_by: `factory/sweeps-run${i}/maintain`,
    created_at: new Date(Date.now() - (7 - i) * 60_000).toISOString(),
    labels: i === 2 ? ['factory', 'sweep-queue:incident'] : ['factory'],
  })
  const all = [1, 2, 3, 4, 5, 6].map(bead)
  const readyCase = [1, 2, 3, 4, 5, 6]
    .map(
      i =>
        `    if [ ! -f "${gdir}/removed-acme-${i}" ]; then out="$out$sep{\\"id\\":\\"acme-${i}\\",\\"title\\":\\"t\\",\\"labels\\":[\\"factory\\"]}"; sep=","; fi`,
    )
    .join('\n')
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${gCallsLog}"`,
    'case "$1" in',
    `  list) printf '%s' '${JSON.stringify(all)}';;`,
    '  ready)',
    '    out="["',
    '    sep=""',
    readyCase,
    '    out="$out]"',
    '    printf \'%s\' "$out";;',
    '  update)',
    `    id="$2"`,
    '    case " $* " in *" --remove-label factory "*) touch "' + gdir + '/removed-$id";; esac',
    '    exit 0;;',
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(gbin, 'bd'), script)
  chmodSync(join(gbin, 'bd'), 0o755)
}

function fakeGuardHerdr() {
  const worktree = join(gdir, 'worktree-stub')
  const script = [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${worktree}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ].join('\n')
  writeFileSync(join(gbin, 'herdr'), script)
  chmodSync(join(gbin, 'herdr'), 0o755)
}

function guardReset() {
  rmSync(gdir, { recursive: true, force: true })
  mkdirSync(gClaudeConfig, { recursive: true })
  writeFileSync(join(gClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(ghome, { recursive: true })
  const r = repo()
  fakeGuardBd()
  fakeGuardHerdr()
  writeFileSync(join(ghome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
}

const gRunDirs = () => (existsSync(join(ghome, 'runs')) ? readdirSync(join(ghome, 'runs')) : [])
const gBeadOf = (runId: string) =>
  (JSON.parse(readFileSync(join(ghome, 'runs', runId, 'run.json'), 'utf8')) as { bead?: string }).bead

test('the flood guard defers the 6th sweep-filed bead and strips the unclassed ones: only the allowed one starts', () => {
  guardReset()
  const out = gfactory(['beads'])
  expect(out.code).toBe(0)
  const started = gRunDirs().map(gBeadOf)
  expect(started).toEqual(['acme-2']) // the only kept AND allowed bead
  const calls = readFileSync(gCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => /^bd defer acme-6\b/.test(l))).toBe(true) // the 6th: past the cap
  expect(calls.some(l => /^bd update acme-6\b.*--remove-label factory\b/.test(l))).toBe(true)
  for (const id of ['acme-1', 'acme-3', 'acme-4', 'acme-5']) {
    expect(calls.some(l => new RegExp(`^bd update ${id}\\b.*--remove-label factory\\b`).test(l))).toBe(true)
    expect(calls.some(l => new RegExp(`^bd update ${id}\\b.*--add-label sweep:maintain\\b`).test(l))).toBe(
      true,
    )
  }
  expect(calls.some(l => /^bd update acme-2\b.*--remove-label factory\b/.test(l))).toBe(false) // kept, allowed: untouched
  expect(calls.some(l => /^bd update acme-2\b.*--add-label sweep:maintain\b/.test(l))).toBe(true)
})

test('a second pass makes no new defer or relabel call: the guard is idempotent', () => {
  guardReset()
  gfactory(['beads'])
  const firstCount = readFileSync(gCallsLog, 'utf8').trim().split('\n').length
  rmSync(join(ghome, 'dispatch.stamp'), { force: true }) // the 30s throttle would else skip pass 2
  gfactory(['beads'])
  const calls = readFileSync(gCallsLog, 'utf8').trim().split('\n')
  expect(calls.length).toBeGreaterThan(firstCount) // the pass still ran (list, ready, etc.)
  // acme-2 (the only bead still labeled `factory`) never gets a second defer or relabel call
  expect(calls.filter(l => /^bd defer acme-2\b/.test(l))).toHaveLength(0)
  expect(calls.filter(l => /^bd update acme-2\b.*--remove-label factory\b/.test(l))).toHaveLength(0)
})

// --- claude-factory-8pc.12, .13 and .18: the guard must handle each bead once, fail closed, and
// trust no mark the bead's own labels (a sweep worker's bd calls) can set ---

/** a bead carrying `sweep:maintain` and, again, `factory`: what a person's `factory queue` on a
 * held bead leaves behind. `list` and `ready` both answer it with those labels: a real bd would,
 * once `factory queue` landed. */
function fakeRequeuedBd() {
  mkdirSync(gbin, { recursive: true })
  const bead = {
    id: 'acme-1',
    created_by: 'factory/sweeps-run1/maintain',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    labels: ['factory', 'sweep:maintain'],
  }
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${gCallsLog}"`,
    'case "$1" in',
    `  list) printf '%s' '${JSON.stringify([bead])}';;`,
    `  ready) printf '%s' '${JSON.stringify([{ id: bead.id, title: 't', labels: bead.labels }])}';;`,
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(gbin, 'bd'), script)
  chmodSync(join(gbin, 'bd'), 0o755)
}

test("a person's re-queue of a held sweep bead stands: a mark in sweep-guard.json, not the bead's own label, is what lets it through", () => {
  rmSync(gdir, { recursive: true, force: true })
  mkdirSync(gClaudeConfig, { recursive: true })
  writeFileSync(join(gClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(ghome, { recursive: true })
  const r = repo()
  fakeRequeuedBd()
  fakeGuardHerdr()
  writeFileSync(join(ghome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
  // claude-factory-8pc.18: an earlier pass already scored this bead (deferred it, then a person
  // re-queued it). That pass is what wrote this mark; the bead's `sweep:maintain` label alone
  // (fakeRequeuedBd above) never would.
  writeFileSync(join(ghome, 'sweep-guard.json'), JSON.stringify({ a: { 'acme-1': Date.now() - 60_000 } }))
  const out = gfactory(['beads'])
  expect(out.code).toBe(0)
  expect(gRunDirs().map(gBeadOf)).toEqual(['acme-1']) // it started
  const calls = readFileSync(gCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => /^bd defer acme-1\b/.test(l))).toBe(false)
  // `bd update acme-1 --claim` still happens (createTracked claims the bead); no label call does
  expect(calls.some(l => /^bd update acme-1\b.*--(add|remove)-label\b/.test(l))).toBe(false)
})

/** 6 beads born already carrying `sweep:maintain`, as a sweep worker filing one with
 * `-l factory -l sweep:maintain` would: the label a worker's own bd call can set. No sweep-guard.json
 * mark exists for any of them: dispatch has never scored them before. */
function fakeSelfLabeledBd() {
  mkdirSync(gbin, { recursive: true })
  const bead = (i: number) => ({
    id: `acme-${i}`,
    created_by: `factory/sweeps-run${i}/maintain`,
    created_at: new Date(Date.now() - (7 - i) * 60_000).toISOString(),
    labels: ['factory', 'sweep:maintain'],
  })
  const all = [1, 2, 3, 4, 5, 6].map(bead)
  const readyCase = [1, 2, 3, 4, 5, 6]
    .map(
      i =>
        `    if [ ! -f "${gdir}/removed-acme-${i}" ]; then out="$out$sep{\\"id\\":\\"acme-${i}\\",\\"title\\":\\"t\\",\\"labels\\":[\\"factory\\",\\"sweep:maintain\\"]}"; sep=","; fi`,
    )
    .join('\n')
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${gCallsLog}"`,
    'case "$1" in',
    `  list) printf '%s' '${JSON.stringify(all)}';;`,
    '  ready)',
    '    out="["',
    '    sep=""',
    readyCase,
    '    out="$out]"',
    '    printf \'%s\' "$out";;',
    '  update)',
    `    id="$2"`,
    '    case " $* " in *" --remove-label factory "*) touch "' + gdir + '/removed-$id";; esac',
    '    exit 0;;',
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(gbin, 'bd'), script)
  chmodSync(join(gbin, 'bd'), 0o755)
}

test('claude-factory-8pc.18: a bead born with sweep:<station> already on it gets no free pass; none of 6 starts, the 6th is deferred', () => {
  rmSync(gdir, { recursive: true, force: true })
  mkdirSync(gClaudeConfig, { recursive: true })
  writeFileSync(join(gClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(ghome, { recursive: true })
  const r = repo()
  fakeSelfLabeledBd()
  fakeGuardHerdr()
  writeFileSync(join(ghome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
  const out = gfactory(['beads'])
  expect(out.code).toBe(0)
  expect(gRunDirs()).toEqual([]) // none started: the label alone buys no bead a free pass
  const calls = readFileSync(gCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => /^bd defer acme-6\b/.test(l))).toBe(true) // the 6th: past the cap
})

/** `list` (b.every()) itself fails: no bead here is a sweep-filed one, but the guard read must still
 * fail closed. `ready` answers one ordinary, non-sweep bead with `factory`. */
function fakeEveryFailsBd() {
  mkdirSync(gbin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${gCallsLog}"`,
    'case "$1" in',
    '  list) echo "bd down" >&2; exit 1;;',
    `  ready) printf '%s' '${JSON.stringify([{ id: 'acme-1', title: 't', labels: ['factory'] }])}';;`,
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(gbin, 'bd'), script)
  chmodSync(join(gbin, 'bd'), 0o755)
}

test('a b.every() failure fails closed: no ready bead starts for that rig this pass', () => {
  rmSync(gdir, { recursive: true, force: true })
  mkdirSync(gClaudeConfig, { recursive: true })
  writeFileSync(join(gClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(ghome, { recursive: true })
  const r = repo()
  fakeEveryFailsBd()
  fakeGuardHerdr()
  writeFileSync(join(ghome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
  const out = gfactory(['beads'])
  expect(out.code).toBe(0)
  expect(existsSync(join(ghome, 'runs'))).toBe(false) // acme-1 would else start: the guard read failed
  const errors = JSON.parse(readFileSync(join(ghome, 'dispatch.json'), 'utf8')) as {
    id: string
    error?: string
  }[]
  expect(errors.some(e => e.id === 'rig:a' && /bd down/.test(e.error ?? ''))).toBe(true)
})

/** one sweep-filed bead the guard must relabel (kept, not allowed: it has no `sweep-queue:*` label
 * yet). `update` fails for it, as a transient bd error would. `ready` still answers it with
 * `factory`, as a real bd's would when that relabel never landed. */
function fakeRelabelFailsBd() {
  mkdirSync(gbin, { recursive: true })
  const bead = {
    id: 'acme-1',
    created_by: 'factory/sweeps-run1/maintain',
    created_at: new Date().toISOString(),
    labels: ['factory'],
  }
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${gCallsLog}"`,
    'case "$1" in',
    `  list) printf '%s' '${JSON.stringify([bead])}';;`,
    `  ready) printf '%s' '${JSON.stringify([{ id: bead.id, title: 't', labels: ['factory'] }])}';;`,
    '  update)',
    '    case " $* " in', // fail only the guard's own relabel call, not createTracked's --claim
    '      *" --add-label "*|*" --remove-label "*) echo "bd down" >&2; exit 1;;',
    '      *) exit 0;;',
    '    esac;;',
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(gbin, 'bd'), script)
  chmodSync(join(gbin, 'bd'), 0o755)
}

test('a relabel failure fails closed: the bead it could not relabel never starts this pass', () => {
  rmSync(gdir, { recursive: true, force: true })
  mkdirSync(gClaudeConfig, { recursive: true })
  writeFileSync(join(gClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(ghome, { recursive: true })
  const r = repo()
  fakeRelabelFailsBd()
  fakeGuardHerdr()
  writeFileSync(join(ghome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
  const out = gfactory(['beads'])
  expect(out.code).toBe(0)
  expect(existsSync(join(ghome, 'runs'))).toBe(false) // ready still names it with `factory`, but excluded
  const errors = JSON.parse(readFileSync(join(ghome, 'dispatch.json'), 'utf8')) as {
    id: string
    error?: string
  }[]
  expect(errors.some(e => e.id === 'acme-1')).toBe(true)
})

/** `list` (`b.every()`) answers before a sweep pass files its bead: it sees none. `ready` answers
 * after: it names a fresh sweep-filed bead (`created_by` matches the sweep-filer pattern) with
 * only `factory`, no `sweep:<station>` label yet. A real bd would read this way when a sweep
 * pass's own `bd create` lands in the gap between the two calls (claude-factory-8pc.17). */
function fakeLateFiledBd() {
  mkdirSync(gbin, { recursive: true })
  const bead = {
    id: 'acme-1',
    created_by: 'factory/sweeps-run1/maintain',
    title: 't',
    labels: ['factory'],
  }
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${gCallsLog}"`,
    'case "$1" in',
    "  list) printf '%s' '[]';;", // the guard above sees no sweep-filed bead this pass
    `  ready) printf '%s' '${JSON.stringify([bead])}';;`,
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(gbin, 'bd'), script)
  chmodSync(join(gbin, 'bd'), 0o755)
}

test('a sweep bead filed between b.every() and b.ready() never starts unguarded (claude-factory-8pc.17)', () => {
  rmSync(gdir, { recursive: true, force: true })
  mkdirSync(gClaudeConfig, { recursive: true })
  writeFileSync(join(gClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(ghome, { recursive: true })
  const r = repo()
  fakeLateFiledBd()
  fakeGuardHerdr()
  writeFileSync(join(ghome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
  const out = gfactory(['beads'])
  expect(out.code).toBe(0)
  expect(existsSync(join(ghome, 'runs'))).toBe(false) // acme-1 would else start with no cap check at all
})

/** one sweep-filed bead born 25h ago: older than `sweepGuard`'s own 24h cap window, so `sweepGuard`
 * drops it from its results and never scores it. No sweep-guard.json mark exists for it either:
 * dispatch never reached it in time (a full rig or a halt, past 24h, say). `ready` reflects this
 * pass's own relabel, the same way `fakeGuardBd` above does. */
function fakeAgedOutBd() {
  mkdirSync(gbin, { recursive: true })
  const bead = {
    id: 'acme-1',
    created_by: 'factory/sweeps-run1/maintain',
    created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    labels: ['factory'],
  }
  const script = [
    '#!/bin/sh',
    `echo "bd $*" >> "${gCallsLog}"`,
    'case "$1" in',
    `  list) printf '%s' '${JSON.stringify([bead])}';;`,
    '  ready)',
    `    if [ ! -f "${gdir}/removed-acme-1" ]; then printf '%s' '${JSON.stringify([
      { id: bead.id, title: 't', labels: ['factory'] },
    ])}'; else printf '%s' '[]'; fi;;`,
    '  update)',
    '    id="$2"',
    '    case " $* " in *" --remove-label factory "*) touch "' + gdir + '/removed-$id";; esac',
    '    exit 0;;',
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(gbin, 'bd'), script)
  chmodSync(join(gbin, 'bd'), 0o755)
}

test('claude-factory-8pc.21: a sweep bead aged out of the guard window unscored never starts', () => {
  rmSync(gdir, { recursive: true, force: true })
  mkdirSync(gClaudeConfig, { recursive: true })
  writeFileSync(join(gClaudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(ghome, { recursive: true })
  const r = repo()
  fakeAgedOutBd()
  fakeGuardHerdr()
  writeFileSync(join(ghome, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
  const out = gfactory(['beads'])
  expect(out.code).toBe(0)
  expect(existsSync(join(ghome, 'runs'))).toBe(false) // acme-1 would else start with no cap or allowlist check
  const calls = readFileSync(gCallsLog, 'utf8').trim().split('\n')
  expect(calls.some(l => /^bd defer acme-1\b/.test(l))).toBe(true)
  expect(calls.some(l => /^bd update acme-1\b.*--remove-label factory\b/.test(l))).toBe(true)
  expect(calls.some(l => /^bd update acme-1\b.*--add-label sweep:maintain\b/.test(l))).toBe(true)
})
