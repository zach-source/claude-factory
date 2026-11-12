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
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { taskName } from './ax'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `gc-cli-${process.pid}`)
// A new home per test: detached tick children of an earlier test write into its old home, not the next one.
let homeN = 0
let home = join(dir, 'home')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const {
    FACTORY_OUTBOX,
    FACTORY_FROM,
    FACTORY_RUN,
    FACTORY_DEF_NAME,
    FACTORY_PATROL,
    BEADS_ACTOR,
    FACTORY_SERVER,
    ...laptop
  } = process.env
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

test('n69b2 AC3 AC4 positive decimal forms and flag order retain the preview stamp policy', () => {
  for (const days of ['7', '+7', '.5', '1.', '1e2']) {
    for (const args of [
      ['--days', days, '--dry-run'],
      ['--dry-run', '--days', days],
    ]) {
      reset()
      const result = factory(['gc', ...args])
      expect(result.code).toBe(0)
      expect(result.err).toBe('')
      expect(result.out).toContain('total: 0 files, 0 B across 0 run(s)')
      expect(existsSync(join(home, 'gc.stamp'))).toBe(true)
      expect(existsSync(join(home, 'metrics.jsonl'))).toBe(false)
      expect(existsSync(join(home, 'gc.log'))).toBe(false)
    }
  }
})

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

// ---- claude-factory-lt4u.7 rework: unsafe worktree paths through plain gc
/** rewrites fields of one run's run.json, so the run points at a path gc must not delete */
const repoint = (d: string, patch: Record<string, string>) => {
  const rj = join(d, 'run.json')
  writeFileSync(rj, JSON.stringify({ ...JSON.parse(readFileSync(rj, 'utf8')), ...patch }))
}
// each case returns the run.json patch and the dir that must keep its files. Each target is named for the run, so only its own guard refuses it.
const unsafeCases: [string, (id: string) => [Record<string, string>, string]][] = [
  [
    'a worktree outside the worktrees root',
    id => {
      const out = join(dir, 'outside', id)
      mkdirSync(out, { recursive: true })
      return [{ worktree: out }, out]
    },
  ],
  [
    'a worktree that is a symlink',
    id => {
      const real = join(home, 'worktrees', 'real', id)
      mkdirSync(real, { recursive: true })
      mkdirSync(join(home, 'worktrees', 'lnk'), { recursive: true })
      const link = join(home, 'worktrees', 'lnk', id)
      symlinkSync(real, link)
      return [{ worktree: link }, real]
    },
  ],
  [
    'a worktree named for another run',
    id => {
      const other = join(home, 'worktrees', 'other-name')
      mkdirSync(other, { recursive: true })
      return [{ worktree: other }, other]
    },
  ],
]
for (const [name, make] of unsafeCases) {
  test(`lt4u.7 AC4: plain gc keeps a run with ${name}; the target and the run dir stay`, () => {
    reset()
    const id = freshId('ship')
    const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
    const [patch, keep] = make(id)
    writeFileSync(join(keep, 'mine.txt'), 'keep me')
    repoint(d, patch)
    const t = tip(id)
    const out = traced(['gc'])
    expect(out.code).toBe(0)
    expect(existsSync(d)).toBe(true)
    expect(readFileSync(join(keep, 'mine.txt'), 'utf8')).toBe('keep me')
    expect(rmsUnder(out.calls, keep)).toEqual([])
    expect(rmsUnder(out.calls, d)).toEqual([])
    expect(appends(out.calls)).toEqual([])
    expect(tip(id)).toBe(t)
    expect(metricIds()).not.toContain(id)
    expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(`refused ${id}`)
  })
}

test('lt4u.7 AC4: an unreadable repo registration keeps a worktree dir with user files', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  const wt = join(home, 'worktrees', id)
  writeFileSync(join(wt, 'mine.txt'), 'keep me')
  repoint(d, { repo: join(dir, 'no-such-repo') })
  const out = traced(['gc'])
  expect(existsSync(d)).toBe(true)
  expect(readFileSync(join(wt, 'mine.txt'), 'utf8')).toBe('keep me')
  expect(metricIds()).not.toContain(id)
  expect(rmsUnder(out.calls, wt)).toEqual([])
  expect(rmsUnder(out.calls, d)).toEqual([])
  expect(appends(out.calls)).toEqual([])
})

test('lt4u.7 AC5: gc.log holds the reason and scrubs URL credentials', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  repoint(d, { worktree: '' })
  const bad = freshId('bad')
  const dbad = writeRun(bad, { outcome: 'done', finishedAt: OLD() })
  writeFileSync(join(dbad, 'state.json'), 'https://user:zqsecret@example.com/x not json')
  expect(factory(['gc']).code).toBe(0)
  const log = readFileSync(join(home, 'gc.log'), 'utf8')
  expect(log).toContain(`refused ${id}: ${id}: run.json has no worktree`)
  expect(log).toContain(`skipped ${bad}`)
  expect(log).not.toContain('zqsecret')
})

test('lt4u.7 AC1: the archived record keeps the node and the journal entry', () => {
  reset()
  const id = freshId('ship')
  const at = OLD()
  writeRun(id, { outcome: 'done', finishedAt: at, real: true })
  factory(['gc'])
  const rec = JSON.parse(readFileSync(join(home, 'metrics.jsonl'), 'utf8').trim().split('\n')[0]!)
  expect(rec.node).toBe('done')
  expect(rec.log.at(-1)).toMatchObject({ outcome: 'ready', summary: 's', at })
})

// ---- claude-factory-lt4u.7 rework 3: submodules, orphans, usage, live recheck, dry-run contents
const SUBPROTO = ['-c', 'protocol.file.allow=always']
/** adds a pushed submodule `sub` to the shared repo; call it before writeRun so run branches carry it */
function addSubmodule() {
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'root')
  const origin = join(dir, 'sub-origin.git')
  const src = join(dir, 'sub-src')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '-q', origin, src)
  git(src, 'commit', '-q', '--allow-empty', '-m', 'sub init')
  git(src, 'push', '-q', 'origin', 'HEAD:main')
  git(repo, ...SUBPROTO, 'submodule', 'add', '-q', origin, 'sub')
  git(repo, 'commit', '-q', '-m', 'add sub')
}
/** a done run with an initialised submodule; change runs on its worktree and the repo */
function subRun(change: (wt: string, repo: string, id: string) => void = () => {}) {
  reset()
  addSubmodule()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  const wt = join(home, 'worktrees', id)
  git(wt, ...SUBPROTO, 'submodule', 'update', '--init', '-q')
  change(wt, join(dir, 'repo'), id)
  return { id, d, wt }
}
const subKept = (name: string, change: (wt: string, repo: string, id: string) => void, kept?: string) =>
  test(`lt4u.7 AC4: plain gc keeps a worktree whose submodule ${name}`, () => {
    const { id, d, wt } = subRun(change)
    const t = tip(id)
    const out = traced(['gc'])
    expect(out.code).toBe(0)
    expect(rmsUnder(out.calls, wt)).toEqual([])
    expect(rmsUnder(out.calls, d)).toEqual([])
    expect(appends(out.calls)).toEqual([])
    expect(existsSync(d)).toBe(true)
    expect(existsSync(wt)).toBe(true)
    if (kept) expect(readFileSync(join(wt, kept), 'utf8')).toBe('u')
    expect(tip(id)).toBe(t)
    expect(metricIds()).not.toContain(id)
    expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(`refused ${id}`)
  })
subKept('has an untracked file', wt => writeFileSync(join(wt, 'sub', 'u.txt'), 'u'), 'sub/u.txt')
subKept('has a commit on no remote', wt =>
  git(join(wt, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'local'),
)
subKept('status read fails', (wt, repo, id) => {
  git(repo, 'config', 'submodule.sub.ignore', 'all')
  writeFileSync(join(repo, '.git', 'worktrees', id, 'modules', 'sub', 'index'), 'garbage')
})

test('lt4u.7 AC4: plain gc reaps a worktree with a clean pushed submodule and keeps the branch', () => {
  const { id, d, wt } = subRun()
  const t = tip(id)
  expect(factory(['gc']).code).toBe(0)
  expect(existsSync(d)).toBe(false)
  expect(existsSync(wt)).toBe(false)
  expect(tip(id)).toBe(t)
  expect(metricIds()).toContain(id)
})

test('lt4u.7 AC4: an unregistered dir with a live git dir is kept; one with a dead git dir link is reaped', () => {
  reset()
  const live = freshId('aaa')
  const dead = freshId('zzz')
  const dl = writeRun(live, { outcome: 'done', finishedAt: OLD(), real: true })
  const dd = writeRun(dead, { outcome: 'done', finishedAt: OLD(), real: true })
  const repo = join(dir, 'repo')
  for (const id of [live, dead]) git(repo, 'worktree', 'remove', '--force', join(home, 'worktrees', id))
  // the dirs come back as git no longer lists them
  const wl = join(home, 'worktrees', live)
  mkdirSync(join(wl, '.git'), { recursive: true }) // a git dir that still exists
  writeFileSync(join(wl, 'mine.txt'), 'keep me')
  const wd = join(home, 'worktrees', dead)
  mkdirSync(wd, { recursive: true })
  writeFileSync(join(wd, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', dead)}\n`)
  writeFileSync(join(wd, 'junk.txt'), 'x')
  const out = traced(['gc'])
  expect(out.code).toBe(0)
  // control: the dead-link dir is removed recursively; the live-gitdir dir and its run are not
  expect(rmsUnder(out.calls, wd).length).toBeGreaterThan(0)
  expect(rmsUnder(out.calls, wl)).toEqual([])
  expect(rmsUnder(out.calls, dl)).toEqual([])
  expect(existsSync(dl)).toBe(true)
  expect(readFileSync(join(wl, 'mine.txt'), 'utf8')).toBe('keep me')
  expect(existsSync(dd)).toBe(false)
  expect(existsSync(wd)).toBe(false)
  expect(metricIds()).toEqual([dead])
  expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(`refused ${live}`)
})

test('lt4u.7 AC1: the archived record holds the stored usage and the whole journal; no branch is deleted', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  const row = { node: 'implement', seq: 1, session: 's1', model: 'm1', input: 11, output: 22 }
  writeFileSync(join(d, 'usage.jsonl'), JSON.stringify(row) + '\n')
  const log = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).snapshot.context.log
  const branches = git(join(dir, 'repo'), 'for-each-ref', 'refs/heads')
  expect(factory(['gc']).code).toBe(0)
  const rec = JSON.parse(readFileSync(join(home, 'metrics.jsonl'), 'utf8').trim())
  expect(rec.sessions).toEqual([row])
  expect(rec.log).toEqual(log)
  expect(git(join(dir, 'repo'), 'for-each-ref', 'refs/heads')).toBe(branches)
})

test('lt4u.7 AC2: a run that turns live after the plan is kept by the recheck; the run before it is reaped', () => {
  reset()
  const a = freshId('aaa')
  const b = freshId('zzz')
  const da = writeRun(a, { outcome: 'done', finishedAt: OLD(), real: true })
  const db = writeRun(b, { outcome: 'done', finishedAt: OLD(), real: true })
  const live = writeRun(freshId('tmp'), { outcome: 'working' })
  const liveCopy = join(dir, 'live-state.json')
  writeFileSync(liveCopy, readFileSync(join(live, 'state.json'), 'utf8'))
  // a fake herdr: the first call is gc's plan read. The second is removeRun(a), which turns b live.
  const bin = join(dir, 'herdr.sh')
  const calls = join(dir, 'calls')
  writeFileSync(
    bin,
    `#!/bin/sh
echo x >> '${calls}'
if [ "$(wc -l < '${calls}')" -ge 2 ]; then cp '${liveCopy}' '${join(db, 'state.json')}'; fi
echo '{"result":{"panes":[]}}'
`,
    { mode: 0o755 },
  )
  const wtb = join(home, 'worktrees', b)
  const tb = tip(b)
  const out = traced(['gc'], { FACTORY_HERDR: bin })
  expect(out.code).toBe(0)
  // control: run a gets chmod, worktree remove, an archive append and a recursive removal. Run b gets none.
  const wta = join(home, 'worktrees', a)
  expect(spawned(out.calls, 'chmod', wta).length).toBe(1)
  expect(spawned(out.calls, 'worktree', 'remove', wta).length).toBe(1)
  expect(appends(out.calls).map(c => JSON.parse(c.data!).id)).toEqual([a])
  expect(rmsUnder(out.calls, da).length).toBeGreaterThan(0)
  expect(spawned(out.calls, 'chmod', wtb)).toEqual([])
  expect(spawned(out.calls, 'worktree', 'remove', wtb)).toEqual([])
  expect(rmsUnder(out.calls, db)).toEqual([])
  expect(rmsUnder(out.calls, wtb)).toEqual([])
  expect(existsSync(da)).toBe(false)
  expect(existsSync(db)).toBe(true)
  expect(existsSync(wtb)).toBe(true)
  expect(tip(b)).toBe(tb)
  expect(metricIds()).toEqual([a])
  expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(`refused ${b}`)
})

test('lt4u.7 AC3: --dry-run leaves nested run files, worktree contents, metrics and gc.log byte for byte', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  const wt = join(home, 'worktrees', id)
  mkdirSync(join(d, 'deep', 'er'), { recursive: true })
  writeFileSync(join(d, 'deep', 'er', 'f'), 'nested')
  writeFileSync(join(wt, 'mine.txt'), 'keep me')
  writeFileSync(join(home, 'metrics.jsonl'), '{"id":"old"}\n')
  writeFileSync(join(home, 'gc.log'), 'old line\n')
  const snap = () =>
    [d, wt, join(home, 'metrics.jsonl'), join(home, 'gc.log')].flatMap(root =>
      statSync(root).isFile()
        ? [`${root}:${readFileSync(root, 'utf8')}`]
        : (readdirSync(root, { recursive: true }) as string[])
            .sort()
            .map(
              p =>
                `${join(root, p)}:${statSync(join(root, p)).isFile() ? readFileSync(join(root, p), 'utf8') : 'dir'}`,
            ),
    )
  const before = snap()
  const t = tip(id)
  const out = traced(['gc', '--dry-run'])
  expect(out.out).toContain(`would reap ${id}`)
  expect(snap()).toEqual(before)
  expect(tip(id)).toBe(t)
  // the control test shows the trace sees each of these when a real reap runs
  expect(spawned(out.calls, 'chmod')).toEqual([])
  expect(spawned(out.calls, 'worktree', 'remove')).toEqual([])
  expect(appends(out.calls)).toEqual([])
  expect(rmsUnder(out.calls, d)).toEqual([])
  expect(rmsUnder(out.calls, wt)).toEqual([])
})

test('lt4u.9 AC1: a reap of a done and an aborted run issues no branch, ref, tag or remote command', () => {
  reset()
  const a = freshId('aaa')
  const b = `zzz-${OLD().toString(36)}xx` // an aborted run ages off its id time
  writeRun(a, { outcome: 'done', finishedAt: OLD(), real: true })
  writeRun(b, { outcome: 'aborted', finishedAt: OLD(), real: true })
  const refs = git(join(dir, 'repo'), 'for-each-ref')
  const out = traced(['gc'])
  expect(out.code).toBe(0)
  expect(spawned(out.calls, 'worktree', 'remove').length).toBe(2) // control: both reaped
  expect(metricIds()).toEqual([a, b])
  const gitCalls = out.calls.filter(c => c.op === 'spawn' && c.argv![0] === 'git')
  expect(gitCalls.length).toBeGreaterThan(0)
  const banned = [
    'branch',
    'update-ref',
    'push',
    'fetch',
    'remote',
    'tag',
    'symbolic-ref',
    'checkout',
    'switch',
  ]
  expect(gitCalls.filter(c => c.argv!.some(w => banned.includes(w)))).toEqual([])
  expect(git(join(dir, 'repo'), 'for-each-ref')).toBe(refs)
})

test('lt4u.9 AC5: the first archive append fails: its worktree goes, its run dir stays, the next run is archived; a retry finishes', () => {
  reset()
  const a = freshId('aaa')
  const b = freshId('zzz')
  const da = writeRun(a, { outcome: 'done', finishedAt: OLD(), real: true })
  const db = writeRun(b, { outcome: 'done', finishedAt: OLD(), real: true })
  const wta = join(home, 'worktrees', a)
  const ta = tip(a)
  const out = traced(['gc'], { GC_FAIL_FIRST_APPEND: '1' })
  expect(out.code).toBe(0)
  expect(appends(out.calls).length).toBe(2) // a failed, b went through
  expect(existsSync(wta)).toBe(false)
  expect(existsSync(da)).toBe(true)
  expect(rmsUnder(out.calls, da)).toEqual([]) // the run dir is never removed after a failed archive
  expect(existsSync(db)).toBe(false)
  expect(metricIds()).toEqual([b])
  const log = readFileSync(join(home, 'gc.log'), 'utf8')
  expect(log).toContain(`refused ${a}: injected append failure`)
  expect(log).toContain(`reaped ${b}`)
  // repaired: the retry archives a, removes its dir and keeps the branch
  expect(factory(['gc']).code).toBe(0)
  expect(existsSync(da)).toBe(false)
  expect(metricIds()).toEqual([b, a])
  expect(tip(a)).toBe(ta)
})

test('lt4u.7 AC5: one failing metrics record keeps its run; the next run is reaped', () => {
  reset()
  const a = freshId('aaa')
  const b = freshId('zzz')
  const da = writeRun(a, { outcome: 'done', finishedAt: OLD(), real: true })
  const db = writeRun(b, { outcome: 'done', finishedAt: OLD(), real: true })
  mkdirSync(join(da, 'usage.jsonl')) // record(a) cannot read its usage: only a fails
  expect(factory(['gc']).code).toBe(0)
  expect(existsSync(da)).toBe(true)
  expect(existsSync(db)).toBe(false)
  expect(metricIds()).toEqual([b])
  const log = readFileSync(join(home, 'gc.log'), 'utf8')
  expect(log).toContain(`refused ${a}`)
  expect(log).toContain(`reaped ${b}`)
})

// ---- claude-factory-lt4u.8: a call trace in the child process. A zero-call assertion needs a positive control.
type Call = {
  op: 'rm' | 'append' | 'spawn'
  path?: string
  recursive?: boolean
  data?: string
  argv?: string[]
}
// The preload wraps node:fs rmSync/appendFileSync (metrics.jsonl only) and Bun.spawnSync, then calls the real ones.
// GC_FAIL_ARGV (a JSON array) makes a spawn whose argv holds every element exit 128. GC_FAIL_FIRST_APPEND fails the first metrics append.
const PRELOAD = `import { mock } from 'bun:test'
import * as real from 'node:fs'
const fs: any = { ...real }
const T = process.env.GC_TRACE!
const log = (o: object) => fs.appendFileSync(T, JSON.stringify(o) + '\\n')
let failed = false
mock.module('node:fs', () => ({
  ...fs,
  default: { ...fs },
  rmSync: (p: any, o: any) => {
    const sfx = process.env.GC_FAIL_RM_SUFFIX
    if (sfx && String(p).endsWith(sfx)) throw new Error('injected rm failure')
    log({ op: 'rm', path: String(p), recursive: !!o?.recursive })
    return fs.rmSync(p, o)
  },
  appendFileSync: (p: any, d: any, o: any) => {
    if (String(p).endsWith('metrics.jsonl')) {
      log({ op: 'append', path: String(p), data: String(d) })
      if (process.env.GC_FAIL_FIRST_APPEND && !failed) {
        failed = true
        throw new Error('injected append failure')
      }
    }
    return fs.appendFileSync(p, d, o)
  },
}))
const spawn: any = Bun.spawnSync.bind(Bun)
;(Bun as any).spawnSync = (a: any, ...r: any[]) => {
  const argv: string[] = Array.isArray(a) ? a : a.cmd
  log({ op: 'spawn', argv })
  const need: string[] = JSON.parse(process.env.GC_FAIL_ARGV ?? '[]')
  if (need.length && need.every(n => argv.includes(n)))
    return { exitCode: 128, success: false, stdout: Buffer.from(''), stderr: Buffer.from('injected failure') }
  return spawn(a, ...r)
}
`
function traced(args: string[], env: Record<string, string> = {}) {
  const pre = join(dir, 'trace-pre.ts')
  const tf = join(dir, 'trace.jsonl')
  writeFileSync(pre, PRELOAD)
  rmSync(tf, { force: true })
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync(['bun', '--preload', pre, join(import.meta.dir, 'cli.ts'), ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_NO_KICK: '1',
      GC_TRACE: tf,
      ...env,
    },
  })
  const calls: Call[] = existsSync(tf)
    ? readFileSync(tf, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), calls }
}
/** recursive removals at or below a path (the lock file removal is not recursive) */
const rmsUnder = (calls: Call[], p: string) =>
  calls.filter(c => c.op === 'rm' && c.recursive && (c.path === p || c.path!.startsWith(p + '/')))
const spawned = (calls: Call[], ...words: string[]) =>
  calls.filter(c => c.op === 'spawn' && words.every(w => c.argv!.includes(w)))
const appends = (calls: Call[]) => calls.filter(c => c.op === 'append')

test('lt4u.8 control: the trace sees the removals, the worktree remove and the archive append of a real reap', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  const wt = join(home, 'worktrees', id)
  const out = traced(['gc'])
  expect(out.code).toBe(0)
  expect(rmsUnder(out.calls, d).length).toBeGreaterThan(0)
  expect(spawned(out.calls, 'worktree', 'remove', wt).length).toBe(1)
  expect(spawned(out.calls, 'chmod', wt).length).toBe(1)
  expect(appends(out.calls).filter(c => c.data!.includes(id)).length).toBe(1)
})

test('lt4u.8 AC4: an unlisted worktree dir that holds the repo is refused after the root and name checks', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD() })
  const wt = join(home, 'worktrees', id)
  const repo = join(wt, 'inner-repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(wt, 'mine.txt'), 'keep me')
  repoint(d, { worktree: wt, repo })
  const out = traced(['gc'])
  expect(out.code).toBe(0)
  expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(
    `refused ${id}: refusing to delete ${wt}: the repo itself`,
  )
  expect(readFileSync(join(wt, 'mine.txt'), 'utf8')).toBe('keep me')
  expect(existsSync(d)).toBe(true)
  expect(metricIds()).not.toContain(id)
  expect(appends(out.calls)).toEqual([])
  expect(rmsUnder(out.calls, wt)).toEqual([])
  expect(rmsUnder(out.calls, d)).toEqual([])
})

test('lt4u.8 AC4: a failed git worktree list for a valid repo keeps the worktree, the run and the branch', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'done', finishedAt: OLD(), real: true })
  const wt = join(home, 'worktrees', id)
  writeFileSync(join(wt, 'mine.txt'), 'keep me')
  const t = tip(id)
  const out = traced(['gc'], { GC_FAIL_ARGV: JSON.stringify(['worktree', 'list']) })
  expect(out.code).toBe(0)
  expect(spawned(out.calls, 'worktree', 'list').length).toBeGreaterThan(0)
  expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(`refused ${id}`)
  expect(readFileSync(join(wt, 'mine.txt'), 'utf8')).toBe('keep me')
  expect(existsSync(d)).toBe(true)
  expect(tip(id)).toBe(t)
  expect(metricIds()).not.toContain(id)
  expect(spawned(out.calls, 'worktree', 'remove')).toEqual([])
  expect(appends(out.calls)).toEqual([])
  expect(rmsUnder(out.calls, wt)).toEqual([])
  expect(rmsUnder(out.calls, d)).toEqual([])
})

test('lt4u.8 AC4: a failed top-level status after a clean submodule check keeps the worktree and does not force', () => {
  const { id, d, wt } = subRun()
  writeFileSync(join(wt, 'mine.txt'), 'keep me')
  const t = tip(id)
  const out = traced(['gc'], {
    GC_FAIL_ARGV: JSON.stringify(['status', '--porcelain', '--ignore-submodules=none']),
  })
  expect(out.code).toBe(0)
  // positive control: the failing status call ran, so the clean-submodule check had passed
  expect(spawned(out.calls, 'status', '--ignore-submodules=none').length).toBe(1)
  expect(spawned(out.calls, 'worktree', 'remove', '--force')).toEqual([])
  expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(`refused ${id}`)
  expect(readFileSync(join(wt, 'mine.txt'), 'utf8')).toBe('keep me')
  expect(existsSync(d)).toBe(true)
  expect(tip(id)).toBe(t)
  expect(metricIds()).not.toContain(id)
  expect(appends(out.calls)).toEqual([])
  expect(rmsUnder(out.calls, wt)).toEqual([])
  expect(rmsUnder(out.calls, d)).toEqual([])
})

// sris: gc removes the memory snapshots of earlier tasks (and of finished runs), 1 h old or more.
const aged = (path: string, ageMs = 2 * 3_600_000) => {
  writeFileSync(path, 'tgz')
  const t = new Date(Date.now() - ageMs)
  utimesSync(path, t, t)
}
const seqOf = (d: string): number =>
  JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).snapshot.context.seq
const tgz = (d: string) => readdirSync(d).filter(n => n.endsWith('.memory.tgz'))

test('sris AC1: a live run with two failed launches keeps only the current snapshot after gc', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'working' })
  const cur = `${taskName(id, seqOf(d))}.memory.tgz`
  for (const n of ['f-a-1.memory.tgz', 'f-a-2.memory.tgz', cur]) aged(join(d, n))
  const out = factory(['gc'])
  expect(out.code).toBe(0)
  expect(tgz(d)).toEqual([cur])
})

test('sris AC2: a finished run younger than the cutoff loses its old snapshots and keeps the rest', () => {
  reset()
  const a = freshId('ship')
  const b = `shop-${(Date.now() - DAY).toString(36)}xx`
  const da = writeRun(a, { outcome: 'done', finishedAt: Date.now() - DAY })
  const db = writeRun(b, { outcome: 'aborted', finishedAt: Date.now() - DAY })
  for (const d of [da, db]) for (const n of ['f-a-1.memory.tgz', 'f-a-2.memory.tgz']) aged(join(d, n))
  const before = [da, db].map(d =>
    readdirSync(d)
      .filter(n => !n.endsWith('.memory.tgz'))
      .sort(),
  )
  expect(factory(['gc']).code).toBe(0)
  for (const [i, d] of [da, db].entries()) {
    expect(tgz(d)).toEqual([])
    expect(readdirSync(d).sort()).toEqual(before[i]!)
  }
})

test('sris AC4: --dry-run counts old snapshots and removes none', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'working' })
  aged(join(d, 'f-a-1.memory.tgz'))
  const out = factory(['gc', '--dry-run'])
  expect(out.code).toBe(0)
  expect(out.out).toMatch(/memory: 1 files?,/)
  expect(out.out).toMatch(/total: 1 files?,.*across 1 run/)
  expect(out.out).toContain(`would remove ${id}/f-a-1.memory.tgz`)
  expect(tgz(d)).toEqual(['f-a-1.memory.tgz'])
})

test('sris AC5: gc.log names each removed snapshot', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'working' })
  aged(join(d, 'f-a-1.memory.tgz'))
  const out = factory(['gc'])
  const line = `removed memory snapshot ${id}/f-a-1.memory.tgz`
  expect(out.out).toContain(line)
  expect(readFileSync(join(home, 'gc.log'), 'utf8')).toContain(line)
})

test('sris AC5: a snapshot that cannot be removed does not stop the pass', () => {
  reset()
  const id = freshId('ship')
  const d = writeRun(id, { outcome: 'working' })
  aged(join(d, 'f-boom.memory.tgz'))
  aged(join(d, 'f-ok.memory.tgz'))
  const old = `shop-${(Date.now() - 10 * DAY).toString(36)}xx`
  const dold = writeRun(old, { outcome: 'done', finishedAt: Date.now() - 10 * DAY, real: true })
  const out = traced(['gc'], { GC_FAIL_RM_SUFFIX: 'f-boom.memory.tgz' })
  expect(out.code).toBe(0)
  expect(out.out).toContain(`cannot remove memory snapshot ${id}/f-boom.memory.tgz: injected rm failure`)
  expect(out.out).toContain(`removed memory snapshot ${id}/f-ok.memory.tgz`)
  expect(tgz(d)).toEqual(['f-boom.memory.tgz'])
  expect(existsSync(dold)).toBe(false)
})
