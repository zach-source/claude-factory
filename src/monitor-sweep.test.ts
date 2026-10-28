// Tests monitor's deterministic read (claude-factory-8pc.6, AC6). `factory sweep` runs a rig's
// `--slo` command itself, on the laptop. When its output has the same sig as the last pass, no run
// starts: the factory logs action 'unchanged' and never reads the output with a model. When the sig
// changed, one run starts at the monitor station, carrying the command's output as mail, clipped to
// 4 KiB. A marker file stands in for the real command: a test switches its content to change the
// read between passes, instead of needing a real cluster.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sigOf } from './sweeps'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `monitor-sweep-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const marker = join(dir, 'marker.txt')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0' },
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

/** a minimal fake `bd`: `create` answers one fixed id (claude-factory-8pc.19: sweep() now refuses
 * a due sweep with no bd to read at all, so monitor's own tests need one too). */
function fakeBd() {
  mkdirSync(bin, { recursive: true })
  const script = ['#!/bin/sh', 'case "$1" in', "  create) printf 'acme-1';;", '  *) exit 0;;', 'esac'].join(
    '\n',
  )
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

/** a repo with a `.beads` dir: the flood guard can read bd for it, so a due sweep may start */
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
  mkdirSync(join(r, '.beads'), { recursive: true })
  return r
}

/** `markerText` is what the fake `--slo` command ("cat <marker>") reads this pass. `priorSig`, when
 * given, seeds sweeps.json as if a pass 31 minutes ago (past monitor's 30 min cadence) already read
 * that sig: with none, the rig is due with no prior sig at all, as a fresh rig is. */
function reset(markerText: string, priorSig?: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = repo()
  fakeHerdr()
  fakeBd()
  writeFileSync(marker, markerText)
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle', sweeps: ['monitor'], slo: `cat ${marker}` }]),
  )
  if (priorSig !== undefined)
    writeFileSync(
      join(home, 'sweeps.json'),
      JSON.stringify({ a: { monitor: { lastAt: Date.now() - 31 * 60_000, sig: priorSig, lines: 1 } } }),
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

const runCount = () => (existsSync(join(home, 'runs')) ? readdirSync(join(home, 'runs')).length : 0)

test('the first pass has no prior sig, so it starts a run carrying the read as mail', () => {
  reset('all green\n')
  const out = factory(['sweep'])
  expect(out.code).toBe(0)
  expect(runCount()).toBe(1)
  const runId = readdirSync(join(home, 'runs'))[0]!
  expect(journal()).toEqual([
    expect.objectContaining({ rig: 'a', sweep: 'monitor', action: 'started', run: runId }),
  ])
  const lines = readFileSync(join(home, 'runs', runId, 'inbox.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  expect(lines).toContainEqual(expect.objectContaining({ type: 'GOTO', node: 'monitor' }))
  expect(lines).toContainEqual(expect.objectContaining({ type: 'MAIL', to: 'monitor', text: 'all green' }))
  const st = JSON.parse(readFileSync(join(home, 'sweeps.json'), 'utf8')).a.monitor
  expect(st.sig).toBe(sigOf('all green'))
  expect(st.lines).toBe(1)
})

test('an unchanged read starts no run: no model ever sees output that did not change', () => {
  reset('all green\n', sigOf('all green'))
  const out = factory(['sweep'])
  expect(out.code).toBe(0)
  expect(runCount()).toBe(0)
  expect(journal()).toEqual([{ at: expect.any(Number), rig: 'a', sweep: 'monitor', action: 'unchanged' }])
  const st = JSON.parse(readFileSync(join(home, 'sweeps.json'), 'utf8')).a.monitor
  expect(st.sig).toBe(sigOf('all green')) // unchanged: still the same sig
})

test('a changed read starts a run, carrying the new output as mail, and records the new sig', () => {
  reset('error rate 12%\n', sigOf('all green')) // the prior pass read something else
  const out = factory(['sweep'])
  expect(out.code).toBe(0)
  expect(runCount()).toBe(1)
  const runId = readdirSync(join(home, 'runs'))[0]!
  expect(journal()).toEqual([
    expect.objectContaining({ rig: 'a', sweep: 'monitor', action: 'started', run: runId }),
  ])
  const lines = readFileSync(join(home, 'runs', runId, 'inbox.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  expect(lines).toContainEqual(
    expect.objectContaining({ type: 'MAIL', to: 'monitor', text: 'error rate 12%' }),
  )
  const st = JSON.parse(readFileSync(join(home, 'sweeps.json'), 'utf8')).a.monitor
  expect(st.sig).toBe(sigOf('error rate 12%'))
})

// --- `rig add` validation (claude-factory-8pc.6): monitor needs a command to read ---

function trackedRepo(name: string) {
  const r = join(dir, name)
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  return r
}

test('rig add refuses an explicit --sweeps monitor with no --slo', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = trackedRepo('b')
  const out = factory(['rig', 'add', 'b', r, '--sweeps', 'monitor,maintain'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('--slo')
  expect(existsSync(join(home, 'rigs.json'))).toBe(false)
})

test('rig add accepts --sweeps monitor once --slo is set, and records it', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = trackedRepo('c')
  const out = factory(['rig', 'add', 'c', r, '--sweeps', 'monitor', '--slo', 'kubectl get pods -A'])
  expect(out.code).toBe(0)
  const rigs = JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))
  expect(rigs[0].slo).toBe('kubectl get pods -A')
  expect(rigs[0].sweeps).toEqual(['monitor'])
})

test('rig add --slo "" (empty) is refused: a command is required, not just the flag', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const r = trackedRepo('d')
  const out = factory(['rig', 'add', 'd', r, '--slo', ''])
  expect(out.code).not.toBe(0)
  expect(existsSync(join(home, 'rigs.json'))).toBe(false)
})
