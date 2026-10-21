// `factory metrics` after gc has touched a run (claude-factory-503.1.2).
//
// records() must count a run once. This holds even when metrics.jsonl holds two lines for the run.
// The stored usage of a run is the only source of `--tokens` (claude-factory-hr94).
//
// These tests drive the real CLI against on-disk fixtures, like src/watch.test.ts does.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
// the stored usage) above the "tokens:" section that the stored usage feeds. A station visited once
// shows "<node>  1" in that first table, so a test on the usage must check the tokens section alone.
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

// claude-factory-hr94: `factory metrics --tokens` reads stored usage only. A live run's rows are in
// runs/<id>/usage.jsonl. A removed run's rows are in its metrics.jsonl line. No transcript is read.
const row = (node: string, over: Record<string, unknown> = {}) => ({
  node,
  seq: 1,
  session: 's1',
  model: 'claude-opus-4-7',
  input: 1,
  cacheWrite: 2,
  cacheRead: 30,
  output: 4,
  turns: 5,
  peak: 33,
  ...over,
})

test('--tokens shows the stations and models of a live run from its usage.jsonl, with no transcript on disk (hr94 AC10, AC12)', () => {
  mkdirSync(home, { recursive: true })
  const { id, runDir } = workingRun('u2')
  writeFileSync(
    join(runDir, 'usage.jsonl'),
    [row('implement'), row('verify', { session: 's2', model: 'claude-sonnet-4-6' })]
      .map(r => JSON.stringify(r))
      .join('\n') + '\n',
  )
  const out = factory(['metrics', '--tokens'], { CLAUDE_CONFIG_DIR: join(dir, 'no-such-claude') })
  expect(out.code).toBe(0)
  expect(tokensSection(out.out)).toMatch(/implement\s+claude-opus-4-7\s+1/)
  expect(tokensSection(out.out)).toMatch(/verify\s+claude-sonnet-4-6\s+1/)
  expect(tokensSection(out.out)).toContain('in 1 runs')
  expect(id).toBeTruthy()
})

test('--tokens counts a run factory rm removed, shows cache hit rate and cost, and --json carries the same numbers (hr94 AC10-AC13)', () => {
  mkdirSync(home, { recursive: true })
  const id = `ship-${Date.now().toString(36)}ab`
  const line = {
    id,
    node: 'done',
    createdAt: parseInt(id.slice(id.lastIndexOf('-') + 1, -2), 36),
    log: [
      { node: 'implement', attempt: 1, outcome: 'ready', summary: 's', at: 0 },
      { node: 'deploy', attempt: 1, outcome: 'deployed', summary: 'ok', at: 1 },
    ],
    sessions: [row('implement', { input: 100, cacheWrite: 100, cacheRead: 800, output: 1000 })],
  }
  writeFileSync(join(home, 'metrics.jsonl'), JSON.stringify(line) + '\n')
  writeFileSync(
    join(home, 'manager-usage.jsonl'),
    JSON.stringify({
      name: 'patrol',
      at: Date.now(),
      model: 'claude-haiku-5-5',
      input: 10,
      cacheWrite: 0,
      cacheRead: 90,
      output: 5,
    }) +
      '\n' +
      JSON.stringify({
        name: 'dream',
        at: 1,
        model: 'claude-opus-4-7',
        input: 1,
        cacheWrite: 1,
        cacheRead: 1,
        output: 1,
      }) +
      '\n',
  )
  const out = factory(['metrics', '--tokens'])
  expect(out.code).toBe(0)
  const tokens = tokensSection(out.out)
  expect(tokens).toContain('cache hit rate 80%') // 800 / (100 + 100 + 800)
  expect(tokens).toMatch(/implement\s+claude-opus-4-7/)
  expect(tokens).toMatch(/patrol\s+claude-haiku-5-5/)
  expect(tokens).toMatch(/dream\s+claude-opus-4-7/)
  const json = JSON.parse(factory(['metrics', '--json', '--tokens']).out)
  expect(json.tokens.shippedRuns).toBe(1)
  expect(json.tokens.total).toMatchObject({
    input: 100,
    cacheWrite: 100,
    cacheRead: 800,
    output: 1000,
    hitRate: 0.8,
  })
  expect(json.tokens.manager.map((m: { name: string }) => m.name).sort()).toEqual(['dream', 'patrol'])
  // --since drops the dream row (at: 1) but keeps the patrol row
  const since = JSON.parse(factory(['metrics', '--json', '--tokens', '--since', '30d']).out)
  expect(since.tokens.manager.map((m: { name: string }) => m.name)).toEqual(['patrol'])
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

test('a station end skips a transcript older than the station start (hr94 review)', () => {
  const { runDir, seq, env } = workingRun('u2')
  const old = new Date(Date.now() - 3_600_000)
  const project = join(dir, 'claude-u2', 'projects', join(dir, 'wt-u2').replace(/[^a-zA-Z0-9]/g, '-'))
  utimesSync(join(project, 's1.jsonl'), old, old)
  writeFileSync(
    join(runDir, 'inbox.jsonl'),
    JSON.stringify({ type: 'DONE', seq, outcome: 'ready', summary: 'built' }) + '\n',
  )
  expect(factory(['tick'], env).code).toBe(0)
  expect(existsSync(join(runDir, 'usage.jsonl'))).toBe(false)
})

test('factory rm keeps the last row of a session and model stored twice (hr94 review)', () => {
  const { id, runDir, seq, env } = workingRun('u3')
  const old = new Date(Date.now() - 3_600_000)
  const project = join(dir, 'claude-u3', 'projects', join(dir, 'wt-u3').replace(/[^a-zA-Z0-9]/g, '-'))
  utimesSync(join(project, 's1.jsonl'), old, old) // the tick stores nothing: only the rows below
  writeFileSync(
    join(runDir, 'inbox.jsonl'),
    JSON.stringify({ type: 'DONE', seq, outcome: 'ready', summary: 'built' }) + '\n',
  )
  expect(factory(['tick'], env).code).toBe(0)
  const row = (node: string, read: number) =>
    JSON.stringify({
      run: id,
      node,
      seq: 1,
      session: 's1',
      model: 'claude-opus-4-7',
      input: 1,
      cacheWrite: 2,
      cacheRead: read,
      output: 3,
      turns: 1,
      peak: 5,
    })
  writeFileSync(join(runDir, 'usage.jsonl'), `${row('implement', 10)}\n${row('verify', 99)}\n`)
  rmSync(join(dir, 'wt-u3'), { recursive: true })
  const rm = factory(['rm', id], env)
  expect(rm.err).toBe('')
  const line = JSON.parse(readFileSync(join(home, 'metrics.jsonl'), 'utf8').trim().split('\n').at(-1)!)
  expect(line.sessions).toHaveLength(1)
  expect(line.sessions[0]).toMatchObject({ node: 'verify', cacheRead: 99 })
})
