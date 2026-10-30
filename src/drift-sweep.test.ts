// Tests the drift sweep (claude-factory-d20). "factory sweep" runs the rig's drift command on the laptop.
// Every due pass starts a run at the drift station. There is no unchanged skip.
// The mail holds the current read and the previous read with its time.
// A rig with no drift command never starts a drift run. A marker file stands in for the command.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `drift-sweep-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const marker = join(dir, 'marker.txt')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0' },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

function fakeTools() {
  mkdirSync(bin, { recursive: true })
  const worktree = join(dir, 'worktree-stub')
  const herdr = [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${worktree}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'herdr'), herdr)
  chmodSync(join(bin, 'herdr'), 0o755)
  writeFileSync(
    join(bin, 'bd'),
    ['#!/bin/sh', 'case "$1" in', "  create) printf 'acme-1';;", '  *) exit 0;;', 'esac'].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
}

function repo(name = 'repo') {
  const r = join(dir, name)
  mkdirSync(r, { recursive: true })
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
    'init',
  ])
  mkdirSync(join(r, '.beads'), { recursive: true })
  return r
}

/** `rig` is merged into the one rig "a"; `prior` seeds sweeps.json as a pass 61 minutes ago */
function reset(markerText: string, rig: Record<string, unknown> = {}, prior?: { read: string }) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = repo()
  fakeTools()
  writeFileSync(marker, markerText)
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([
      { name: 'a', repo: r, factory: 'lifecycle', sweeps: ['drift'], drift: `cat ${marker}`, ...rig },
    ]),
  )
  if (prior)
    writeFileSync(
      join(home, 'sweeps.json'),
      JSON.stringify({ a: { drift: { lastAt: Date.now() - 61 * 60_000, ...prior } } }),
    )
}

const journal = () =>
  existsSync(join(home, 'sweeps.jsonl'))
    ? readFileSync(join(home, 'sweeps.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []

const runCount = () => (existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0)
const inbox = (id: string) =>
  readFileSync(join(home, 'runs', id, 'inbox.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))

test('the first pass starts a run at drift, mailing the read and no previous read', () => {
  reset('apps False\n')
  expect(factory(['sweep']).code).toBe(0)
  expect(runCount()).toBe(1)
  const id = readdirSync(join(home, 'runs'))[0]!
  expect(journal()).toEqual([
    expect.objectContaining({ rig: 'a', sweep: 'drift', action: 'started', run: id }),
  ])
  const lines = inbox(id)
  expect(lines).toContainEqual(expect.objectContaining({ type: 'GOTO', node: 'drift' }))
  const mail = lines.find(l => l.type === 'MAIL' && l.to === 'drift')
  expect(mail.text).toContain('current read:\napps False')
  expect(mail.text).toContain('previous read: none')
  expect(JSON.parse(readFileSync(join(home, 'sweeps.json'), 'utf8')).a.drift.read).toBe('apps False')
})

test('an unchanged read still starts a run, with the previous read and its time in the mail', () => {
  reset('apps False\n', {}, { read: 'apps False' })
  expect(factory(['sweep']).code).toBe(0)
  expect(runCount()).toBe(1)
  expect(journal().map(j => j.action)).toEqual(['started'])
  const id = readdirSync(join(home, 'runs'))[0]!
  const mail = inbox(id).find(l => l.type === 'MAIL' && l.to === 'drift')
  expect(mail.text).toContain('current read:\napps False')
  expect(mail.text).toMatch(/previous read \(\d{4}-\d\d-\d\dT[^)]+\):\napps False/)
})

test('each read in the mail is clipped to 4 KiB', () => {
  reset('x'.repeat(10_000), {}, { read: 'y'.repeat(10_000) })
  factory(['sweep'])
  const id = readdirSync(join(home, 'runs'))[0]!
  const mail = inbox(id).find(l => l.type === 'MAIL' && l.to === 'drift')
  expect(mail.text).toContain('[clipped: 4096 of 10000 bytes]')
  expect(mail.text.length).toBeLessThan(9_000)
})

test('a rig with no drift command starts no drift run, even when --sweeps names it', () => {
  reset('apps False\n', { drift: undefined })
  expect(factory(['sweep']).code).toBe(0)
  expect(runCount()).toBe(0)
  expect(journal()).toEqual([])
})

test('a pass inside the hour is not due', () => {
  reset('apps False\n')
  writeFileSync(
    join(home, 'sweeps.json'),
    JSON.stringify({ a: { drift: { lastAt: Date.now() - 10 * 60_000 } } }),
  )
  factory(['sweep'])
  expect(runCount()).toBe(0)
})

function trackedRepo(name: string) {
  const r = join(dir, name)
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  return r
}

test('rig add refuses an explicit --sweeps drift with no --drift', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const out = factory(['rig', 'add', 'b', trackedRepo('b'), '--sweeps', 'drift'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('--drift')
  expect(existsSync(join(home, 'rigs.json'))).toBe(false)
})

test('rig add refuses an empty --drift', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const out = factory(['rig', 'add', 'd', trackedRepo('d'), '--drift', ''])
  expect(out.code).not.toBe(0)
  expect(existsSync(join(home, 'rigs.json'))).toBe(false)
})

test('rig add records --drift and factory rig prints it', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const cmd = 'flux get kustomizations -A'
  const out = factory(['rig', 'add', 'c', trackedRepo('c'), '--sweeps', 'drift', '--drift', cmd])
  expect(out.code).toBe(0)
  expect(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0].drift).toBe(cmd)
  expect(factory(['rig']).out).toContain(`drift: ${cmd}`)
})
