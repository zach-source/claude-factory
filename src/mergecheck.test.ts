// mergeCheck (claude-factory-92ha): before a fresh worker starts, the runner merge-trees the run's
// pushed branch into origin's default branch. A text conflict sends the run back with no worker.
// conflictsOf runs against a real temp bare origin and a clone; the tick tests drive the real CLI.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { conflictsOf } from './cli'
import { compile, where, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `mergecheck-${process.pid}`)
const home = join(dir, 'home')
const origin = join(dir, 'origin.git')
const clone = join(dir, 'clone')
const other = join(dir, 'other')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args])
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

/** origin with main (CHANGELOG.md, other.txt); branch b pushed from `other`; clone has neither fetched */
function setup(conflict: boolean) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', origin])
  Bun.spawnSync(['git', 'clone', '-q', origin, other])
  writeFileSync(join(other, 'CHANGELOG.md'), 'base\n')
  writeFileSync(join(other, 'other.txt'), 'base\n')
  git(other, 'add', '.')
  git(other, 'commit', '-qm', 'base')
  git(other, 'push', '-q', 'origin', 'HEAD:main')
  Bun.spawnSync(['git', 'clone', '-q', origin, clone])
  git(other, 'checkout', '-qb', 'b')
  writeFileSync(join(other, 'CHANGELOG.md'), 'branch\n')
  git(other, 'commit', '-qam', 'branch')
  git(other, 'push', '-q', 'origin', 'b')
  git(other, 'checkout', '-q', 'main')
  writeFileSync(join(other, conflict ? 'CHANGELOG.md' : 'other.txt'), 'main\n')
  git(other, 'commit', '-qam', 'main moves')
  git(other, 'push', '-q', 'origin', 'main')
}

test('conflictsOf lists the conflicting files, and gives [] for a clean merge', () => {
  setup(true)
  expect(conflictsOf(clone, 'main', 'b')).toEqual(['CHANGELOG.md'])
  setup(false)
  expect(conflictsOf(clone, 'main', 'b')).toEqual([])
}, 60_000)

test('conflictsOf fails open (AC3)', () => {
  setup(true)
  expect(conflictsOf(clone, 'main', 'nobranch')).toEqual([]) // branch not on origin
  expect(conflictsOf(join(dir, 'missing'), 'main', 'b')).toEqual([]) // no repo
  git(clone, 'remote', 'set-url', 'origin', join(dir, 'gone.git'))
  expect(conflictsOf(clone, 'main', 'b')).toEqual([]) // fetch fails
}, 60_000)

const factoryDef = (mergeCheck: boolean): Factory => ({
  name: 'mc',
  start: 'implement',
  nodes: {
    implement: { prompt: 'x', agent: 'true', next: { ready: 'verify' } },
    verify: {
      prompt: 'x',
      agent: 'true',
      ...(mergeCheck && { mergeCheck: 'red' }),
      next: { green: 'done', red: 'implement' },
    },
  },
})

/** a run at verify, working, with no pane */
function verifyRun(def: Factory) {
  const f = join(dir, 'mc.json')
  writeFileSync(f, JSON.stringify(def))
  const actor = createActor(compile(def)).start()
  actor.send({ type: 'GOTO', node: 'verify', at: 0 })
  const d = join(home, 'runs', 'r1')
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id: 'r1', factory: f, repo: clone, goal: 'g', ws: 'ws1', worktree: clone, branch: 'b' }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
}

const tick = () => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...env } = process.env
  Bun.spawnSync([CLI, 'tick'], { env: { ...env, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' } })
  return JSON.parse(readFileSync(join(home, 'runs', 'r1', 'state.json'), 'utf8')).snapshot
}

test('a conflicting branch goes back to implement with the mail and no launch (AC1)', () => {
  setup(true)
  mkdirSync(home, { recursive: true })
  verifyRun(factoryDef(true))
  const snap = tick()
  const ctx = snap.context
  expect(where(snap.value)[0]).toBe('implement')
  expect(ctx.log.at(-1)).toMatchObject({ node: 'verify', outcome: 'red' })
  const text =
    'merge origin/main into b; conflicts in: CHANGELOG.md; keep both sides of CHANGELOG.md [Unreleased]'
  expect(ctx.log.at(-1).summary).toBe(`no worker: ${text}`)
  expect(ctx.mail.implement.at(-1).text).toContain(text)
  expect(existsSync(join(home, 'launches.jsonl'))).toBe(false)
}, 60_000)

test('a station without mergeCheck runs no fetch (AC4)', () => {
  setup(true)
  mkdirSync(home, { recursive: true })
  verifyRun(factoryDef(false))
  tick()
  expect(existsSync(join(clone, '.git', 'refs', 'remotes', 'origin', 'b'))).toBe(false)
}, 60_000)
