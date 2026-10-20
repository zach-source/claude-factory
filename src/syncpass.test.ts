// The beads sync runs in its own pass (`factory sync`), not inside dispatch (claude-factory-2rik).
// These tests drive the real CLI with a fake `bd` and `herdr` on PATH, as dispatch.test.ts does. A rig
// opts into a behavior with a marker file in its .beads dir: `hang` (bd sync sleeps), `slow` (bd sync
// fails after 3 s), `ready.json` (the beads bd ready answers).
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `syncpass-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const log = join(dir, 'bd.log')
const claudeConfig = join(dir, 'claude-config')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const t0 = Date.now()
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${bin}:${laptop.PATH}`,
      CLAUDE_CONFIG_DIR: claudeConfig,
      FACTORY_SELF_UPDATE: '0',
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), ms: Date.now() - t0 }
}

function setup(names: string[], marks: Record<string, Record<string, string>> = {}) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `echo "$PWD $*" >> ${log}`,
      'case "$1" in',
      "  ready) if [ -e .beads/ready.json ]; then cat .beads/ready.json; else printf '%s' '[]'; fi;;",
      '  children) if [ -e ".beads/children-$2.json" ]; then cat ".beads/children-$2.json"; else printf \'%s\' \'[]\'; fi;;',
      "  list) if [ -e .beads/list.json ]; then cat .beads/list.json; else printf '%s' '[]'; fi;;",
      '  dolt) if [ "$2" = show ]; then',
      `      printf '%s' '{"host":"127.0.0.1","port":3306,"database":"beads","user":"root","tls":false}'`,
      '    else echo origin; fi;;',
      '  sync)',
      '    if [ -e .beads/hang ]; then exec sleep 600; fi',
      '    if [ -e .beads/slow ]; then sleep 3; echo "sync failed: remote is down" >&2; exit 1; fi',
      '    echo ok;;',
      '  *) exit 0;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
  writeFileSync(join(bin, 'dolt'), '#!/bin/sh\nexec sleep 600\n')
  chmodSync(join(bin, 'dolt'), 0o755)
  writeFileSync(
    join(bin, 'herdr'),
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${join(dir, 'wt')}"}}}';;`,
      '  "worktree remove") exit 0;;',
      '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'herdr'), 0o755)
  const repos = names.map(n => {
    const r = join(dir, n)
    mkdirSync(join(r, '.beads'), { recursive: true })
    Bun.spawnSync(['git', '-C', r, 'init', '-q'])
    Bun.spawnSync([
      'git',
      '-C',
      r,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'i',
    ])
    for (const [file, text] of Object.entries(marks[n] ?? {})) writeFileSync(join(r, '.beads', file), text)
    return r
  })
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify(
      names.map((name, i) => ({
        name,
        repo: repos[i],
        factory: 'lifecycle',
        ...(marks[name]?.remote !== undefined && { beadsRemote: { name: 'vm', url: 'u', user: 'acme' } }),
      })),
    ),
  )
  return repos
}

const syncCalls = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(l => / sync( |$)/.test(l)).length
    : 0
const syncJson = () => JSON.parse(readFileSync(join(home, 'sync.json'), 'utf8'))
const dispatchJson = () =>
  JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8')) as Record<string, unknown>[]
const bead = JSON.stringify([{ id: 'acme-b-1', title: 't', labels: ['factory'] }])

test('dispatch makes no sync call, and a hung sync in one rig does not hold another rig start (AC1)', () => {
  setup(['acme-a', 'acme-b'], { 'acme-a': { hang: '' }, 'acme-b': { 'ready.json': bead } })
  const r = factory(['beads'])
  expect(r.code).toBe(0)
  expect(readdirSync(join(home, 'runs'))).toHaveLength(1)
  expect(syncCalls()).toBe(0)
  expect(r.ms).toBeLessThan(30_000)
})

test('factory sync kills a hung sync at the cap and records it; the other rig still syncs (AC4)', () => {
  const [a, b] = setup(['acme-a', 'acme-b'], { 'acme-a': { hang: '' } })
  const r = factory(['sync'], { FACTORY_SYNC_TIMEOUT_MS: '1500' })
  expect(r.code).toBe(0)
  expect(r.ms).toBeLessThan(10_000)
  const s = syncJson()
  expect(s[a!].error).toBe('bd sync: timed out after 2 s')
  expect(s[b!].error).toBeUndefined()
  expect(s[b!].failures).toBe(0)
  expect(typeof s[a!].ms).toBe('number')
})

test('a beadsRemote rig with a hung dolt is killed at the cap and recorded; the other rig still syncs', () => {
  const [a, b] = setup(['acme-a', 'acme-b'], { 'acme-a': { remote: '' } })
  const r = factory(['sync'], { FACTORY_SYNC_TIMEOUT_MS: '1500' })
  expect(r.code).toBe(0)
  expect(r.ms).toBeLessThan(10_000)
  const s = syncJson()
  expect(s[a!].error).toBe('beads pull: timed out after 2 s')
  expect(s[b!].error).toBeUndefined()
})

test('factory sync runs 11 failing rigs in parallel (AC3)', () => {
  const names = Array.from({ length: 11 }, (_, i) => `acme-${i}`)
  setup(names, Object.fromEntries(names.map(n => [n, { slow: '' }])))
  const r = factory(['sync'])
  expect(r.ms).toBeLessThan(15_000)
  expect(syncCalls()).toBe(11)
  expect(Object.values(syncJson()).every(e => (e as { failures: number }).failures === 1)).toBe(true)
  const b = factory(['beads'])
  expect(b.ms).toBeLessThan(60_000)
})

test('a rig in its backoff gets no sync call; the next failure doubles the wait; the board row says so (AC2, AC5)', () => {
  const [a] = setup(['acme-a'], { 'acme-a': { slow: '' } })
  factory(['sync'])
  expect(syncCalls()).toBe(1)
  const first = syncJson()[a!]
  expect(first.nextAt - first.at).toBe(5 * 60_000)
  factory(['sync'])
  expect(syncCalls()).toBe(1) // inside the wait
  writeFileSync(join(home, 'sync.json'), JSON.stringify({ [a!]: { ...first, nextAt: Date.now() - 1 } }))
  factory(['sync'])
  expect(syncCalls()).toBe(2)
  const second = syncJson()[a!]
  expect(second.failures).toBe(2)
  expect(second.nextAt - second.at).toBe(10 * 60_000)
  factory(['beads'])
  const row = dispatchJson().find(x => x.id === 'rig:acme-a')
  expect(row?.error).toMatch(/^bd sync: sync failed: remote is down \(sync failed 2x, next try \d\d:\d\d\)$/)
})

const oneRig = (marks: Record<string, string>, maxRuns: number) => {
  const [a] = setup(['acme-a'], { 'acme-a': marks })
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'acme-a', repo: a, factory: 'lifecycle', maxRuns }]),
  )
}

test('dispatch.json names why each ready bead did not start; tick drops those rows (AC6)', () => {
  const ready = JSON.stringify([
    { id: 'kid', title: 't', labels: ['factory'], parent: 'acme-e' },
    { id: 'asg', title: 't', labels: ['factory'], assignee: 'bob' },
    { id: 'par', title: 't', labels: ['factory'] },
    { id: 's1', title: 't', labels: ['factory'] },
    { id: 's2', title: 't', labels: ['factory'] },
  ])
  oneRig(
    {
      'ready.json': ready,
      'children-par.json': JSON.stringify([{ id: 'par.1', title: 'c', status: 'open' }]),
    },
    1,
  )
  factory(['beads'])
  const rows = dispatchJson().filter(x => x.skip)
  const skip = Object.fromEntries(rows.map(x => [x.id, x.skip]))
  expect(skip).toEqual({
    kid: 'child of acme-e',
    asg: 'assigned to bob',
    par: 'open children',
    s2: 'rig full 1/1',
  })
  expect(rows.every(x => x.rig === 'acme-a')).toBe(true)
  expect(readdirSync(join(home, 'runs'))).toHaveLength(1)
  const t = JSON.parse(factory(['tick']).out) as { runs: Record<string, unknown>[] }
  expect(t.runs.some(r => r.skip)).toBe(false)
  expect(t.runs.some(r => ['kid', 'asg', 'par', 's2'].includes(String(r.id)))).toBe(false)
})

test('a full rig gets one row and no bd ready call (AC6)', () => {
  oneRig({ 'ready.json': bead }, 0)
  factory(['beads'])
  expect(dispatchJson().filter(x => x.skip)).toEqual([
    { id: 'rig:acme-a', rig: 'acme-a', skip: 'rig full 0/0' },
  ])
  expect(existsSync(log) ? readFileSync(log, 'utf8') : '').not.toContain(' ready')
})

// A factory parent with open children and no live run never starts itself, so its child starts too.
test('a factory child starts when its parent has no live run, labeled parent or not (AC7)', () => {
  const kid = { id: 'kid', title: 't', labels: ['factory'], parent: 'acme-e' }
  const listing = (epicLabels: string[]) =>
    JSON.stringify([{ id: 'acme-e', title: 'epic', labels: epicLabels, status: 'open' }, kid])
  oneRig({ 'ready.json': JSON.stringify([kid]), 'list.json': listing([]) }, 5)
  factory(['beads'])
  expect(readdirSync(join(home, 'runs'))).toHaveLength(1)
  expect(dispatchJson().filter(x => x.skip)).toEqual([])

  oneRig({ 'ready.json': JSON.stringify([kid]), 'list.json': listing(['factory']) }, 5)
  factory(['beads'])
  expect(readdirSync(join(home, 'runs'))).toHaveLength(1)
  expect(dispatchJson().filter(x => x.skip)).toEqual([])
})
