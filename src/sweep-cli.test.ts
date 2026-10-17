// This tests `factory sweep` end to end (claude-factory-8pc.3, AC2).
// It must start one run for each due (rig, sweep) pair, under factory "sweeps" (factories/sweeps.ts).
// It must post no GOTO when the due station is that factory's own start ('maintain').
// A second call inside the same window must start no run.
// The rig's repo here has no `.beads`. So beadFor skips bd outright (src/cli.ts:3880).
// The test needs no fake bd. It needs only a fake herdr, for the worktree-create call createRun always makes.
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
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
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

/** a plain repo, deliberately with no `.beads`: beadFor skips bd for it (claude-factory-8pc.3) */
function repo() {
  const r = join(dir, 'repo')
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

function reset(sweeps: string[]) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = repo()
  fakeHerdr()
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
