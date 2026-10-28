// shipPass() starts one ship run for each rig whose ship queue holds a bead (claude-factory-rtuw).
// It drives the real pass through `factory beads` with a fake bd and herdr, as dispatch.test.ts does.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shipStarts } from './cli'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `shippass-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${bin}:${laptop.PATH}`,
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
      FACTORY_SELF_UPDATE: '0',
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** a repo is queued when its .beads/queue file exists: the fake bd lists one ship bead for it */
function setup(rigs: { name: string; queued: boolean }[]) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'claude-config'), { recursive: true })
  writeFileSync(join(dir, 'claude-config', '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  const bead = JSON.stringify([
    { id: 'acme-1', title: 't', labels: ['ship'], metadata: { ship_at: '2026-10-20T00:00:00Z' } },
  ])
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      'case "$1" in',
      `  list) if [ -e .beads/queue ]; then printf '%s' '${bead}'; else printf '%s' '[]'; fi;;`,
      `  ready|blocked|children) printf '%s' '[]';;`,
      '  dolt) echo "No remotes configured";;',
      '  *) exit 0;;',
      'esac',
    ].join('\n'),
  )
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
  chmodSync(join(bin, 'bd'), 0o755)
  chmodSync(join(bin, 'herdr'), 0o755)
  const defs = rigs.map(r => {
    const repo = join(dir, r.name)
    mkdirSync(join(repo, '.beads'), { recursive: true })
    if (r.queued) writeFileSync(join(repo, '.beads', 'queue'), '')
    Bun.spawnSync(['git', '-C', repo, 'init', '-q'])
    Bun.spawnSync([
      'git',
      '-C',
      repo,
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
    return { name: r.name, repo, factory: 'lifecycle' }
  })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify(defs))
  return defs
}

const runs = () =>
  existsSync(join(home, 'runs'))
    ? readdirSync(join(home, 'runs'))
        .filter(id => existsSync(join(home, 'runs', id, 'run.json')))
        .map(id => ({
          id,
          ...JSON.parse(readFileSync(join(home, 'runs', id, 'run.json'), 'utf8')),
        }))
    : []

test('shipStarts picks the repos with a queue and no live ship run', () => {
  const queued = (r: string) => ({ a: 2, b: 0, c: 1 })[r] ?? 0
  expect(shipStarts(['a', 'b', 'c'], queued, new Set())).toEqual(['a', 'c'])
  expect(shipStarts(['a', 'b', 'c'], queued, new Set(['a']))).toEqual(['c'])
})

test('a rig with a queue gets one ship run, flagged; a second pass starts none; an empty rig gets none', () => {
  const [a, b] = setup([
    { name: 'a', queued: true },
    { name: 'b', queued: false },
  ])
  expect(factory(['beads']).code).toBe(0)
  const first = runs()
  expect(first).toHaveLength(1)
  expect(first[0]!.id).toStartWith('ship-')
  expect(first[0]!.repo).toBe(a!.repo)
  expect(first[0]!.ship).toBe(true)
  expect(first[0]!.bead).toBeUndefined()
  expect(factory(['beads']).code).toBe(0)
  expect(runs()).toHaveLength(1)
  expect(runs().some(r => r.repo === b!.repo)).toBe(false)
})

test('two queued rigs get one ship run each', () => {
  setup([
    { name: 'a', queued: true },
    { name: 'b', queued: true },
  ])
  factory(['beads'])
  factory(['beads'])
  const repos = runs().map(r => r.repo)
  expect(repos).toHaveLength(2)
  expect(new Set(repos).size).toBe(2)
})

test('a ship run starts even with FACTORY_MAX_RUNS=0: it takes no room', () => {
  setup([{ name: 'a', queued: true }])
  factory(['beads'], { FACTORY_MAX_RUNS: '0' })
  expect(runs().filter(r => r.ship)).toHaveLength(1)
})

test('a live ship run holds no slot, but a work run still does', () => {
  setup([{ name: 'a', queued: true }])
  factory(['beads'])
  const { id, ...rest } = runs()[0]!
  const env = { FACTORY_MAX_RUNS: '1' }
  expect(factory(['start', 'lifecycle', 'a', 'work'], env).err).not.toContain('runs are busy')
  // the same run without the runner's flag counts, so the cap bites
  writeFileSync(join(home, 'runs', id, 'run.json'), JSON.stringify({ ...rest, id, ship: undefined }))
  rmSync(join(home, 'runs', runs().find(r => r.id !== id)!.id), { recursive: true })
  expect(factory(['start', 'lifecycle', 'a', 'more work'], env).err).toContain('runs are busy')
})

test('factory start ship is refused: only the runner starts a ship run', () => {
  const [a] = setup([{ name: 'a', queued: true }])
  factory(['beads'])
  expect(runs()).toHaveLength(1)
  const out = factory(['start', 'ship', 'a', 'again'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('only the runner starts a ship run')
  expect(runs().filter(r => r.repo === a!.repo)).toHaveLength(1)
})
