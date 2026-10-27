// dispatch() starts no local run while commit signing is down, and shows one 'signing' row
// (claude-factory-8je). The signing config reaches the spawned CLI through GIT_CONFIG_COUNT env.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `dispatch-signing-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const marker = join(dir, 'marker')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(gpgsign: string, program: string) {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const conf = [
    ['user.name', 't'],
    ['user.email', 't@t'],
    ['commit.gpgsign', gpgsign],
    ['gpg.format', 'ssh'],
    ['user.signingkey', join(dir, 'key.pub')],
    ['gpg.ssh.program', program],
  ]
  const env: Record<string, string> = {
    ...(laptop as Record<string, string>),
    FACTORY_HOME: home,
    PATH: `${bin}:${laptop.PATH}`,
    CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
    FACTORY_SELF_UPDATE: '0',
    GIT_CONFIG_COUNT: String(conf.length),
  }
  conf.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k!
    env[`GIT_CONFIG_VALUE_${i}`] = v!
  })
  const p = Bun.spawnSync([CLI, 'beads'], { env })
  expect(p.exitCode).toBe(0)
}

function signer(body: string) {
  const p = join(dir, 'signer')
  writeFileSync(p, `#!/bin/sh\necho x >> ${marker}\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const failing = () => signer('echo "agent refused" >&2; exit 1')
const calls = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0)

function repo(name: string) {
  const r = join(dir, name)
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  Bun.spawnSync(
    ['git', '-C', r, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'].concat([
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'init',
    ]),
  )
  return r
}

/** ready=false: `bd ready` answers no bead; 'unlabeled': one ready leaf without the factory label */
function setup(rigs: Record<string, unknown>[], ready: boolean | 'unlabeled' = true) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'claude-config'), { recursive: true })
  writeFileSync(join(dir, 'claude-config', '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  const beads = JSON.stringify(
    ready
      ? [{ id: 'acme-1', title: 't', priority: 1, status: 'open', labels: ready === true ? ['factory'] : [] }]
      : [],
  )
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      'case "$1" in',
      `  ready) printf '%s' '${beads}';;`,
      "  children) printf '%s' '[]';;",
      `  list) printf '%s' '${beads}';;`,
      '  dolt) echo "No remotes configured";;',
      '  *) exit 0;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
  writeFileSync(
    join(bin, 'herdr'),
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${join(dir, 'wt')}"}}}';;`,
      '  "worktree remove") exit 0;;',
      '  *) exit 1;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'herdr'), 0o755)
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify(rigs.map(r => ({ factory: 'lifecycle', ...r, repo: repo(String(r.name)) }))),
  )
}

const runDirs = () => (existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')) : [])
const rows = () => JSON.parse(readFileSync(join(home, 'dispatch.json'), 'utf8')) as Record<string, string>[]
const signingRows = () => rows().filter(r => r.id === 'signing')

test('a failing signer starts no run, shows one signing row and marks the bead', () => {
  setup([{ name: 'a' }])
  run('true', failing())
  expect(runDirs()).toHaveLength(0)
  expect(signingRows()).toHaveLength(1)
  expect(signingRows()[0]!.error).toContain('Unlock the signing agent')
  expect(rows().find(r => r.id === 'acme-1')?.skip).toBe('commit signing down')
})

test('two local rigs share one probe and one signing row', () => {
  setup([{ name: 'a' }, { name: 'b' }])
  run('true', failing())
  expect(signingRows()).toHaveLength(1)
  expect(calls()).toBe(1)
})

test('after the signer recovers, the next pass starts the run and drops the row', () => {
  setup([{ name: 'a' }])
  run('true', failing())
  expect(signingRows()).toHaveLength(1)
  const key = join(dir, 'key')
  Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key])
  rmSync(join(home, 'dispatch.stamp'))
  run('true', 'ssh-keygen')
  expect(runDirs()).toHaveLength(1)
  expect(signingRows()).toHaveLength(0)
})

test('no probe runs for an ax rig', () => {
  setup([{ name: 'a', runner: 'ax' }])
  run('true', failing())
  expect(calls()).toBe(0)
  expect(signingRows()).toHaveLength(0)
})

test('no probe runs for a rig with no ready bead and no autoQueue', () => {
  setup([{ name: 'a' }], false)
  run('true', failing())
  expect(calls()).toBe(0)
  expect(signingRows()).toHaveLength(0)
})

test('no probe runs for a full rig', () => {
  setup([{ name: 'a', maxRuns: 0 }])
  run('true', failing())
  expect(calls()).toBe(0)
  expect(signingRows()).toHaveLength(0)
})

test('a local autoQueue rig with only an unlabeled bead probes, starts nothing and shows one row', () => {
  setup([{ name: 'a', autoQueue: { minPriority: 4, perHour: 10 } }], 'unlabeled')
  run('true', failing())
  expect(calls()).toBe(1)
  expect(runDirs()).toHaveLength(0)
  expect(signingRows()).toHaveLength(1)
})

test('no probe runs when commit.gpgsign is false, and the run starts', () => {
  setup([{ name: 'a' }])
  run('false', failing())
  expect(calls()).toBe(0)
  expect(runDirs()).toHaveLength(1)
})
