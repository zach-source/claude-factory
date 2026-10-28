// This tests `factory sweep` end to end (claude-factory-8pc.3, AC2).
// It must start one run for each due (rig, sweep) pair, under factory "sweeps" (factories/sweeps.ts).
// It must post no GOTO when the due station is that factory's own start ('maintain').
// A second call inside the same window must start no run.
// The rig's repo carries a `.beads` dir and a minimal fake `bd` (claude-factory-8pc.19): the flood
// guard needs bd to cap sweep-filed beads, so sweep() now refuses to run a due sweep with no bd at
// all. A separate repo with no `.beads` (noBeadsRepo below) proves that refusal.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `sweep-cli-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** fake herdr: only `worktree create` answers (createRun's only external call with no `.beads`) */
function fakeHerdr() {
  mkdirSync(bin, { recursive: true })
  const worktree = join(dir, 'worktree-stub')
  const script = [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${worktree}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'herdr'), script)
  chmodSync(join(bin, 'herdr'), 0o755)
}

/** a minimal fake `bd`: `create` answers one fixed id, anything else is a harmless no-op. sweep()
 * itself only ever calls `beadFor`'s `bd create` for a goal shaped like `sweep: <station>`
 * (never a bead id, so `lookup` and `prefixStrict` are never reached). */
function fakeBd() {
  mkdirSync(bin, { recursive: true })
  const script = ['#!/bin/sh', 'case "$1" in', "  create) printf 'acme-1';;", '  *) exit 0;;', 'esac'].join(
    '\n',
  )
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

function gitRepo(name: string) {
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
  return r
}

/** a repo with a `.beads` dir: the flood guard can read bd for it, so a due sweep may start */
function repo() {
  const r = gitRepo('repo')
  mkdirSync(join(r, '.beads'), { recursive: true })
  return r
}

/** a repo with no `.beads` at all (claude-factory-8pc.19): the flood guard has no bd to read, so a
 * due sweep must not start for it. */
function noBeadsRepo() {
  return gitRepo('repo-no-beads')
}

function reset(sweeps: string[]) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = repo()
  fakeHerdr()
  fakeBd()
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle', sweeps }]),
  )
  return r
}

const journal = () =>
  existsSync(join(home, 'sweeps.jsonl'))
    ? readFileSync(join(home, 'sweeps.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []

test("factory sweep starts one run at the due station, parked with no GOTO when it is the factory's own start", () => {
  reset(['maintain'])
  const out = factory(['sweep'])
  expect(out.code).toBe(0)
  const runs = readdirSync(join(home, 'runs'))
  expect(runs).toHaveLength(1)
  const run = JSON.parse(readFileSync(join(home, 'runs', runs[0]!, 'run.json'), 'utf8'))
  expect(run.goal).toBe('sweep: maintain')
  expect(existsSync(join(home, 'runs', runs[0]!, 'inbox.jsonl'))).toBe(false) // no GOTO: maintain is the start
  const lines = journal()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ rig: 'a', sweep: 'maintain', action: 'started' })
  const state = JSON.parse(readFileSync(join(home, 'sweeps.json'), 'utf8'))
  expect(typeof state.a.maintain.lastAt).toBe('number')
})

test('a second factory sweep call inside the same window starts no second run', () => {
  reset(['maintain'])
  factory(['sweep'])
  expect(readdirSync(join(home, 'runs'))).toHaveLength(1)
  const out = factory(['sweep'])
  expect(out.code).toBe(0)
  expect(readdirSync(join(home, 'runs'))).toHaveLength(1) // still one: maintain is not due again today
  expect(journal()).toHaveLength(1) // nothing due: no new line, not even a no-op one
})

test('rig.sweeps: [] (--sweeps none) starts nothing, and writes no journal line', () => {
  reset([])
  const out = factory(['sweep'])
  expect(out.code).toBe(0)
  expect(existsSync(join(home, 'runs'))).toBe(false)
  expect(journal()).toHaveLength(0)
})

// claude-factory-8pc.14: a sweep run's id starts with its factory's own `name` field, not the spec
// a rig names. src/sweeps.ts's sweepFiler matches only a run id starting with `sweeps-`: a
// sweepsFactory (or a repo's own .factory/sweeps.ts) with a different `name` would file beads the
// flood guard never sees. `factory sweep` must refuse to run it, instead of running unguarded.
test("rig.sweepsFactory naming a factory whose own `name` is not 'sweeps' is refused: no run starts", () => {
  const r = reset(['maintain'])
  mkdirSync(join(r, '.factory'), { recursive: true })
  writeFileSync(
    join(r, '.factory', 'acme-sweeps.ts'),
    `export default { name: 'acme-sweeps', start: 'maintain', nodes: { maintain: { prompt: 'x', next: { filed: 'done' }, everyMin: 1440 } } }\n`,
  )
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle', sweepsFactory: 'acme-sweeps' }]),
  )
  const out = factory(['sweep'])
  expect(out.code).toBe(0)
  expect(existsSync(join(home, 'runs'))).toBe(false) // refused: the flood guard cannot see its beads
  expect(journal()).toHaveLength(0) // refused before any (rig, sweep) pass, same as a bad spec
  expect(out.err).toContain("'acme-sweeps', not 'sweeps'")
})

// claude-factory-8pc.19: with no `.beads` at all, the flood guard has no bd to cap sweep-filed
// beads with, and a worker's own `tracking()` brief falls back to `factory start` with no guard at
// all. `factory sweep` must refuse to start a due sweep for such a rig, logging 'no-beads' instead.
test('a rig with no .beads starts no sweep run: the flood guard has no bd to read for it', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = noBeadsRepo()
  fakeHerdr()
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle', sweeps: ['maintain'] }]),
  )
  const out = factory(['sweep'])
  expect(out.code).toBe(0)
  expect(existsSync(join(home, 'runs'))).toBe(false)
  const lines = journal()
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ rig: 'a', sweep: 'maintain', action: 'no-beads' })
})
