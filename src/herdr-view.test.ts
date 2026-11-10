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

test('a remote mod never ticks, never patrols and takes no lease', () => {
  const remote = { cli: 'factory', home: '/w/home', machine: 'f-manager' }
  const local = { cli: 'x', home: '/h' }
  const now = 10_000_000
  const jobs = (cfg: unknown, state = {}) =>
    herdr.beatJobs(cfg, state, {}, now).map((j: { name: string }) => j.name)
  expect(jobs(remote)).toEqual(['board', 'decisions'])
  expect(jobs(remote, { halt: { state: 'stopping' } })).toEqual(['board', 'decisions'])
  const words = herdr.beatJobs(remote, {}, {}, now).flatMap((j: { words: string[] }) => j.words)
  for (const w of ['tick', 'patrol', 'brief', 'review', 'pm']) expect(words.includes(w)).toBe(w === 'tick')
  expect(herdr.beatJobs(remote, {}, {}, now)[0].words).toEqual(['tick', '--board'])
  expect(jobs(local)).toEqual(['tick', 'patrol', 'brief', 'review', 'pm', 'decisions'])
  expect(jobs(local, { readOnly: 'x' })).toEqual(['tick'])
  expect(
    herdr.beatJobs(local, {}, { patrol: now - 1 }, now).some((j: { name: string }) => j.name === 'patrol'),
  ).toBe(false)
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
