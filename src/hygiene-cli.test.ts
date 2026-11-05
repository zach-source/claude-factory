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
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
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
  // the REST `pulls?state=closed` answer: one merged pull, one closed without a merge (hygiene keeps the first only)
  const pull = (number: number, merged: boolean) => ({
    number,
    html_url: `https://github.com/acme/widget/pull/${number}`,
    title: 'Fix acme-1: retry',
    state: 'closed',
    merged_at: merged ? '2026-10-12T10:00:00Z' : null,
    merge_commit_sha: merged ? 'abc123' : null,
    head: { ref: 'x', repo: { full_name: 'acme/widget' } },
    base: { ref: 'main', repo: { full_name: 'acme/widget' } },
  })
  const prs = [pull(7, true), pull(8, false)]
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${calls}'`,
      'case "$1" in',
      `  list) cat '${listFile}';;`,
      "  comments) printf '%s' '[]';;",
      `  show) printf '%s' '[{"id":"acme-1","labels":["factory","stale?"]}]';;`,
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
  const log = callLines().join('\n')
  expect(log).toContain('--metadata {"factory_create":')
  expect(log.match(/hygiene_digest/g)).toHaveLength(1)
  expect(callLines().filter(l => l.startsWith('update') && l.includes('hygiene_digest'))).toHaveLength(0)
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

test('factory queue <bead> <station> on a Linear-sourced bead refuses and adds no label (claude-factory-8qk)', () => {
  setup([])
  const show = (ref: string) =>
    writeFileSync(
      join(bin, 'bd'),
      readFileSync(join(bin, 'bd'), 'utf8').replace(
        /  show\) .*\n/,
        `  show) printf '%s' '[{"id":"acme-1","labels":["factory"],"external_ref":"${ref}"}]';;\n`,
      ),
    )
  show('https://linear.app/acme/issue/X-1')
  const r = factory(['queue', 'a', 'acme-1', 'review'])
  expect(r.code).not.toBe(0)
  expect(r.err + r.out).toContain('comes from Linear')
  expect(r.err + r.out).toContain('factory fork')
  expect(callLines().some(l => l.startsWith('update acme-1'))).toBe(false)
  // without a station it still queues
  expect(factory(['queue', 'a', 'acme-1']).code).toBe(0)
  // a non-Linear bead still queues at the station
  show('https://github.com/acme/widget/issues/1')
  expect(factory(['queue', 'a', 'acme-1', 'review']).code).toBe(0)
  expect(
    callLines().some(l => l.startsWith('update acme-1') && l.includes('--add-label station:review')),
  ).toBe(true)
})

test('factory queue removes the stale label so a held bead starts again (AC13)', () => {
  setup([])
  expect(factory(['queue', 'a', 'acme-1']).code).toBe(0)
  const upd = callLines().find(l => l.startsWith('update acme-1'))
  expect(upd).toContain('--remove-label stale?')
})

// claude-factory-7a7e: a patrol cannot queue a bead from another rig, or a child of one
test('factory queue under FACTORY_PATROL refuses discovered_from without the factory label (7a7e)', () => {
  setup([])
  const rows = (o: Record<string, unknown>) =>
    writeFileSync(
      join(bin, 'bd'),
      readFileSync(join(bin, 'bd'), 'utf8').replace(
        /  show\) .*\n/,
        `  show) case "$2" in ${Object.entries(o)
          .map(([id, r]) => `${id}) printf '%s' '${JSON.stringify([{ id, ...(r as object) }])}';;`)
          .join(' ')} *) exit 1;; esac;;\n`,
      ),
    )
  const msg = 'a patrol cannot start it: a person queues it'
  const patrol = { FACTORY_PATROL: '1' }
  const from = { metadata: { discovered_from: 'other-9' } }
  const refuses = (id: string) => {
    const r = factory(['queue', 'a', id], patrol)
    expect(r.code).not.toBe(0)
    expect(r.err + r.out).toContain(msg)
    expect(callLines().some(l => l.startsWith(`update ${id}`))).toBe(false)
  }
  rows({ 'acme-1': from })
  refuses('acme-1')
  rows({ 'acme-1': from, 'acme-1.1': { parent: 'acme-1' } }) // a child of such a bead
  refuses('acme-1.1')
  rows({ 'acme-1.1': { parent: 'acme-1' } }) // a parent that cannot be read
  refuses('acme-1.1')
  // allowed: a person, or the factory label present
  rows({ 'acme-1': from })
  expect(factory(['queue', 'a', 'acme-1']).code).toBe(0)
  rows({ 'acme-1': { ...from, labels: ['factory'] } })
  expect(factory(['queue', 'a', 'acme-1'], patrol).code).toBe(0)
})
