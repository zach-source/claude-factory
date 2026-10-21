// claude-factory-8bg: the hygiene sweep end to end, with a fake bd and a fake gh on PATH.
// Fixtures use acme/widget names only.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `hygiene-cli-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const calls = join(dir, 'calls.log')
const listFile = join(dir, 'list.json')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()
const bead = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  title: `widget task ${id}`,
  status: 'open',
  created_at: iso(60),
  updated_at: iso(30),
  ...o,
})

/** ghMode 'ok' lists the merged PRs; 'fail' exits 1 with text that must never reach a bead */
function setup(beads: unknown[], ghMode: 'ok' | 'fail' = 'ok', github = true) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', repo, 'init', '-q'])
  if (github)
    Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git'])
  writeFileSync(listFile, JSON.stringify(beads))
  const prs = [
    {
      number: 7,
      url: 'https://github.com/acme/widget/pull/7',
      title: 'Fix acme-1: retry',
      headRefName: 'x',
      mergeCommit: { oid: 'abc123' },
    },
  ]
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${calls}'`,
      'case "$1" in',
      `  list) cat '${listFile}';;`,
      "  comments) printf '%s' '[]';;",
      "  create) printf '%s' 'acme-digest';;",
      '  *) exit 0;;',
      'esac',
    ].join('\n'),
  )
  writeFileSync(
    join(bin, 'gh'),
    ghMode === 'ok'
      ? ['#!/bin/sh', `printf '%s' '${JSON.stringify(prs)}'`].join('\n')
      : ['#!/bin/sh', "echo 'SECRET-TOKEN-xyz boom' >&2", 'exit 1'].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'a', repo, factory: 'lifecycle', sweeps: ['hygiene'] }]),
  )
}

const callLines = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [])
const writes = () => callLines().filter(l => !/^(list|comments)\b/.test(l))
const journal = () =>
  readFileSync(join(home, 'sweeps.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))

test('a pass proposes, stamps, labels and comments; one unlabeled digest; never closes (AC1, AC4, AC11)', () => {
  setup([bead('acme-1'), bead('acme-2')])
  expect(factory(['sweep']).code).toBe(0)
  const verbs = callLines()
    .map(l => l.split(' ')[0])
    .join(' ')
  expect(verbs).not.toMatch(/\b(close|defer|reopen|unclaim)\b/)
  expect(callLines().join('\n')).not.toContain('--status')
  const creates = callLines().filter(l => l.startsWith('create'))
  expect(creates).toHaveLength(1)
  expect(creates[0]).not.toMatch(/(^| )-l( |$)/)
  expect(callLines().filter(l => l.includes('proposed close: shipped: '))).toHaveLength(1)
  expect(callLines().filter(l => l.includes('proposed close: stale: '))).toHaveLength(1)
  expect(callLines().filter(l => l.includes('--add-label stale?'))).toHaveLength(2)
  expect(callLines().filter(l => l.includes('hygiene_proposed='))).toHaveLength(2)
  expect(journal()[0]).toMatchObject({
    rig: 'a',
    sweep: 'hygiene',
    action: 'hygiene',
    proposed: 2,
    digest: 'acme-digest',
  })
  expect(journal()[0].kinds).toEqual({ shipped: 1, stale: 1 })
  expect(existsSync(join(home, 'runs'))).toBe(false) // no run started
})

test('25 candidates give 20 proposals (AC3)', () => {
  setup(Array.from({ length: 25 }, (_, i) => bead(`acme-${i + 10}`)))
  factory(['sweep'])
  expect(callLines().filter(l => l.includes('proposed close: '))).toHaveLength(20)
  expect(callLines().filter(l => l.includes('--add-label stale?'))).toHaveLength(20)
  expect(callLines().filter(l => l.includes('hygiene_proposed='))).toHaveLength(20)
  expect(callLines().filter(l => l.startsWith('create'))).toHaveLength(1)
})

test('no finding: no write and no digest; a rerun with stamped beads writes nothing (AC4)', () => {
  setup([bead('acme-3', { updated_at: iso(1) })])
  factory(['sweep'])
  expect(writes()).toEqual([])
  expect(journal()[0]).toMatchObject({ action: 'hygiene', proposed: 0 })
  setup([bead('acme-3', { labels: ['stale?'], metadata: { hygiene_proposed: 'stale@x' } })])
  factory(['sweep'])
  expect(writes()).toEqual([])
})

test('a gh failure skips only shipped, logs ghError and leaks no gh text (AC9, AC10)', () => {
  setup([bead('acme-1')], 'fail')
  factory(['sweep'])
  const row = journal()[0]
  expect(row.ghError).toContain('gh failed')
  expect(callLines().filter(l => l.includes('proposed close: stale: '))).toHaveLength(1)
  expect(callLines().join('\n')).not.toContain('SECRET-TOKEN')
  expect(readFileSync(join(home, 'sweeps.jsonl'), 'utf8')).not.toContain('SECRET-TOKEN')
})

test('a non-GitHub rig still files the other kinds (AC9)', () => {
  setup([bead('acme-1')], 'ok', false)
  factory(['sweep'])
  expect(journal()[0].ghError).toContain('not a GitHub')
  expect(callLines().filter(l => l.includes('proposed close: stale: '))).toHaveLength(1)
  expect(callLines().filter(l => l.includes('proposed close: shipped: '))).toHaveLength(0)
})

test('FACTORY_HYGIENE=0 makes no bd write and logs off (AC11)', () => {
  setup([bead('acme-1')])
  factory(['sweep'], { FACTORY_HYGIENE: '0' })
  expect(callLines()).toEqual([])
  expect(journal()[0]).toMatchObject({ sweep: 'hygiene', action: 'off' })
})

test('lastAt is written, and a second sweep inside the window does nothing (AC11)', () => {
  setup([bead('acme-1')])
  factory(['sweep'])
  const n = callLines().length
  expect(typeof JSON.parse(readFileSync(join(home, 'sweeps.json'), 'utf8')).a.hygiene.lastAt).toBe('number')
  factory(['sweep'])
  expect(callLines()).toHaveLength(n)
})

test('factory hygiene <rig> prints findings as JSON and writes nothing (AC12)', () => {
  setup([bead('acme-1'), bead('acme-2')])
  const out = factory(['hygiene', 'a'])
  expect(out.code).toBe(0)
  const j = JSON.parse(out.out)
  expect(j.findings.map((f: { id: string; kind: string }) => `${f.id}:${f.kind}`).sort()).toEqual([
    'acme-1:shipped',
    'acme-2:stale',
  ])
  expect(writes()).toEqual([])
})
