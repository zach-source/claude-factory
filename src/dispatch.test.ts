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
