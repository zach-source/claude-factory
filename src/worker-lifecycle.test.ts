import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile } from './machine'

// Exercise the real CLI and persisted machine against a controllable herdr boundary.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'factory-worker-'))
  const dir = join(home, 'runs', 'one')
  mkdirSync(join(dir, 'prompts'), { recursive: true })
  mkdirSync(join(home, 'beads.lock'))
  writeFileSync(join(home, 'beads.lock', 'pid'), String(process.pid))
  writeFileSync(join(home, 'dream.stamp'), '')
  const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value))
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
  const def = {
    name: 'test',
    start: 'implement',
    agent: 'claude',
    backoffSec: 0,
    nodes: {
      implement: { prompt: 'build', next: { ready: 'review' }, retries: 0 },
      review: { prompt: 'check', next: { approve: 'done' }, retries: 0 },
    },
  }
  json(join(dir, 'factory.json'), def)
  json(join(dir, 'run.json'), {
    id: 'one',
    factory: join(dir, 'factory.json'),
    repo: home,
    worktree: home,
    ws: 'w',
    branch: 'test',
    goal: 'test',
  })
  const actor = createActor(compile(def)).start()
  actor.send({ type: 'SPAWNED', seq: 1, pane: 'p1', at: 1 })
  actor.send({ type: 'SESSION', seq: 1, session: 'session-one', at: 1 })
  const stateFile = join(dir, 'state.json')
  json(stateFile, { cursor: 0, snapshot: actor.getPersistedSnapshot() })
  actor.stop()
  const worldFile = join(home, 'herdr.json')
  json(worldFile, {
    next: 1,
    panes: { p1: { workers: 1, detected: true } },
    calls: [],
  })
  const fake = join(home, 'herdr')
  writeFileSync(
    fake,
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
const file = process.env.FAKE_HERDR
const w = JSON.parse(readFileSync(file, 'utf8'))
const a = process.argv.slice(2)
w.calls.push(a)
let result = {}, error
if (a[0] === 'pane' && a[1] === 'get') {
  const p = w.panes[a[2]]
  if (!p) error = { code: 'pane_not_found' }
  else result = { pane: { agent_status: 'working', agent: p.detected ? 'claude' : null, agent_session: { value: 'session-one' } } }
} else if (a[0] === 'pane' && a[1] === 'close') {
  if (w.closeFails) error = { code: 'close_failed' }
  else if (!w.closeLies) delete w.panes[a[2]]
} else if (a[0] === 'tab' && a[1] === 'create') {
  const id = 'p' + ++w.next
  w.panes[id] = { workers: 0, detected: false }
  result = { root_pane: { pane_id: id } }
} else if (a[0] === 'pane' && a[1] === 'run') {
  w.panes[a[2]].workers++
  if (w.runFails) error = { code: 'lost_launch_response' }
} else if (a[0] === 'pane' && a[1] === 'list') {
  result = { panes: Object.keys(w.panes).map(pane_id => ({ pane_id, workspace_id: 'w', cwd: process.env.FACTORY_HOME })) }
}
writeFileSync(file, JSON.stringify(w))
console.log(JSON.stringify(error ? { error } : { result }))
process.exit(error ? 1 : 0)
`,
  )
  chmodSync(fake, 0o755)
  const env = {
    ...process.env,
    FACTORY_HOME: home,
    FACTORY_OUTBOX: '',
    FACTORY_FROM: '',
    FAKE_HERDR: worldFile,
    CLAUDE_CONFIG_DIR: home,
    PATH: `${home}:${process.env.PATH}`,
  }
  const cmd = (...args: string[]) => [process.execPath, join(import.meta.dir, 'cli.ts'), ...args]
  const cli = (...args: string[]) => Bun.spawnSync(cmd(...args), { env })
  return {
    home,
    cli,
    env,
    cmd,
    state: () => read(stateFile),
    world: () => read(worldFile),
    setWorld: (patch: object) => json(worldFile, { ...read(worldFile), ...patch }),
    context: (patch: object) => {
      const s = read(stateFile)
      Object.assign(s.snapshot.context, patch)
      json(stateFile, s)
    },
  }
}

test('station replacement fails closed, then resume and retry keep one worker', () => {
  const f = fixture()
  const workers = () => Object.values(f.world().panes).reduce((n, p: any) => n + p.workers, 0)
  try {
    expect(f.cli('report', 'one', '1', 'ready', 'built').exitCode).toBe(0)
    for (const failure of [{ closeFails: true }, { closeFails: false, closeLies: true }]) {
      f.setWorld(failure)
      f.cli('tick')
      expect(f.state().snapshot.context.seq).toBe(1)
      expect(workers()).toBe(1)
    }
    f.setWorld({ closeLies: false })
    f.cli('tick')
    expect(f.state().snapshot.context.seq).toBe(2)
    expect(workers()).toBe(1)
    const pane = f.state().snapshot.context.pane
    // Agent detection disappears while its process still exists: never type a second launch into it.
    f.context({ session: 'session-two', startedAt: 1 })
    f.cli('tick')
    expect(f.state().snapshot.context.pane).not.toBe(pane)
    expect(workers()).toBe(1)
    writeFileSync(
      join(f.home, 'halt.json'),
      JSON.stringify({
        state: 'stopping',
        at: 1,
        told: { one: 2 },
        closed: {},
      }),
    )
    f.cli('tick')
    expect(workers()).toBe(0)
    expect(f.cli('resume').exitCode).toBe(0)
    f.cli('tick')
    expect(f.state().snapshot.context.seq).toBe(2)
    expect(workers()).toBe(1)
    expect(f.cli('report', 'one', '2', 'fail', 'retry me').exitCode).toBe(0)
    f.cli('tick')
    expect(workers()).toBe(0)
    f.cli('retry', 'one')
    f.cli('tick')
    expect(workers()).toBe(1)
    expect(f.state().snapshot.context.seq).toBe(3)
    f.cli('report', 'one', '3', 'approve', 'checked')
    f.cli('tick')
    expect(workers()).toBe(0)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('an undetected launch is replaced and an uncertain launch stays tracked', () => {
  const f = fixture()
  try {
    f.setWorld({
      panes: { p1: { workers: 1, detected: false } },
      runFails: true,
    })
    f.context({ session: null, nudges: 1, startedAt: 1 })
    f.cli('tick')
    const pane = f.state().snapshot.context.pane
    expect(pane).not.toBe('p1')
    expect(f.state().snapshot.context.nudges).toBe(2)
    expect(Object.keys(f.world().panes)).toEqual([pane])
    f.cli('tick') // no second launch while the first is still within its startup grace
    expect(f.world().calls.filter((a: string[]) => a[0] === 'pane' && a[1] === 'run')).toHaveLength(1)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('only one report for a station attempt is accepted before the tick', async () => {
  const f = fixture()
  try {
    const reports = [1, 2].map(i =>
      Bun.spawn(f.cmd('report', 'one', '1', 'ready', `report ${i}`), {
        env: f.env,
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    const codes = await Promise.all(reports.map(p => p.exited))
    expect(codes.filter(code => code === 0)).toHaveLength(1)
    expect(f.cli('report', 'one', '1', 'blocked', 'another report').exitCode).not.toBe(0)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('retry refuses a working worker and a timed out worker is held without losing its source', () => {
  const f = fixture()
  try {
    const source = join(f.home, 'uncommitted.txt')
    writeFileSync(source, 'keep this edit')
    const retry = f.cli('retry', 'one')
    expect(retry.exitCode).not.toBe(0)
    expect(retry.stderr.toString()).toContain('implement/working')
    expect(retry.stderr.toString()).toContain('stuck')
    expect(f.state().snapshot.context.session).toBe('session-one')
    f.cli('tick') // startedAt=1 is beyond the real station deadline
    expect(f.state().snapshot.value).toEqual({ implement: 'stuck' })
    expect(f.world().panes).toEqual({})
    expect(readFileSync(source, 'utf8')).toBe('keep this edit')
    expect(f.state().snapshot.context.log.at(-1).summary).toContain('no report within')
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})
