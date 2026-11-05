// `factory start`, end to end through bin/factory (claude-factory-5q3): a goal shaped like one of the
// rig's own bead ids must never fall through to filing a new bead titled with the id text when bd's
// lookup fails for any reason (a timeout) or answers a real "not found" -- the start fails instead, and
// creates nothing. A goal that doesn't match the rig's own prefix, or names a bead bd finds, starts
// exactly as before (no regression). A fake `bd` and `herdr` stand in for the real CLIs: herdr only
// answers `worktree create` (so createRun can finish) and otherwise fails fast, which the machine already
// catches internally; an untrusted fake Claude config keeps the first tick at "awaiting trust" rather than
// ever reaching a real pane.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, where } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
// Each test gets a fresh dir: a detached pass of the last test's `factory start` can still write
// into its home after the test ends, and a shared dir would keep that run (claude-factory-1xyk).
const root = join(tmpdir(), `start-${process.pid}`)
let n = 0
let dir = ''
let home = ''
let bin = ''
let calls = ''
let showMode = '' // found | owned | notfound | timeout | query-timeout | store-missing
let claimFail = '' // marker file: `update --claim` exits 1
let updateFail = '' // marker file: any other `update` exits 1
let claudeConfig = ''

afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_NO_KICK: '1',
      PATH: `${bin}:${laptop.PATH}`,
      FACTORY_HERDR: join(bin, 'herdr'),
      // no project is ever trusted here, so the first tick stops at "awaiting trust" instead of
      // reaching a real pane
      CLAUDE_CONFIG_DIR: claudeConfig,
      // this dev worktree's own branch is never 'main', so a real self-update kick would refuse
      // and mail the manager "branch is ..., not main" -- a distinct, new refusal reason that
      // would land in `home` on a later tick and inflate manager-mail assertions (claude-factory-5h9.8)
      FACTORY_SELF_UPDATE: '0',
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

/** fake bd: `config get issue_prefix` -> prefix, `show <id> --json` -> $(cat showMode), `create` -> a
 * fresh id (logged), `update --claim` -> ok. Every call is logged so a test can prove create/claim were
 * never reached. `query-timeout` reproduces bd 1.3.0's query-time failure: the *same* not-found JSON on
 * stdout as `notfound`, but stderr says "Error fetching <id>: <err>" instead of "Issue <id> not found".
 * `store-missing` reproduces bd 1.3.0's store-open failure (the shared server is up but this rig's own
 * database is not there): empty stdout, exit 1, stderr "Error: failed to open database: database ... not
 * found on Dolt server at ..." -- "not found" appears in that stderr too, so it must not read as a genuine
 * not-found. */
function fakeBd(prefix: string) {
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "$*" >> ${calls}`,
    'case "$1" in',
    `  config) printf '%s' '${prefix}';;`,
    '  show)',
    `    m=$(cat ${showMode} 2>/dev/null || echo found)`,
    '    case "$m" in',
    '      found) printf \'%s\' \'[{"id":"acme-1","title":"t"}]\';;',
    '      owned) printf \'%s\' \'[{"id":"acme-1","title":"t","metadata":{"owner_decisions":{}}}]\';;',
    '      handed-off) printf \'%s\' \'[{"id":"acme-1","title":"t","labels":["owner"],"metadata":{"owner_question":"q","owner_since":"2026-11-01"}}]\';;',
    '      label-only) printf \'%s\' \'[{"id":"acme-1","title":"t","labels":["owner"]}]\';;',
    '      question-only) printf \'%s\' \'[{"id":"acme-1","title":"t","metadata":{"owner_question":"q"}}]\';;',
    '      since-only) printf \'%s\' \'[{"id":"acme-1","title":"t","metadata":{"owner_since":"2026-11-01"}}]\';;',
    '      owned-handed-off) printf \'%s\' \'[{"id":"acme-1","title":"t","labels":["owner"],"metadata":{"owner_decisions":{},"owner_question":"q","owner_since":"2026-11-01"}}]\';;',
    '      notfound) echo "Issue $2 not found" >&2; printf \'%s\' \'{"error":"no issues found matching the provided IDs"}\'; exit 1;;',
    '      timeout) echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1;;',
    '      query-timeout) echo "Error fetching $2: dial tcp 127.0.0.1:3308: i/o timeout" >&2; printf \'%s\' \'{"error":"no issues found matching the provided IDs"}\'; exit 1;;',
    '      store-missing) echo \'Error: failed to open database: database "zzz" not found on Dolt server at 127.0.0.1:3308\' >&2; exit 1;;',
    '    esac;;',
    '  create) echo new-bead-1;;',
    '  update)',
    `    case "$*" in`,
    `      *--claim*) [ -e ${claimFail} ] && { echo "already claimed" >&2; exit 1; };;`,
    `      *) [ -e ${updateFail} ] && { echo "update failed" >&2; exit 1; };;`,
    '    esac; exit 0;;',
    "  children) printf '%s' '[]';;",
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

/** fake herdr: only `worktree create` answers (so createRun can finish); everything else fails fast,
 * which the machine already catches (reconcile, launchPane) without reaching a real pane or process */
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

const factoryFixture = () => {
  const f = join(dir, 'tiny.json')
  writeFileSync(
    f,
    JSON.stringify({
      name: 'tiny',
      start: 'work',
      nodes: { work: { prompt: 'Do it.', next: { ok: 'done' } } },
    }),
  )
  return f
}

function reset() {
  dir = join(root, String(++n))
  home = join(dir, 'home')
  bin = join(dir, 'bin')
  calls = join(dir, 'calls.log')
  showMode = join(dir, 'show-mode')
  claimFail = join(dir, 'claim-fail')
  updateFail = join(dir, 'update-fail')
  claudeConfig = join(dir, 'claude-config')
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
}

test('a bead-ID-shaped goal whose lookup fails (a timeout) fails the start and creates nothing', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'timeout')
  const out = run(['start', factoryFixture(), r, 'acme-yrq'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('acme-yrq')
  expect(out.err).toContain('nothing was created')
  const log = readFileSync(calls, 'utf8')
  expect(log).not.toContain('create ')
  expect(log).not.toContain('--claim')
  expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0).toBe(0)
})

test("a bead-ID-shaped goal whose lookup fails (a timeout) fails the start even under a different rig's prefix: bd being down means create would fail too", () => {
  reset()
  const r = repo()
  fakeBd('zzz') // this rig's own prefix is not "acme": the goal does not carry it
  fakeHerdr()
  writeFileSync(showMode, 'timeout')
  const out = run(['start', factoryFixture(), r, 'acme-yrq'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('acme-yrq')
  expect(out.err).toContain('nothing was created')
  const log = readFileSync(calls, 'utf8')
  expect(log).not.toContain('create ')
  expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0).toBe(0)
})

test("a bead-ID-shaped goal whose bd show times out mid-query (the same not-found JSON on stdout as a real 404) fails the start and creates nothing, even under another rig's prefix: this is the original incident", () => {
  reset()
  const r = repo()
  fakeBd('zzz') // this rig's own prefix is not "acme": the goal does not carry it
  fakeHerdr()
  writeFileSync(showMode, 'query-timeout')
  const out = run(['start', factoryFixture(), r, 'acme-yrq'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('acme-yrq')
  expect(out.err).toContain('nothing was created')
  const log = readFileSync(calls, 'utf8')
  expect(log).not.toContain('create ')
  expect(log).not.toContain('--claim')
  expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0).toBe(0)
})

test('a bead-ID-shaped goal whose bd show fails because this rig\'s own store is missing (stderr also says "not found", but about the database, not the issue) fails the start and creates nothing, even under another rig\'s prefix', () => {
  reset()
  const r = repo()
  fakeBd('zzz') // this rig's own prefix is not "acme": the goal does not carry it
  fakeHerdr()
  writeFileSync(showMode, 'store-missing')
  const out = run(['start', factoryFixture(), r, 'acme-yrq'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('acme-yrq')
  expect(out.err).toContain('could not look up')
  expect(out.err).toContain('nothing was created')
  const log = readFileSync(calls, 'utf8')
  expect(log).not.toContain('create ')
  expect(log).not.toContain('--claim')
  expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0).toBe(0)
})

test('a bead-ID-shaped goal bd genuinely answers "not found" against this rig\'s own prefix fails the start and creates nothing', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'notfound')
  const out = run(['start', factoryFixture(), r, 'acme-yrq'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('acme-yrq')
  expect(out.err).toContain('nothing was created')
  const log = readFileSync(calls, 'utf8')
  expect(log).not.toContain('create ')
  expect(log).not.toContain('--claim')
  expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0).toBe(0)
})

test("a goal shaped like a bead id but not found under this rig's own prefix still creates a bead, as before", () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'notfound')
  const out = run(['start', factoryFixture(), r, 'fix-login'])
  expect(out.code).toBe(0)
  const log = readFileSync(calls, 'utf8')
  expect(log).toContain('create --title fix-login')
  expect(readdirSync(join(home, 'runs')).length).toBe(1)
})

test('a goal naming a bead bd finds still starts a run on it, as before', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'found')
  const out = run(['start', factoryFixture(), r, 'acme-1'])
  expect(out.code).toBe(0)
  const log = readFileSync(calls, 'utf8')
  expect(log).not.toContain('create ')
  expect(readdirSync(join(home, 'runs')).length).toBe(1)
})

// claude-factory-vad1: goalOf writes a run's goal as '<id>: <title>'. A start with that text, copied from a
// run or from `factory status`, must work the named bead, not file a copy titled with the whole text.
test("an '<id>: <title>' goal naming a bead bd finds starts a run on that bead and creates nothing (claude-factory-vad1)", () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'found')
  const out = run(['start', factoryFixture(), r, 'acme-1: docs: filing guard, thresholds and re-queue'])
  expect(out.code).toBe(0)
  const log = readFileSync(calls, 'utf8')
  expect(log).toContain('show acme-1 ')
  expect(log).not.toContain('create ')
  expect(readdirSync(join(home, 'runs')).length).toBe(1)
})

test("an '<id>: <title>' goal under this rig's prefix that bd does not find fails the start and creates nothing (claude-factory-vad1)", () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'notfound')
  const out = run(['start', factoryFixture(), r, 'acme-yrq: some title'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('no bead acme-yrq')
  expect(readFileSync(calls, 'utf8')).not.toContain('create ')
})

test('a goal with a colon whose head is not a bead id still creates a bead, as before (claude-factory-vad1)', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'notfound')
  const out = run(['start', factoryFixture(), r, 'fix-login: the form drops the session'])
  expect(out.code).toBe(0)
  expect(readFileSync(calls, 'utf8')).toContain('create --title fix-login: the form drops the session')
})

test('--owned starts an owner-only bead for the person, but FACTORY_PATROL refuses it even with --owned (claude-factory-72v.19)', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'owned')
  const patrol = run(['start', factoryFixture(), r, 'acme-1', '--owned'], { FACTORY_PATROL: '1' })
  expect(patrol.code).not.toBe(0)
  expect(patrol.err).toContain('a patrol cannot start it')
  expect(existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0).toBe(0)

  const person = run(['start', factoryFixture(), r, 'acme-1', '--owned'])
  expect(person.code).toBe(0)
  expect(readdirSync(join(home, 'runs')).length).toBe(1)
})

test('start <factory>@constructor (an Object.prototype key) fails as an unknown station and creates nothing (claude-factory-dax)', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  const out = run(['start', `${factoryFixture()}@constructor`, r, 'a goal'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('no station "constructor"')
  const runs = join(home, 'runs')
  expect(existsSync(runs) ? readdirSync(runs) : []).toHaveLength(0)
})

test('fork <run> constructor (an Object.prototype key) prints the usage line (claude-factory-dax)', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  const started = run(['start', factoryFixture(), r, 'a goal'])
  expect(started.code).toBe(0)
  const id = readdirSync(join(home, 'runs'))[0]!
  const out = run(['fork', id, 'constructor'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('usage: factory fork')
})

test('help prints free-text placeholders in quotes (claude-factory-nt33)', () => {
  reset()
  const h = run(['help'])
  const text = h.out + h.err
  for (const p of [
    "say '<text...>'",
    "poke <run> '[text...]'",
    "fork <run> <station> '[note...]'",
    "memory search [--rig r] '<query...>'",
    "--title '<text>' --description '<text>'",
  ])
    expect(text).toContain(p)
  expect(text).not.toMatch(/ <text\.\.\.>| \[text\.\.\.\]| \[note\.\.\.\]| <query\.\.\.>/)
})

// claude-factory-ytz.1: a FAIL event can exhaust a run's retries. The run then goes 'stuck'. A
// person must run `factory retry` to free it. A stuck run must not fill FACTORY_MAX_RUNS, the
// town cap. The person already holds the run, the same way as a wait or a gate. The control
// below checks the same cap, but on a run that still works.
test('a stuck run does not count against FACTORY_MAX_RUNS, but a working run does (claude-factory-ytz.1)', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, 'found')
  const first = run(['start', factoryFixture(), r, 'acme-1'])
  expect(first.code).toBe(0)
  const id = readdirSync(join(home, 'runs'))[0]!

  // control: the first run is still at work.working: FACTORY_MAX_RUNS=1 refuses a second start
  const refused = run(['start', factoryFixture(), r, 'acme-1'], { FACTORY_MAX_RUNS: '1' })
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain('runs are busy')

  // build a work.stuck snapshot the way the machine really reaches it: FAIL twice exhausts retries:1
  const stuckDef = {
    name: 'tiny',
    start: 'work',
    nodes: { work: { prompt: 'Do it.', next: { ok: 'done' }, retries: 1 } },
  }
  const actor = createActor(compile(stuckDef)).start()
  actor.send({ type: 'FAIL', seq: 1, reason: 'timeout', at: 1000 })
  actor.send({ type: 'TICK', at: 40_000 })
  actor.send({ type: 'FAIL', seq: 2, reason: 'went idle', at: 50_000 })
  expect(where(actor.getSnapshot().value)).toEqual(['work', 'stuck']) // the fixture is really stuck
  const snapshot = actor.getPersistedSnapshot()
  writeFileSync(join(home, 'runs', id, 'state.json'), JSON.stringify({ cursor: 0, snapshot }))

  // AC1: the same FACTORY_MAX_RUNS=1 no longer refuses once the run is stuck, not working
  const allowed = run(['start', factoryFixture(), r, 'acme-1'], { FACTORY_MAX_RUNS: '1' })
  expect(allowed.code).toBe(0)
  expect(readdirSync(join(home, 'runs')).length).toBe(2)
}, 30_000)

// claude-factory-ytz.2: the owner already runs the live manager with FACTORY_MAX_RUNS=16 in its
// shell env, a setting no committed file holds. Commit 16 as the default, so a fresh shell or CI
// matches the live cap. The test below deletes FACTORY_MAX_RUNS from the spawned env, so it
// shows the committed default, not whatever the test runner's own shell happens to export.
test('`factory help` names the committed default FACTORY_MAX_RUNS as 16 (claude-factory-ytz.2)', () => {
  reset()
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_MAX_RUNS, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, 'help'], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1' },
  })
  expect(p.stdout.toString()).toContain('FACTORY_MAX_RUNS (16)')
})

// claude-factory-e8pb: a fork must not put a second run on the branch of a live source run.
test('fork of a live run is refused and makes nothing; after abort it works', () => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  const started = run(['start', factoryFixture(), r, 'a goal'])
  expect(started.code).toBe(0)
  const id = readdirSync(join(home, 'runs'))[0]!
  const before = readFileSync(calls, 'utf8')
  const refused = run(['fork', id, 'work', 'again'])
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain(`${id} is live at work`)
  expect(refused.err).toContain(`factory abort ${id}`)
  expect(readdirSync(join(home, 'runs'))).toHaveLength(1)
  expect(readFileSync(calls, 'utf8').slice(before.length)).not.toMatch(/^create|--claim/m)

  expect(run(['abort', id]).code).toBe(0)
  const forked = run(['fork', id, 'work', 'again'])
  expect(forked.err).toBe('')
  expect(forked.code).toBe(0)
  const ids = readdirSync(join(home, 'runs'))
  expect(ids).toHaveLength(2)
  const child = ids.find(x => x !== id)!
  expect(JSON.parse(readFileSync(join(home, 'runs', child, 'run.json'), 'utf8')).forkedFrom).toBe(id)
})

const CLEAR =
  'update acme-1 --remove-label owner --unset-metadata owner_question --unset-metadata owner_since'
const startHandedOff = (
  mode: string,
  args: string[] = [],
  marker?: () => string,
  env: Record<string, string> = {},
) => {
  reset()
  const r = repo()
  fakeBd('acme')
  fakeHerdr()
  writeFileSync(showMode, mode)
  if (marker) writeFileSync(marker(), '')
  const out = run(['start', factoryFixture(), r, 'acme-1', ...args], env)
  const log = existsSync(calls) ? readFileSync(calls, 'utf8') : ''
  const runs = existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0
  return { out, log, runs, updates: log.split('\n').filter(l => l.startsWith('update ')) }
}

// claude-factory-h1wj: a run that starts on a handed-off bead clears its owner label and keys
test('start of a handed-off bead clears the owner label and keys once, after the claim (claude-factory-h1wj)', () => {
  const t = startHandedOff('handed-off')
  expect(t.out.code).toBe(0)
  expect(t.runs).toBe(1)
  const clears = t.updates.filter(l => l.startsWith(CLEAR))
  expect(clears.length).toBe(1)
  expect(t.log.indexOf('--claim')).toBeGreaterThan(-1)
  expect(t.log.indexOf(CLEAR)).toBeGreaterThan(t.log.indexOf('--claim'))
})

test('start of a plain bead writes no owner clear (claude-factory-h1wj)', () => {
  const t = startHandedOff('found')
  expect(t.out.code).toBe(0)
  expect(t.log).not.toContain('--remove-label owner')
  expect(t.log).not.toContain('owner_question')
})

test('the owned gate is unchanged: a refused start clears nothing; --owned clears and never touches owner_decisions (claude-factory-h1wj)', () => {
  const refused = startHandedOff('owned-handed-off')
  expect(refused.out.code).not.toBe(0)
  expect(refused.out.err).toContain("carries its owner's decisions")
  expect(refused.updates.length).toBe(0)
  expect(refused.runs).toBe(0)

  const owned = startHandedOff('owned-handed-off', ['--owned'])
  expect(owned.out.code).toBe(0)
  expect(owned.updates.filter(l => l.startsWith(CLEAR)).length).toBe(1)
  expect(owned.updates.some(l => l.includes('owner_decisions'))).toBe(false)

  const patrol = startHandedOff('owned-handed-off', ['--owned'], undefined, { FACTORY_PATROL: '1' })
  expect(patrol.out.code).not.toBe(0)
  expect(patrol.updates.length).toBe(0)
})

test('a refused claim keeps the owner label (claude-factory-h1wj)', () => {
  const t = startHandedOff('handed-off', [], () => claimFail)
  expect(t.out.code).not.toBe(0)
  expect(t.out.err).toContain('already claimed')
  expect(t.log).not.toContain(CLEAR)
  expect(t.runs).toBe(0)
})

test('a failed owner clear warns but the start still succeeds (claude-factory-h1wj)', () => {
  const t = startHandedOff('handed-off', [], () => updateFail)
  expect(t.out.code).toBe(0)
  expect(t.runs).toBe(1)
  expect(t.out.err).toContain('acme-1')
  expect(t.out.err).toContain('owner')
})

test('a bead that keeps only the owner label, only owner_question or only owner_since is cleared too (claude-factory-h1wj)', () => {
  for (const mode of ['label-only', 'question-only', 'since-only']) {
    const t = startHandedOff(mode)
    expect(t.out.code).toBe(0)
    expect(t.updates.filter(l => l.startsWith(CLEAR)).length).toBe(1)
  }
})
