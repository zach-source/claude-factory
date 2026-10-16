// Tests for `factory gc` end to end (claude-factory-503.1.3). This covers the CLI case beside `rm`,
// the strict herdr pane read, the lock, and the metrics line gc appends.
//
// src/gc.test.ts proves gcPlan() itself is correct. These tests prove cli.ts wires real run
// directories, a real herdr and the lock into it the way the acceptance criteria name.
//
// These tests drive the real CLI against on-disk fixtures. The fixtures come from the real
// machine, like src/watch.test.ts and src/records.test.ts do.
import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `gc-cli-${process.pid}`)
const home = join(dir, 'home')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}

const runDir = (id: string) => join(home, 'runs', id)
// createdAt(id) parses the id's own trailing "-<base36 time>xx" suffix: a bare id parses to NaN
const freshId = (name: string) => `${name}-${Date.now().toString(36)}xx`

/** builds run.json + state.json for one run, worked by the real xstate machine, then the run's own
 * files beside them: a `prompts/` dir, a brief, a stray backup, and a few names gc must keep. */
function writeRun(
  id: string,
  opts: { outcome: 'done' | 'aborted' | 'working'; finishedAt?: number },
): string {
  const wt = join(dir, id)
  mkdirSync(wt, { recursive: true })
  const d = runDir(id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: factoryFile, repo: wt, goal: 'g', ws: 'w1', worktree: wt, branch: 'b' }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  if (opts.outcome === 'done')
    actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 's', at: opts.finishedAt ?? 0 })
  else if (opts.outcome === 'aborted') actor.send({ type: 'ABORT', at: opts.finishedAt ?? 0 })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))

  mkdirSync(join(d, 'prompts'), { recursive: true })
  writeFileSync(join(d, 'prompts', `${seq}-implement.md`), 'the brief')
  writeFileSync(join(d, `f-implement.brief.md`), 'ax copy')
  writeFileSync(join(d, `rigs.json.before-123`), 'stray backup')
  writeFileSync(join(d, 'inbox.jsonl'), '')
  writeFileSync(join(d, 'track.json'), '{}')
  writeFileSync(join(d, 'progress.json'), '{}')
  return d
}

const reset = () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
}

const DAY = 24 * 3_600_000

test('--dry-run prints bytes per kind and the run count, and deletes nothing (AC1)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY })
  const before = readdirSync(d).sort()
  const out = factory(['gc', '--days', '1', '--dry-run'])
  expect(out.code).toBe(0)
  expect(out.out).toMatch(/prompts: 1 files?,/)
  expect(out.out).toMatch(/briefs: 1 files?,/)
  expect(out.out).toMatch(/backups: 1 files?,/)
  expect(out.out).toMatch(/launch: 0 files?,/)
  expect(out.out).toMatch(/total: 3 files?,.*across 1 run/)
  expect(readdirSync(d).sort()).toEqual(before) // byte-identical: nothing removed
})

test('a real pass removes prompts/, the brief and the stray backup; every kept name stays (AC2)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY })
  const promptNames = readdirSync(join(d, 'prompts'))
  const out = factory(['gc', '--days', '1'])
  expect(out.code).toBe(0)
  expect(existsSync(join(d, 'prompts'))).toBe(false)
  expect(existsSync(join(d, 'f-implement.brief.md'))).toBe(false)
  expect(existsSync(join(d, 'rigs.json.before-123'))).toBe(false)
  for (const name of ['run.json', 'state.json', 'inbox.jsonl', 'track.json', 'progress.json', 'factory.ts'])
    expect(existsSync(join(d, name))).toBe(true)
  // prompts.list keeps the names prompts/ held, so sessionsOf() still names each session's station (AC8)
  expect(existsSync(join(d, 'prompts.list'))).toBe(true)
  expect(JSON.parse(readFileSync(join(d, 'prompts.list'), 'utf8')).sort()).toEqual(promptNames.sort())
})

test('an aborted run with no journal entry still ages off createdAt(id) (AC2)', () => {
  reset()
  const id = freshId('ship') // created "now": not yet old enough at --days 1
  const d = writeRun(id, { outcome: 'aborted' })
  expect(factory(['gc', '--days', '1']).code).toBe(0)
  expect(existsSync(join(d, 'prompts'))).toBe(true) // too young: untouched
})

test('a still-running run is byte-identical after gc, even 30 days old (AC3)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'working' })
  // backdate every file so an mtime-based (wrong) rule would also prune it
  const old = new Date(Date.now() - 30 * DAY)
  for (const name of readdirSync(d)) utimesSync(join(d, name), old, old)
  const before = readdirSync(d).sort()
  const out = factory(['gc', '--days', '1'])
  expect(out.code).toBe(0)
  expect(readdirSync(d).sort()).toEqual(before)
  expect(existsSync(join(d, 'prompts'))).toBe(true)
})

test('a done run younger than the cutoff is untouched (AC4)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 1 * DAY })
  const out = factory(['gc', '--days', '7'])
  expect(out.code).toBe(0)
  expect(existsSync(join(d, 'prompts'))).toBe(true)
})

const writeLaunchScript = (pane: string, ageMs: number) => {
  const ldir = join(home, 'launch')
  mkdirSync(ldir, { recursive: true })
  const f = join(ldir, `${pane}.sh`)
  writeFileSync(f, 'export FOO=bar\n')
  const at = new Date(Date.now() - ageMs)
  utimesSync(f, at, at)
  return f
}

test('herdr missing: no launch script removed, and gc says so (AC5)', () => {
  reset()
  const f = writeLaunchScript('deadpane', 2 * 3_600_000)
  const out = factory(['gc'], { FACTORY_HERDR: join(dir, 'no-such-herdr') })
  expect(out.code).toBe(0)
  expect(existsSync(f)).toBe(true)
  expect(out.out).toContain('removed no launch script')
})

test('herdr installed but its call fails: no launch script removed (AC5)', () => {
  reset()
  const f = writeLaunchScript('deadpane', 2 * 3_600_000)
  const badHerdr = join(dir, 'bad-herdr')
  writeFileSync(badHerdr, '#!/bin/sh\nexit 1\n')
  chmodSync(badHerdr, 0o755)
  const out = factory(['gc'], { FACTORY_HERDR: badHerdr })
  expect(out.code).toBe(0)
  expect(existsSync(f)).toBe(true)
  expect(out.out).toContain('removed no launch script')
})

// Here herdr prints a well-formed, empty pane list, then exits with code 1.
// The exit code alone must set the result to null. The shape of stdout must not change this.
// An empty list and a missing exit check give the same safe result here, by chance.
// The real risk is a herdr that exits nonzero after it drops a pane that is in fact live.
// This test pins the exit code as the one true signal.
test('herdr exits nonzero even with a well-formed pane list on stdout: no launch script removed (AC5)', () => {
  reset()
  const f = writeLaunchScript('deadpane', 2 * 3_600_000)
  const badHerdr = join(dir, 'bad-herdr-2')
  writeFileSync(badHerdr, `#!/bin/sh\nprintf '{"result":{"panes":[]}}\\n'\nexit 1\n`)
  chmodSync(badHerdr, 0o755)
  const out = factory(['gc'], { FACTORY_HERDR: badHerdr })
  expect(out.code).toBe(0)
  expect(existsSync(f)).toBe(true)
  expect(out.out).toContain('removed no launch script')
})

test('a working herdr: a dead pane old enough is removed, a live one and a young dead one are kept (AC5)', () => {
  reset()
  const dead = writeLaunchScript('dead', 2 * 3_600_000) // 2h dead: past LAUNCH_MIN_AGE_MS (1h)
  const young = writeLaunchScript('young', 10 * 60_000) // 10 min dead: not yet
  const live = writeLaunchScript('live', 2 * 3_600_000) // old, but herdr still lists its pane
  const okHerdr = join(dir, 'ok-herdr')
  writeFileSync(
    okHerdr,
    `#!/bin/sh\ncase "$1 $2" in\n  "pane list") printf '{"result":{"panes":[{"pane_id":"live"}]}}\\n' ;;\n  *) echo '{}' ;;\nesac\n`,
  )
  chmodSync(okHerdr, 0o755)
  const out = factory(['gc'], { FACTORY_HERDR: okHerdr })
  expect(out.code).toBe(0)
  expect(existsSync(dead)).toBe(false)
  expect(existsSync(young)).toBe(true)
  expect(existsSync(live)).toBe(true)
})

test('each pruned run gets one metrics.jsonl record line; a second pass adds none (AC6)', () => {
  reset()
  const id = freshId('ship')
  writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY })
  expect(factory(['gc', '--days', '1']).code).toBe(0)
  const metricsFile = join(home, 'metrics.jsonl')
  const linesAfterFirst = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
  expect(linesAfterFirst).toHaveLength(1)
  expect(JSON.parse(linesAfterFirst[0]!)).toMatchObject({ id, node: 'done' })
  expect(factory(['gc', '--days', '1']).code).toBe(0) // nothing left to prune for this run
  const linesAfterSecond = readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean)
  expect(linesAfterSecond).toHaveLength(1)
})

test('a non-positive or non-numeric --days fails, deleting nothing (AC10)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY })
  for (const bad of ['0', '-1', 'nope']) {
    const out = factory(['gc', '--days', bad])
    expect(out.code).toBe(1)
    expect(existsSync(join(d, 'prompts'))).toBe(true)
  }
})

test('a second gc that finds gc.lock already held exits 0 with a note, deleting nothing (AC10)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY })
  mkdirSync(join(home, 'gc.lock'))
  writeFileSync(join(home, 'gc.lock', 'pid'), String(process.pid)) // this test process: alive
  const out = factory(['gc', '--days', '1'])
  expect(out.code).toBe(0)
  expect(out.out).toContain('already running')
  expect(existsSync(join(d, 'prompts'))).toBe(true)
})

// PR #59 review finding 1 (claude-factory-503.1.5). gc removes runs/<id>/prompts/. `goto` can then
// revive the run. spawn() and resumeFile() write into prompts/ with no mkdir. The revived run must
// still start a worker, with no ENOENT.
test('a goto revive after gc recreates prompts/ and starts a worker with no ENOENT (claude-factory-503.1.5)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY })
  expect(factory(['gc', '--days', '1']).code).toBe(0)
  expect(existsSync(join(d, 'prompts'))).toBe(false) // gc removed it

  expect(factory(['goto', id, 'implement']).code).toBe(0) // queues a GOTO; the next tick drains it

  const okHerdr = join(dir, 'ok-herdr-revive')
  writeFileSync(
    okHerdr,
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "tab create") printf \'{"result":{"root_pane":{"pane_id":"p1"}}}\\n\' ;;',
      '  "pane run") exit 0 ;;',
      "  *) echo '{}' ;;",
      'esac',
    ].join('\n'),
  )
  chmodSync(okHerdr, 0o755)
  const out = factory(['tick'], {
    FACTORY_HERDR: okHerdr,
    // no .claude.json at this path: isTrusted() hits its catch branch and reads as trusted, so the
    // worker starts instead of parking at "awaiting trust" (see start.test.ts for the opposite case)
    CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config'),
    // tick's own finally block would otherwise kick a detached `factory gc` at this same FACTORY_HOME,
    // which outlives this test and races the next test's own gc fixtures
    FACTORY_GC: '0',
  })
  expect(out.code).toBe(0)
  const row = JSON.parse(out.out).runs.find((r: { id: string }) => r.id === id)
  expect(row.error).toBeFalsy()
  expect(row.pane).toBe('p1')
  expect(existsSync(join(d, 'prompts'))).toBe(true) // recreated, not left missing
  expect(readdirSync(join(d, 'prompts'))).toContain('2-implement.md')
})

// PR #59 review finding 1's sibling write site (claude-factory-503.1.5). resumeFile() writes into
// prompts/ too, on the branch where a pane goes missing and the run resumes by session. This can
// run with no prior goto or gc: build that state directly and remove prompts/ by hand.
test('resumeFile() recreates prompts/ before writing the resume note (claude-factory-503.1.5)', () => {
  reset()
  const id = freshId('ship')
  const wt = join(dir, id)
  mkdirSync(wt, { recursive: true })
  const d = runDir(id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: factoryFile, repo: wt, goal: 'g', ws: 'w1', worktree: wt, branch: 'b' }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  // a worker already spawned and reported its session, as a real run does before its pane dies
  actor.send({ type: 'SPAWNED', seq, pane: 'oldpane', at: 0 })
  actor.send({ type: 'SESSION', seq, session: 's1', at: 0 })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
  writeFileSync(join(d, 'track.json'), '{}')
  writeFileSync(join(d, 'progress.json'), '{}')
  // no prompts/ dir at all here: proves resumeFile()'s own mkdir, not spawn()'s

  const okHerdr = join(dir, 'ok-herdr-resume')
  writeFileSync(
    okHerdr,
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "pane get") printf \'{"error":{"code":"pane_not_found"}}\\n\' ;;',
      '  "tab create") printf \'{"result":{"root_pane":{"pane_id":"p2"}}}\\n\' ;;',
      '  "pane run") exit 0 ;;',
      "  *) echo '{}' ;;",
      'esac',
    ].join('\n'),
  )
  chmodSync(okHerdr, 0o755)
  // FACTORY_GC=0: tick's own finally block would otherwise kick a detached `factory gc` at this
  // same FACTORY_HOME, which outlives this test and races the next test's own gc fixtures
  const out = factory(['tick'], { FACTORY_HERDR: okHerdr, FACTORY_GC: '0' })
  expect(out.code).toBe(0)
  const row = JSON.parse(out.out).runs.find((r: { id: string }) => r.id === id)
  expect(row.error).toBeFalsy()
  expect(existsSync(join(d, 'prompts'))).toBe(true)
  expect(readdirSync(join(d, 'prompts'))).toContain(`${seq}-implement-resume.md`)
})

// PR #59 review finding 2 (claude-factory-503.1.6). One run dir gc cannot read (removed mid-pass, or
// never finished writing run.json/state.json) must not stop the whole pass. Before this fix,
// runFact() threw inside runIds().map() with no per-run catch: gc exited 1 and pruned nothing.
test('a half-made run dir beside an eligible run does not stop the pass (claude-factory-503.1.6)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY })
  mkdirSync(join(home, 'runs', 'zz-half-made'), { recursive: true }) // no run.json, no state.json
  const out = factory(['gc', '--days', '1'])
  expect(out.code).toBe(0)
  expect(existsSync(join(d, 'prompts'))).toBe(false) // the eligible run was still pruned
  expect(out.err).toContain('zz-half-made') // the skipped dir is named, not silently dropped
})
