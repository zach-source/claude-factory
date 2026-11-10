// The Herdr app factory mod (claude-factory-s01d.3): its pure view code, and `factory herdr install`.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as claude from '../mod/hooks/view'
import * as herdrView from '../herdr/mods/factory/view.js'
import * as herdrInstall from './herdr-install'

// the mod is plain JS: its inferred types are loose
const herdr: any = herdrView

const runs = [
  { id: 'lifecycle-aaaa1111', rig: 'api', node: 'implement', sub: 'working', goal: 'one', since: 2 },
  { id: 'lifecycle-bbbb2222', rig: 'api', node: 'review', sub: 'working', agent: 'blocked', since: 1 },
  {
    id: 'lifecycle-cccc3333',
    rig: 'web',
    node: 'ship',
    sub: 'waiting',
    since: 3,
    gate: { question: 'Ship it?', outcomes: ['ok', 'no'] },
  },
  { id: 'lifecycle-dddd4444', rig: 'web', node: 'implement', sub: 'waiting', since: 4 },
  { id: 'lifecycle-eeee5555', rig: 'web', node: 'done' },
]

test('the copied functions agree with the Claude mod', () => {
  for (const r of runs) {
    expect(herdr.isLive(r)).toBe(claude.isLive(r as never))
    expect(herdr.stateOf(r)).toBe(claude.stateOf(r as never))
    expect(herdr.shortId(r.id)).toBe(claude.shortId(r.id))
  }
  expect(herdr.statusText(runs)).toBe(claude.statusText(runs as never) ?? '')
  expect(herdr.statusText([])).toBe('')
  for (const s of ['short', 'a  b\n c', 'x'.repeat(50)]) expect(herdr.line(s, 20)).toBe(claude.line(s, 20))
})

test('the board groups live runs by rig, then by state, oldest first', () => {
  const b = herdr.board(runs)
  expect(b.map((g: { rig: string }) => g.rig)).toEqual(['api', 'web'])
  expect(b[0].states.map((s: { state: string }) => s.state)).toEqual(['stuck', 'working'])
  expect(
    b[1].states.map((s: { state: string; runs: { id: string }[] }) => [s.state, s.runs.map(r => r.id)]),
  ).toEqual([
    ['gates', ['lifecycle-cccc3333']],
    ['waiting', ['lifecycle-dddd4444']],
  ])
})

test('blocked workers toast once', () => {
  expect(herdr.newlyBlocked(runs, {}).map((r: { id: string }) => r.id)).toEqual(['lifecycle-bbbb2222'])
  expect(herdr.newlyBlocked(runs, herdr.agentsOf(runs))).toEqual([])
})

test('the Interview lists gates first, then beads; each answer is the right factory command', () => {
  const decisions = {
    rigs: [
      {
        rig: 'api',
        factory: 'lifecycle',
        beads: [
          { id: 'api-1', title: 'Pick a DB', kind: 'bead' },
          { id: 'api-2', title: 'Big change', kind: 'owned' },
        ],
      },
    ],
    proposals: {
      'bd:api:api-1': { question: 'Which DB?', options: ['postgres: safe', 'sqlite: small'], at: 1 },
    },
  }
  const items = herdr.interviewItems(runs, decisions)
  expect(items.map((i: { key: string }) => i.key)).toEqual([
    'gate:lifecycle-cccc3333',
    'bd:api:api-1',
    'own:api:api-2',
  ])
  expect(items[0].options).toEqual(['ok', 'no'])
  expect(items[1].title).toBe('Which DB?')
  expect(items[1].options).toEqual(['postgres', 'sqlite'])
  expect(items[2].options).toEqual(['start now', 'not now'])
  expect(herdr.answerArgs(items[0], 'ok')).toEqual(['decide', 'lifecycle-cccc3333', 'ok'])
  expect(herdr.answerArgs(items[1], 'postgres')).toEqual(['decisions', 'answer', 'api', 'api-1', 'postgres'])
})

test('parseTick reads a board, a read-only board, a busy tick and a failure', () => {
  expect(herdr.parseTick(0, JSON.stringify({ runs, manager: [] }), '').runs).toHaveLength(5)
  expect(herdr.parseTick(0, JSON.stringify({ readOnly: 'x holds it', runs: [] }), '').readOnly).toBe(
    'x holds it',
  )
  expect(herdr.parseTick(0, '{"busy":true}', '')).toEqual({ busy: true })
  expect(herdr.parseTick(1, '', 'boom').error).toBe('boom')
  expect(herdr.parseTick(0, 'not json', '').error).toContain('printed no JSON')
})

const dir = join(tmpdir(), `herdr-install-${process.pid}`)
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('factory herdr install copies the mod and layout and names the cli and home', () => {
  const app = join(dir, 'app')
  const home = join(dir, 'home')
  const p = Bun.spawnSync(
    [join(import.meta.dir, '..', 'bin', 'factory'), 'herdr', 'install', '--app-home', app],
    {
      env: { ...process.env, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' },
    },
  )
  expect(p.exitCode).toBe(0)
  for (const f of ['main.js', 'view.js', 'mod.json'])
    expect(existsSync(join(app, 'mods', 'factory', f))).toBe(true)
  expect(existsSync(join(app, 'layouts', 'factory.json'))).toBe(true)
  const cfg = JSON.parse(readFileSync(join(app, 'mods', 'factory', 'config.json'), 'utf8'))
  expect(cfg).toEqual({ cli: join(import.meta.dir, '..', 'bin', 'factory'), home })
})

// claude-factory-hpmc.14: remote mode, for a manager in another machine (AX task f-manager)
test('parseConfig reads a local and a remote config and refuses bad text', () => {
  expect(herdr.parseConfig('{"cli":"/x/factory","home":"/h"}')).toEqual({ cli: '/x/factory', home: '/h' })
  expect(herdr.parseConfig('{"cli":"factory","home":"/w/home","machine":"f-manager"}')).toEqual({
    cli: 'factory',
    home: '/w/home',
    machine: 'f-manager',
  })
  for (const bad of [null, '', '{', '[]', '{"cli":"x"}', '{"cli":"x","home":"/h","machine":3}'])
    expect(herdr.parseConfig(bad)).toBeNull()
})

test('every exec and file read of a remote config passes on: machine', () => {
  expect(herdr.onOf({ cli: 'x', home: '/h', machine: 'f-manager' })).toEqual({ on: 'f-manager' })
  expect(herdr.onOf({ cli: 'x', home: '/h' })).toBeUndefined()
})

test('the mod reads one snapshot and never ticks, patrols or takes the lease', () => {
  expect(herdr.SNAPSHOT_WORDS).toEqual(['snapshot', '--views', 'board,decisions'])
  for (const w of ['tick', 'patrol', 'brief', 'review', 'pm'])
    expect(herdr.SNAPSHOT_WORDS.includes(w)).toBe(false)
  expect(herdr.beatJobs).toBeUndefined()
  expect(herdr.STEPS).toBeUndefined()
})

test('a remote action calls the factory CLI; the chat opens the hc terminal of the manager', () => {
  expect(herdr.actionWords('stop')).toEqual(['stop'])
  expect(herdr.actionWords('resume')).toEqual(['resume'])
  expect(herdr.actionWords('abort', 'lifecycle-aaaa1111')).toEqual(['abort', 'lifecycle-aaaa1111'])
  expect(herdr.actionWords('unhold', 'ax')).toEqual(['unhold', 'ax'])
  expect(herdr.actionWords('say', 'hello there')).toEqual(['say', 'hello there'])
  expect(() => herdr.actionWords('tick')).toThrow()
  expect(herdr.chatArgv({ cli: 'x', home: '/h', machine: 'f-manager' })).toEqual([
    'hc',
    'attach',
    'f-manager/manager',
  ])
  expect(herdr.chatArgv({ cli: 'x', home: '/h' })).toBeNull()
})

test('factory herdr install --machine writes a remote config', () => {
  const app = join(dir, 'app')
  const p = Bun.spawnSync(
    [
      join(import.meta.dir, '..', 'bin', 'factory'),
      'herdr',
      'install',
      '--app-home',
      app,
      '--machine',
      'f-manager',
    ],
    { env: { ...process.env, FACTORY_HOME: join(dir, 'home'), FACTORY_SELF_UPDATE: '0' } },
  )
  expect(p.exitCode).toBe(0)
  expect(JSON.parse(readFileSync(join(app, 'mods', 'factory', 'config.json'), 'utf8'))).toEqual({
    cli: 'factory',
    home: '/workspace/w/home',
    machine: 'f-manager',
  })
  const q = Bun.spawnSync(
    [
      join(import.meta.dir, '..', 'bin', 'factory'),
      'herdr',
      'install',
      '--app-home',
      app,
      '--machine',
      'a b',
      '--home',
      '/h',
    ],
    { env: { ...process.env, FACTORY_SELF_UPDATE: '0' } },
  )
  expect(q.exitCode).not.toBe(0)
})

test('a local install refuses a home whose manager runs in AX', () => {
  const now = 1_000_000
  const live = { holder: 'ax:f-manager', kind: 'ax', at: now - 1000 }
  expect(herdrInstall.localRefusal('/h', undefined, undefined, now)).toBeUndefined()
  expect(
    herdrInstall.localRefusal('/h', 'the factory manager runs in AX task f-manager', undefined, now),
  ).toMatch(/AX/)
  expect(herdrInstall.localRefusal('/h', undefined, live, now)).toMatch(/AX/)
  expect(herdrInstall.localRefusal('/h', undefined, { ...live, at: now - 120_000 }, now)).toBeUndefined()
  expect(
    herdrInstall.localRefusal('/h', undefined, { holder: 'p', kind: 'herdr', at: now }, now),
  ).toBeUndefined()
})

test('a remote job runs direct in the foreground: no detached shell that hc exec would kill', () => {
  const cfg = { cli: 'factory', home: '/w/home', machine: 'f-manager' }
  expect(herdr.directJob(cfg, ['tick', '--board'])).toEqual([
    'env',
    ['FACTORY_HOME=/w/home', 'factory', 'tick', '--board'],
  ])
})

test('interviewItems counts the beads of `factory decisions` once each, plus the live gates (claude-factory-hpmc.22)', () => {
  const decisions = {
    rigs: [
      {
        rig: 'a',
        beads: [
          { id: 'a-1', title: 't', kind: 'bead' },
          { id: 'a-2', title: 't', kind: 'owned' },
        ],
      },
      { rig: 'b', beads: [{ id: 'b-1', title: 't', kind: 'owned' }] },
    ],
  }
  expect(herdr.interviewItems([], decisions)).toHaveLength(3)
  expect(herdr.interviewItems(runs, decisions).length - 3).toBe(
    runs.filter((r: { gate?: unknown }) => r.gate).length,
  )
})

test('parseSnapshot splits one snapshot into the board result and the decisions (claude-factory-hpmc.23)', () => {
  const out = JSON.stringify({ views: { board: { runs: [], manager: [] }, decisions: { rigs: [] } } })
  expect(herdr.parseSnapshot(0, out, '')).toEqual({
    tick: { runs: [], manager: [], rigs: [], halt: undefined, readOnly: undefined },
    decisions: { rigs: [] },
  })
  const bad = JSON.stringify({ views: { board: { error: 'no tick yet' }, decisions: { error: 'x' } } })
  expect(herdr.parseSnapshot(0, bad, '')).toEqual({ tick: { error: 'no tick yet' }, decisions: undefined })
  expect(herdr.parseSnapshot(1, '', 'boom').tick.error).toBe('boom')
})

// claude-factory-hpmc.26: the Flow tab draws flows.show (the pure layout).
const graph = {
  factory: 'f',
  since: 0,
  now: 100_000,
  nodes: [
    {
      id: 'plan',
      gate: false,
      legacy: false,
      rank: 0,
      order: 0,
      counts: { working: 2 },
      dwell: { p50: 1000, p90: 4000 },
      runs: ['a', 'b', 'c', 'd', 'e', 'f'],
    },
    {
      id: 'build',
      gate: false,
      legacy: false,
      rank: 1,
      order: 1,
      counts: {},
      dwell: { p50: 500, p90: 1000 },
      runs: [],
    },
    {
      id: 'gate',
      gate: true,
      legacy: false,
      rank: 1,
      order: 2,
      counts: { waiting: 1 },
      dwell: null,
      runs: ['g'],
    },
  ],
  edges: [
    { from: 'plan', outcome: 'done', to: 'build', back: false, timed: false, traversals: 7 },
    { from: 'build', outcome: 'fail', to: 'plan', back: true, timed: false, traversals: 0 },
  ],
  exits: [{ from: 'gate', outcome: 'ok', to: 'ship' }],
  moves: [{ run: 'a', from: 'plan', outcome: 'done', to: 'build', at: 99_000 }],
}

test('flowLayout puts a rank in a column and an order in a row', () => {
  const l = herdr.flowLayout(graph, 'live')
  const at = (id: string) => l.nodes.find((n: any) => n.id === id)
  expect(at('plan').x).toBeLessThan(at('build').x)
  expect(at('build').x).toBe(at('gate').x)
  expect(at('build').y).toBeLessThan(at('gate').y)
  expect(at('gate').gate).toBe(true)
  expect(l.width).toBeGreaterThan(at('build').x + at('build').w)
})

test('flowLayout shows at most 4 run dots and a +N chip', () => {
  const n = herdr.flowLayout(graph, 'live').nodes.find((x: any) => x.id === 'plan')
  expect(n.dots.map((d: any) => d.run)).toEqual(['a', 'b', 'c', 'd'])
  expect(n.chip).toBe('+2')
})

test('the Flow lens sizes an edge by log traversals; a back edge is dashed and goes below', () => {
  const l = herdr.flowLayout(graph, 'flow')
  const fwd = l.edges.find((e: any) => !e.back)
  const back = l.edges.find((e: any) => e.back)
  expect(fwd.width).toBeGreaterThan(back.width)
  expect(fwd.label).toBe('done 7')
  expect(back.dashed).toBe(true)
  expect(fwd.dashed).toBe(false)
  expect(herdr.flowLayout(graph, 'live').edges[0].width).toBe(herdr.flowLayout(graph, 'live').edges[1].width)
})

test('the Time lens heats a node by its p90 dwell against the slowest', () => {
  const l = herdr.flowLayout(graph, 'time')
  const heat = (id: string) => l.nodes.find((n: any) => n.id === id).heat
  expect(heat('plan')).toBe(1)
  expect(heat('build')).toBe(0.25)
  expect(heat('gate')).toBe(0)
  expect(herdr.flowLayout(graph, 'live').nodes[0].heat).toBe(0)
})

test('an exit to the ship queue names the workflow to open', () => {
  const l = herdr.flowLayout(graph, 'live')
  expect(l.exits).toEqual([{ from: 'gate', outcome: 'ok', to: 'ship', opens: 'ship' }])
})

test('recent moves mark the runs that pulse', () => {
  expect(herdr.recentMovers(graph, 5000)).toEqual(['a'])
  expect(herdr.recentMovers(graph, 500)).toEqual([])
})

test('parseFlows gives the graph or the reason', () => {
  expect(herdr.parseFlows(0, JSON.stringify(graph), '').graph.factory).toBe('f')
  expect(herdr.parseFlows(1, '', 'no factory "x"').error).toBe('no factory "x"')
  expect(herdr.parseFlows(0, 'nope', '').error).toContain('no JSON')
})

test('flowJobWords asks for JSON for one factory and one window', () => {
  expect(herdr.flowJobWords('ship', '7d')).toEqual(['flows', '--json', '--factory', 'ship', '--since', '7d'])
})
