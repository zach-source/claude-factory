// `factory metrics` after gc has touched a run (claude-factory-503.1.2).
//
// records() must count a run once. This holds even when metrics.jsonl holds two lines for the run.
// sessionsOf() must still name a session's station. This holds once gc removes prompts/ and leaves
// prompts.list in its place.
//
// These tests drive the real CLI against on-disk fixtures, like src/watch.test.ts does.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `records-${process.pid}`)
const home = join(dir, 'home')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

// `factory metrics --tokens` prints a "station visits" table from the run's own log (unrelated to
// sessionsOf) above the "tokens:" section that sessionsOf() feeds. A station visited once shows
// "<node>  1" in that first table regardless of sessionsOf, so a test on sessionsOf's output must
// check the tokens section alone, or it passes even when sessionsOf has a bug.
const tokensSection = (out: string) => out.slice(out.indexOf('tokens:'))

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: { implement: { prompt: 'do it', next: { ready: 'done' } } },
}

test('a metrics.jsonl line a gc prune wrote, then a later factory rm line for the same id, count the run once (AC6, AC7)', () => {
  mkdirSync(home, { recursive: true })
  // no live run under runs/: both lines describe a run already removed, as a pruned-then-rm'd run would
  const gcLine = {
    id: 'r1',
    node: 'done',
    createdAt: 0,
    log: [{ node: 'implement', attempt: 1, outcome: 'ready', summary: 's', at: 0 }],
  }
  const rmLine = {
    ...gcLine,
    log: [...gcLine.log, { node: 'done', attempt: 1, outcome: 'closed', summary: 's2', at: 1 }],
  }
  writeFileSync(join(home, 'metrics.jsonl'), `${JSON.stringify(gcLine)}\n${JSON.stringify(rmLine)}\n`)
  const out = factory(['metrics', '--json'])
  expect(out.code).toBe(0)
  const parsed = JSON.parse(out.out)
  // one run, fate 'closed': counted once, not twice
  expect(parsed.all.fates).toEqual({ closed: 1 })
})

test("a session's station still resolves from prompts.list once gc has removed prompts/ (AC8)", () => {
  mkdirSync(home, { recursive: true })
  const worktree = join(dir, 'wt')
  mkdirSync(worktree, { recursive: true })
  // createdAt(id) reads the id's own trailing "-<base36 time>xx" suffix: a bare "r1" parses to NaN,
  // which then fails metrics' `Date.now() - createdAt < days` filter and drops the run silently
  const id = `ship-${Date.now().toString(36)}xx`
  const runDir = join(home, 'runs', id)
  mkdirSync(runDir, { recursive: true })
  const factoryFile = join(runDir, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  const run = {
    id,
    factory: factoryFile,
    repo: worktree,
    goal: 'g',
    ws: 'w1',
    worktree,
    branch: 'b',
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run))
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: 'done', at: 0 })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  // prompts/ is already gone: gc wrote prompts.list with the names it held, before removing it
  writeFileSync(join(runDir, 'prompts.list'), JSON.stringify([`${seq}-implement.md`]))

  const claudeHome = join(dir, 'claude')
  const projectDir = join(claudeHome, 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projectDir, { recursive: true })
  // sessionOf() matches the brief's own usage line literally ("<outcome>" is the placeholder text
  // the real prompt renders, not a real outcome word): see src/metrics.test.ts's own fixture
  const brief = JSON.stringify({
    type: 'user',
    message: { content: `report ${id} ${seq} <outcome> "<summary>"` },
  })
  const turn = JSON.stringify({
    type: 'assistant',
    message: { id: 'a', usage: { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: 5 } },
  })
  writeFileSync(join(projectDir, 's1.jsonl'), `${brief}\n${turn}\n`)

  const out = factory(['metrics', '--tokens'], { CLAUDE_CONFIG_DIR: claudeHome })
  expect(out.code).toBe(0)
  expect(tokensSection(out.out)).toMatch(/implement\s+1/) // not '?': the name came from prompts.list
})

// PR #59 review finding 1 (claude-factory-503.1.5). A `goto` revive after gc recreates prompts/, but
// with only the new prompt's name. sessionsOf() must still name the old sessions' stations too: it
// must read the union of prompts.list and prompts/, not either alone.
test('sessionsOf() names both an old session (from prompts.list) and a revived one (from prompts/) (claude-factory-503.1.5)', () => {
  mkdirSync(home, { recursive: true })
  const worktree = join(dir, 'wt2')
  mkdirSync(worktree, { recursive: true })
  const DEF2: Factory = {
    name: 'ship',
    start: 'implement',
    nodes: {
      implement: { prompt: 'do it', next: { ready: 'verify' } },
      verify: { prompt: 'check it', next: { ready: 'done' } },
    },
  }
  const id = `ship-${Date.now().toString(36)}xz`
  const runDir = join(home, 'runs', id)
  mkdirSync(runDir, { recursive: true })
  const factoryFile = join(runDir, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF2)}`)
  const run = { id, factory: factoryFile, repo: worktree, goal: 'g', ws: 'w1', worktree, branch: 'b' }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run))
  const actor = createActor(compile(DEF2)).start()
  actor.send({ type: 'TICK', at: 0 })
  const seq1 = actor.getSnapshot().context.seq // 1, at 'implement'
  actor.send({ type: 'DONE', seq: seq1, outcome: 'ready', summary: 'built', at: 0 })
  const seq2 = actor.getSnapshot().context.seq // 2, at 'verify'
  actor.send({ type: 'DONE', seq: seq2, outcome: 'ready', summary: 'checked', at: 0 })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  // gc already pruned prompts/ once, leaving prompts.list with the name it held then
  writeFileSync(join(runDir, 'prompts.list'), JSON.stringify([`${seq1}-implement.md`]))
  // a goto revive after gc recreated prompts/, with only the new prompt's name
  mkdirSync(join(runDir, 'prompts'), { recursive: true })
  writeFileSync(join(runDir, 'prompts', `${seq2}-verify.md`), 'the brief')

  const claudeHome = join(dir, 'claude2')
  const projectDir = join(claudeHome, 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projectDir, { recursive: true })
  const briefOf = (s: number) =>
    JSON.stringify({ type: 'user', message: { content: `report ${id} ${s} <outcome> "<summary>"` } })
  const turn = JSON.stringify({
    type: 'assistant',
    message: { id: 'a', usage: { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: 5 } },
  })
  writeFileSync(join(projectDir, 's1.jsonl'), `${briefOf(seq1)}\n${turn}\n`)
  writeFileSync(join(projectDir, 's2.jsonl'), `${briefOf(seq2)}\n${turn}\n`)

  const out = factory(['metrics', '--tokens'], { CLAUDE_CONFIG_DIR: claudeHome })
  expect(out.code).toBe(0)
  expect(tokensSection(out.out)).toMatch(/implement\s+1/) // from prompts.list alone
  expect(tokensSection(out.out)).toMatch(/verify\s+1/) // from the recreated prompts/ alone
})

// claude-factory-hr94: a station's end stores its sessions' usage; the metrics.jsonl line holds it
// after `factory rm`; an old line without the field still reads.
const turnAt = (id: string, model: string, read: number) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model,
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: read,
        output_tokens: 3,
      },
    },
  })

function workingRun(tail: string) {
  mkdirSync(home, { recursive: true })
  const worktree = join(dir, `wt-${tail}`)
  mkdirSync(worktree, { recursive: true })
  const id = `ship-${Date.now().toString(36)}${tail}`
  const runDir = join(home, 'runs', id)
  mkdirSync(runDir, { recursive: true })
  const factoryFile = join(runDir, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ id, factory: factoryFile, repo: worktree, goal: 'g', ws: 'w1', worktree, branch: 'b' }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: Date.now() - 5000 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'SPAWNED', seq, pane: 'w1:p1', at: Date.now() - 5000 })
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
  const claudeHome = join(dir, `claude-${tail}`)
  const projectDir = join(claudeHome, 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(join(projectDir, 's1', 'subagents'), { recursive: true })
  const brief = JSON.stringify({
    type: 'user',
    message: { content: `report ${id} ${seq} <outcome> "<summary>"` },
  })
  writeFileSync(join(projectDir, 's1.jsonl'), `${brief}\n${turnAt('a', 'claude-opus-4-7', 100)}\n`)
  writeFileSync(
    join(projectDir, 's1', 'subagents', 'agent-x.jsonl'),
    `${turnAt('b', 'claude-haiku-5-5', 40)}\n`,
  )
  const herdr = join(dir, 'herdr')
  writeFileSync(herdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { id, runDir, seq, env: { CLAUDE_CONFIG_DIR: claudeHome, FACTORY_HERDR: herdr } }
}

test('a station end stores the sessions usage in usage.jsonl; factory rm keeps it in metrics.jsonl (hr94 AC3, AC4)', () => {
  const { id, runDir, seq, env } = workingRun('u1')
  writeFileSync(
    join(runDir, 'inbox.jsonl'),
    JSON.stringify({ type: 'DONE', seq, outcome: 'ready', summary: 'built' }) + '\n',
  )
  expect(factory(['tick'], env).code).toBe(0)
  const rows = readFileSync(join(runDir, 'usage.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  const by = Object.fromEntries(rows.map(r => [r.model, r]))
  expect(by['claude-opus-4-7']).toMatchObject({
    node: 'implement',
    seq,
    session: 's1',
    input: 1,
    cacheWrite: 2,
    cacheRead: 100,
    output: 3,
    turns: 1,
    peak: 103,
  })
  expect(by['claude-haiku-5-5']).toMatchObject({ cacheRead: 40, turns: 0 }) // the subagent, its own model
  rmSync(join(dir, 'wt-u1'), { recursive: true }) // no git worktree here: rm skips a worktree that is gone
  const rm = factory(['rm', id], env)
  expect(rm.err).toBe('')
  expect(rm.code).toBe(0)
  const line = JSON.parse(readFileSync(join(home, 'metrics.jsonl'), 'utf8').trim().split('\n').at(-1)!)
  expect(line.sessions.map((r: { model: string }) => r.model).sort()).toEqual([
    'claude-haiku-5-5',
    'claude-opus-4-7',
  ])
})

test('a metrics.jsonl line with no sessions field still reads (hr94 AC5)', () => {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'metrics.jsonl'),
    JSON.stringify({ id: 'old-1', node: 'done', createdAt: 0, log: [] }) + '\n',
  )
  expect(factory(['metrics', '--tokens']).code).toBe(0)
})
