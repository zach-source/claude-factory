// The Herdr app factory mod (claude-factory-s01d.3): its pure view code, and `factory herdr install`.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as claude from '../mod/hooks/view'
import * as herdrView from '../herdr/mods/factory/view.js'

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
