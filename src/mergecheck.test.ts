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

const factoryDef = (mergeCheck: boolean, params?: Record<string, string>): Factory => ({
  name: 'mc',
  start: 'implement',
  ...(params && { params }),
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
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...env } = process.env
  Bun.spawnSync([CLI, 'tick'], {
    env: { ...env, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1' },
  })
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
  const head = git(clone, 'rev-parse', '--short', 'origin/b').trim()
  const text = `merge origin/main into b at ${head}; conflicts in: CHANGELOG.md; keep both sides of CHANGELOG.md [Unreleased]`
  expect(ctx.log.at(-1).summary).toBe(`no worker: ${text}`)
  expect(ctx.mail.implement.at(-1).text).toContain(text)
  expect(existsSync(join(home, 'launches.jsonl'))).toBe(false)
}, 60_000)

// claude-factory-ldq9 AC5: the rig's base_branch param, not only origin/HEAD, picks the branch mergeCheck merges against
test('mergeCheck merge-trees against the rig base_branch: clean against deploy, red against main, red against a conflicting deploy', () => {
  const rigWith = (params: object) =>
    writeFileSync(
      join(home, 'rigs.json'),
      JSON.stringify([{ name: 'r', repo: clone, factory: 'mc', params }]),
    )
  const run = (params: object) => {
    rigWith(params)
    verifyRun(factoryDef(true, { base_branch: '' }))
    return tick().context.log.at(-1)
  }
  // origin/deploy sits at the base commit: b merges into it cleanly, while main moved CHANGELOG.md
  const withDeploy = () => {
    setup(true)
    git(other, 'push', '-q', 'origin', 'main~1:refs/heads/deploy')
    mkdirSync(home, { recursive: true })
  }

  withDeploy()
  expect(run({ base_branch: 'deploy' })?.outcome).not.toBe('red') // clean: a worker would launch

  withDeploy()
  expect(run({}).summary).toMatch(/merge origin\/main into b at [0-9a-f]+; conflicts in: CHANGELOG.md/)

  withDeploy()
  git(other, 'checkout', '-q', 'deploy')
  writeFileSync(join(other, 'CHANGELOG.md'), 'deploy\n')
  git(other, 'commit', '-qam', 'deploy moves')
  git(other, 'push', '-q', 'origin', 'deploy')
  expect(run({ base_branch: 'deploy' }).summary).toMatch(
    /merge origin\/deploy into b at [0-9a-f]+; conflicts in: CHANGELOG.md/,
  )
}, 120_000)

test('a station without mergeCheck runs no fetch (AC4)', () => {
  setup(true)
  mkdirSync(home, { recursive: true })
  verifyRun(factoryDef(false))
  tick()
  expect(existsSync(join(clone, '.git', 'refs', 'remotes', 'origin', 'b'))).toBe(false)
}, 60_000)

// claude-factory-cjqo: implement came back ready with the same conflict (the ax rig merged against
// upstream origin/main 16 times). The same conflict a second time parks verify for the manager.
test('the same conflict again after implement parks verify, with no second implement visit', () => {
  setup(true)
  mkdirSync(home, { recursive: true })
  verifyRun(factoryDef(true))
  tick() // the first conflict: red, back to implement
  const f = join(home, 'runs', 'r1', 'state.json')
  const state = JSON.parse(readFileSync(f, 'utf8'))
  const actor = createActor(compile(factoryDef(true)), { snapshot: state.snapshot }).start()
  actor.send({ type: 'GOTO', node: 'verify', at: 1 }) // implement reported ready with no change
  writeFileSync(f, JSON.stringify({ ...state, snapshot: actor.getPersistedSnapshot() }))
  const snap = tick()
  expect(where(snap.value)[0]).toBe('verify')
  expect(snap.context.log.at(-1)).toMatchObject({ node: 'verify', outcome: 'blocked' })
  expect(snap.context.log.at(-1).summary).toContain('conflicts in: CHANGELOG.md')
  expect(snap.context.log.filter((e: { outcome: string }) => e.outcome === 'red')).toHaveLength(1)
  expect(existsSync(join(home, 'launches.jsonl'))).toBe(false)
}, 60_000)

// claude-factory-gclk: implement pushed a new head, and main moved again with a new conflict in the same
// file. That is a new conflict, not an unresolved one: verify sends it back to implement, it does not park.
test('the same conflicting files at a new branch head go back to implement, not to a park', () => {
  setup(true)
  mkdirSync(home, { recursive: true })
  verifyRun(factoryDef(true))
  tick() // the first conflict: red, back to implement
  git(other, 'checkout', '-q', 'b')
  writeFileSync(join(other, 'CHANGELOG.md'), 'branch again\n')
  git(other, 'commit', '-qam', 'implement resolves, then main moves again')
  git(other, 'push', '-q', 'origin', 'b')
  const f = join(home, 'runs', 'r1', 'state.json')
  const state = JSON.parse(readFileSync(f, 'utf8'))
  const actor = createActor(compile(factoryDef(true)), { snapshot: state.snapshot }).start()
  actor.send({ type: 'GOTO', node: 'verify', at: 1 })
  writeFileSync(f, JSON.stringify({ ...state, snapshot: actor.getPersistedSnapshot() }))
  const snap = tick()
  expect(snap.context.log.filter((e: { outcome: string }) => e.outcome === 'red')).toHaveLength(2)
  expect(snap.context.log.some((e: { outcome: string }) => e.outcome === 'blocked')).toBe(false)
}, 60_000)
