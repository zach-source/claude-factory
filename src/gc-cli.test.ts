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
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `gc-cli-${process.pid}`)
// A new home per test: detached tick children of an earlier test write into its old home, not the next one.
let homeN = 0
let home = join(dir, 'home')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1', ...env },
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

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'factory',
  GIT_AUTHOR_EMAIL: 'factory@localhost',
  GIT_COMMITTER_NAME: 'factory',
  GIT_COMMITTER_EMAIL: 'factory@localhost',
}
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...GIT_ENV } })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}
/** a clean git worktree on branch factory/<id>, registered in the shared repo at dir/repo */
function realWorktree(id: string): string {
  const repo = join(dir, 'repo')
  if (!existsSync(join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'root')
  }
  const wt = join(home, 'worktrees', id)
  git(repo, 'worktree', 'add', '-q', '-b', `factory/${id}`, wt)
  return wt
}
const tip = (id: string) => git(join(dir, 'repo'), 'rev-parse', `factory/${id}`)
const metricIds = () =>
  existsSync(join(home, 'metrics.jsonl'))
    ? readFileSync(join(home, 'metrics.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l).id as string)
    : []

/** builds run.json + state.json for one run, worked by the real xstate machine, then the run's own
 * files beside them: a `prompts/` dir, a brief, a stray backup, and a few names gc must keep. */
function writeRun(
  id: string,
  opts: { outcome: 'done' | 'aborted' | 'working'; finishedAt?: number; real?: boolean },
): string {
  const wt = opts.real ? realWorktree(id) : join(dir, id)
  mkdirSync(wt, { recursive: true })
  const d = runDir(id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo: opts.real ? join(dir, 'repo') : wt,
      goal: 'g',
      ws: 'w1',
      worktree: wt,
      branch: opts.real ? `factory/${id}` : 'b',
    }),
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
  home = join(dir, `home-${++homeN}`)
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

test('a run whose worktree gc cannot remove keeps its whole dir, artifacts included, and is named (AC2, lt4u AC5)', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY }) // a plain dir, not a git worktree
  const out = factory(['gc', '--days', '1'])
  expect(out.code).toBe(0)
  for (const name of ['prompts', 'f-implement.brief.md', 'rigs.json.before-123', 'run.json', 'state.json'])
    expect(existsSync(join(d, name))).toBe(true)
  expect(out.err + out.out).toContain(id)
  expect(metricIds()).toEqual([])
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

test('each reaped run gets one metrics.jsonl record line; a second pass adds none (AC6)', () => {
  reset()
  const id = freshId('ship')
  writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY, real: true })
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
  rmSync(join(d, 'prompts'), { recursive: true }) // as an older gc did

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
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 10 * DAY, real: true })
  mkdirSync(join(home, 'runs', 'zz-half-made'), { recursive: true }) // no run.json, no state.json
  const out = factory(['gc', '--days', '1'])
  expect(out.code).toBe(0)
  expect(existsSync(d)).toBe(false) // the eligible run was still reaped
  expect(out.err).toContain('zz-half-made') // the skipped dir is named, not silently dropped
})

// ---- claude-factory-lt4u: gc reaps a whole finished run, as `factory rm` does
test('lt4u AC1: an old done and an old aborted run lose dir and worktree; the branch tip and metrics stay', () => {
  reset()
  const a = freshId('ship')
  const b = `shop-${(Date.now() - 10 * DAY).toString(36)}xx` // an aborted run ages off its id time
  const old = Date.now() - 10 * DAY
  const da = writeRun(a, { outcome: 'done', finishedAt: old, real: true })
  const db = writeRun(b, { outcome: 'aborted', finishedAt: old, real: true })
  const tips = [tip(a), tip(b)]
  const out = factory(['gc'])
  expect(out.code).toBe(0)
  for (const [d, id] of [
    [da, a],
    [db, b],
  ] as const) {
    expect(existsSync(d)).toBe(false)
    expect(existsSync(join(home, 'worktrees', id))).toBe(false)
  }
  expect([tip(a), tip(b)]).toEqual(tips)
  expect(metricIds().sort()).toEqual([a, b].sort())
  expect(factory(['gc']).code).toBe(0) // a second pass adds no record
  expect(metricIds()).toHaveLength(2)
})

test('lt4u AC1: a run with no reproducible files, and one with its worktree already gone, are reaped', () => {
  reset()
  const a = freshId('ship')
  const b = freshId('shop')
  const old = Date.now() - 10 * DAY
  const da = writeRun(a, { outcome: 'done', finishedAt: old, real: true })
  for (const n of ['prompts', 'f-implement.brief.md', 'rigs.json.before-123'])
    rmSync(join(da, n), { recursive: true })
  const db = writeRun(b, { outcome: 'done', finishedAt: old, real: true })
  git(join(dir, 'repo'), 'worktree', 'remove', join(home, 'worktrees', b))
  expect(factory(['gc']).code).toBe(0)
  expect(existsSync(da)).toBe(false)
  expect(existsSync(db)).toBe(false)
  expect(metricIds().sort()).toEqual([a, b].sort())
})

test('lt4u AC2: age cutoff, FACTORY_GC_DAYS, and a live run stays', () => {
  reset()
  const id = freshId('ship')
  const live = freshId('live')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 3 * DAY, real: true })
  const dl = writeRun(live, { outcome: 'working', real: true })
  expect(factory(['gc']).code).toBe(0) // default 7 days: 3 days old stays
  expect(existsSync(d)).toBe(true)
  expect(factory(['gc'], { FACTORY_GC_DAYS: '2' }).code).toBe(0) // env cutoff
  expect(existsSync(d)).toBe(false)
  expect(existsSync(dl)).toBe(true)
  expect(existsSync(join(home, 'worktrees', live))).toBe(true)
})

test('lt4u AC2: --days overrides FACTORY_GC_DAYS', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: Date.now() - 3 * DAY, real: true })
  expect(factory(['gc', '--days', '9'], { FACTORY_GC_DAYS: '1' }).code).toBe(0)
  expect(existsSync(d)).toBe(true)
  expect(factory(['gc', '--days', '2'], { FACTORY_GC_DAYS: '9' }).code).toBe(0)
  expect(existsSync(d)).toBe(false)
})

test('lt4u AC3: --dry-run names the runs it would reap and changes nothing', () => {
  reset()
  const old = freshId('ship')
  const young = freshId('shop')
  const live = freshId('live')
  const d = writeRun(old, { outcome: 'done', finishedAt: Date.now() - 10 * DAY, real: true })
  writeRun(young, { outcome: 'done', finishedAt: Date.now() - 1 * DAY, real: true })
  writeRun(live, { outcome: 'working', real: true })
  const before = readdirSync(d).sort()
  const out = factory(['gc', '--dry-run'])
  expect(out.code).toBe(0)
  expect(out.out).toContain(`would reap ${old}`)
  expect(out.out).not.toContain(young)
  expect(out.out).not.toContain(live)
  expect(readdirSync(d).sort()).toEqual(before)
  expect(existsSync(join(home, 'worktrees', old))).toBe(true)
  expect(existsSync(join(home, 'metrics.jsonl'))).toBe(false)
  expect(existsSync(join(home, 'gc.log'))).toBe(false)
})

test('lt4u AC5: a refused run does not stop the next; the log names both; a metrics failure keeps the dir', () => {
  reset()
  const bad = freshId('aaa') // a plain dir, not a worktree: refused
  const good = freshId('zzz')
  const old = Date.now() - 10 * DAY
  const dbad = writeRun(bad, { outcome: 'done', finishedAt: old })
  const dgood = writeRun(good, { outcome: 'done', finishedAt: old, real: true })
  const out = factory(['gc'])
  expect(out.code).toBe(0)
  expect(existsSync(dbad)).toBe(true)
  expect(existsSync(dgood)).toBe(false)
  const log = readFileSync(join(home, 'gc.log'), 'utf8')
  expect(log).toContain(`refused ${bad}`)
  expect(log).toContain(`reaped ${good}`)
  expect(out.err + out.out).toContain(bad)

  // a metrics.jsonl that cannot be appended to: the run dir stays, a retry after repair succeeds
  const m = freshId('mmm')
  const dm = writeRun(m, { outcome: 'done', finishedAt: old, real: true })
  rmSync(join(home, 'metrics.jsonl'))
  mkdirSync(join(home, 'metrics.jsonl'))
  factory(['gc'])
  expect(existsSync(dm)).toBe(true)
  rmSync(join(home, 'metrics.jsonl'), { recursive: true })
  factory(['gc'])
  expect(existsSync(dm)).toBe(false)
  expect(metricIds()).toContain(m)
})

// ---- claude-factory-lt4u review rework
test('lt4u.4: run.json with an absent, null or empty worktree or repo is kept, with a reason', () => {
  reset()
  const old = Date.now() - 10 * DAY
  let n = 0
  for (const field of ['worktree', 'repo'])
    for (const v of ['absent', null, '']) {
      const id = freshId(`t${n++}x`)
      const d = writeRun(id, { outcome: 'done', finishedAt: old })
      const j = JSON.parse(readFileSync(join(d, 'run.json'), 'utf8'))
      if (v === 'absent') delete j[field]
      else j[field] = v
      if (field === 'repo') j.worktree = join(dir, 'gone-wt') // a missing worktree must not pass the check
      writeFileSync(join(d, 'run.json'), JSON.stringify(j))
      const out = factory(['gc'])
      expect(out.code).toBe(0)
      expect(existsSync(d)).toBe(true)
      expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(
        `refused ${id}: ${id}: run.json has no ${field}`,
      )
    }
  expect(existsSync(join(home, 'metrics.jsonl'))).toBe(false)
})

test('lt4u.5: a finishedAt of -Infinity (JSON -1e999) keeps the run', () => {
  reset()
  const id = freshId('ship')
  const at = Date.now() - 10 * DAY
  const d = writeRun(id, { outcome: 'done', finishedAt: at, real: true })
  const sp = join(d, 'state.json')
  const s = readFileSync(sp, 'utf8')
  expect(s).toContain(`"at":${at}`)
  writeFileSync(sp, s.replaceAll(`"at":${at}`, '"at":-1e999'))
  const out = factory(['gc', '--dry-run'])
  expect(out.out).not.toContain(`would reap ${id}`)
  expect(existsSync(d)).toBe(true)
})

test('lt4u.6: an unwritable gc.log does not change a removal result or stop the pass', () => {
  reset()
  const old = Date.now() - 10 * DAY
  const bad = freshId('aaa') // refused: a plain dir
  const good = freshId('zzz')
  const dbad = writeRun(bad, { outcome: 'done', finishedAt: old })
  const dgood = writeRun(good, { outcome: 'done', finishedAt: old, real: true })
  mkdirSync(join(home, 'gc.log'))
  const out = factory(['gc'])
  expect(out.code).toBe(0)
  expect(existsSync(dbad)).toBe(true)
  expect(existsSync(dgood)).toBe(false)
  expect(out.out).toContain(`refused ${bad}`)
  expect(out.out).toContain(`reaped ${good}`)
  expect(out.out).not.toContain(`refused ${good}`)
  expect(out.err).toContain('cannot write gc.log')
})

// ---- claude-factory-lt4u.7: plain gc safety rows (rm's rules, through the gc caller)
const OLD = () => Date.now() - 10 * DAY
const dirtyCases: [string, (wt: string) => void][] = [
  [
    'a dirty tracked file',
    wt => {
      writeFileSync(join(wt, 'f.txt'), 'one')
      git(wt, 'add', 'f.txt')
      git(wt, 'commit', '-q', '-m', 'f')
      writeFileSync(join(wt, 'f.txt'), 'two')
    },
  ],
  ['an untracked user file', wt => writeFileSync(join(wt, 'mine.txt'), 'keep me')],
  ['a locked worktree', wt => void git(wt, 'worktree', 'lock', wt)],
]
for (const [name, mutate] of dirtyCases) {
  test(`lt4u.7 AC4: plain gc keeps a run whose worktree has ${name}; dir, files and branch tip stay`, () => {
    reset()
    const id = freshId('ship')
    const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
    const wt = join(home, 'worktrees', id)
    mutate(wt)
    const t = tip(id)
    const out = factory(['gc'])
    expect(out.code).toBe(0)
    expect(existsSync(d)).toBe(true)
    expect(existsSync(wt)).toBe(true)
    expect(tip(id)).toBe(t)
    expect(metricIds()).not.toContain(id)
    expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(`refused ${id}`)
  })
}

test('lt4u.7 AC4: a clean worktree with a read-only file is removed by plain gc', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  const wt = join(home, 'worktrees', id)
  mkdirSync(join(wt, 'ro'))
  writeFileSync(join(wt, 'ro', 'x'), 'x')
  git(wt, 'add', 'ro/x')
  git(wt, 'commit', '-q', '-m', 'ro')
  chmodSync(join(wt, 'ro', 'x'), 0o444)
  chmodSync(join(wt, 'ro'), 0o555)
  expect(factory(['gc']).code).toBe(0)
  expect(existsSync(d)).toBe(false)
  expect(existsSync(wt)).toBe(false)
})

test('lt4u.7 AC1/AC3: the metrics record holds the run; --dry-run leaves file contents and branch tips', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  const snap = () =>
    readdirSync(d)
      .sort()
      .map(n => (statSync(join(d, n)).isFile() ? `${n}:${readFileSync(join(d, n), 'utf8')}` : n))
  const before = snap()
  const t = tip(id)
  expect(factory(['gc', '--dry-run']).code).toBe(0)
  expect(snap()).toEqual(before)
  expect(tip(id)).toBe(t)
  factory(['gc'])
  const rec = JSON.parse(readFileSync(join(home, 'metrics.jsonl'), 'utf8').trim().split('\n')[0]!)
  expect(rec.id).toBe(id)
  expect(Object.keys(rec).length).toBeGreaterThan(1)
})

test('lt4u.7 AC5: a metrics failure keeps each run and the pass goes on; log lines carry a timestamp', () => {
  reset()
  const a = freshId('aaa')
  const b = freshId('zzz')
  writeRun(a, { outcome: 'done', finishedAt: OLD(), real: true })
  const db = writeRun(b, { outcome: 'done', finishedAt: OLD(), real: true })
  mkdirSync(join(home, 'metrics.jsonl'))
  factory(['gc'])
  expect(existsSync(db)).toBe(true)
  const log = readFileSync(join(home, 'gc.log'), 'utf8')
  expect(log).toContain(`refused ${a}`)
  expect(log).toContain(`refused ${b}`)
  expect(log).toMatch(/^\d{4}-\d\d-\d\dT/m)
})

test('lt4u.4: a run.json that names another run is refused by gc, rm and gc --worktrees; nothing is removed', () => {
  reset()
  const src = freshId('aaa')
  const victim = freshId('zzz')
  const ds = writeRun(src, { outcome: 'working', real: true })
  const dv = writeRun(victim, { outcome: 'done', finishedAt: OLD(), real: true })
  const rj = join(ds, 'run.json')
  writeFileSync(rj, JSON.stringify({ ...JSON.parse(readFileSync(rj, 'utf8')), id: victim }))
  const wts = join(home, 'worktrees', src)
  const wtv = join(home, 'worktrees', victim)
  writeFileSync(join(wtv, 'mine.txt'), 'keep me')
  const ts = tip(src)
  const tv = tip(victim)
  const check = () => {
    for (const p of [ds, dv, wts, wtv, join(wtv, 'mine.txt')]) expect(existsSync(p)).toBe(true)
    expect(tip(src)).toBe(ts)
    expect(tip(victim)).toBe(tv)
    expect(metricIds()).not.toContain(src)
  }
  factory(['gc', '--dry-run'])
  check()
  factory(['gc'])
  check()
  expect(factory(['rm', src]).code).not.toBe(0)
  check()
  factory(['gc', '--worktrees'])
  check()
})
