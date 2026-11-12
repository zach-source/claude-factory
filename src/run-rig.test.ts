// claude-factory-06xp: a live run keeps the rig settings it launched with (spec.md:143)
import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rigPaths } from './security-route'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const REPO = '/nonexistent/acme-widget'
const tmp = mkdtempSync(join(realpathSync(tmpdir()), 'run-rig-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let count = 0

// cli.ts reads its home at import, so runRig and brief run in a child process with its own FACTORY_HOME
const SCRIPT = `
import { runRig, brief } from ${JSON.stringify(join(import.meta.dir, 'cli'))}
import lifecycle from ${JSON.stringify(join(import.meta.dir, '..', 'factories', 'lifecycle'))}
const c = { seq: 1, attempt: 1, pane: null, session: null, resumes: 0, startedAt: 0, nudgedAt: 0, nudges: 0, retryAt: 0, budget: 10, wakeAt: 0, error: null, mail: {}, seen: {}, log: [] }
const run = { id: 'r1', factory: 'lifecycle', repo: process.env.REPO, goal: 'g', ws: 'ws', worktree: '/nonexistent/wt', branch: 'b' }
console.log(JSON.stringify({ rig: runRig(run) ?? null, brief: brief(run, lifecycle, 'implement', c, []) }))
`

type Out = { rig: Record<string, unknown> | null; brief: string }
const run = (snap: unknown, live: unknown, raw = false): Out => {
  const dir = join(tmp, String(count++))
  mkdirSync(join(dir, 'runs', 'r1'), { recursive: true })
  // undefined: no rig.json at all (a run from before the change)
  if (snap !== undefined)
    writeFileSync(join(dir, 'runs', 'r1', 'rig.json'), raw ? (snap as string) : JSON.stringify(snap))
  writeFileSync(join(dir, 'rigs.json'), JSON.stringify(live))
  const { FACTORY_OUTBOX, FACTORY_FROM, ...env } = process.env
  const p = Bun.spawnSync([process.execPath, '-e', SCRIPT], {
    env: { ...env, FACTORY_HOME: dir, FACTORY_SELF_UPDATE: '0', REPO },
  })
  expect(p.exitCode, p.stderr.toString()).toBe(0)
  return JSON.parse(p.stdout.toString())
}
const base = { name: 'acme', repo: REPO, factory: 'lifecycle' }

test('AC1: a rewritten rigs.json changes nothing for the run: runRig and brief keep the old values', () => {
  const old = {
    ...base,
    goal: 'old goal',
    runner: 'ax',
    agent: 'claude --model a',
    params: { base_branch: 'trunk' },
    pushRules: ['Fetch origin/{base_branch}.'],
    skills: ['asd-ste100'],
    sandboxClass: 'microvm',
  }
  const live = { ...base, goal: 'new goal', agent: 'codex', params: { base_branch: 'dev' } }
  const got = run(old, [live])
  expect(got.rig).toEqual(old)
  expect(got.brief).toContain('old goal')
  expect(got.brief).toContain('Fetch origin/trunk.')
  expect(got.brief).not.toContain('new goal')
})

test('the run repo, not the launch repo, is the repo of runRig (the AX path map)', () => {
  expect(run({ ...base, repo: '/laptop/acme-widget' }, [base]).rig!.repo).toBe(REPO)
})

test('AC2: guard lists are the union of snapshot and live', () => {
  const snap = { ...base, personOnlyContexts: ['ctx-a'], protectedBranches: ['rel'], sensitivePaths: ['p1/'] }
  const live = {
    ...base,
    personOnlyContexts: ['ctx-b'],
    protectedBranches: ['prod'],
    sensitivePaths: ['p2/'],
  }
  const got = run(snap, [live]).rig!
  expect(got.personOnlyContexts).toEqual(['ctx-a', 'ctx-b'])
  expect(got.protectedBranches).toEqual(['rel', 'prod'])
  expect(got.sensitivePaths).toEqual(['p1/', 'p2/'])
  const gone = run(snap, []).rig!
  expect(gone.personOnlyContexts).toEqual(['ctx-a'])
  expect(gone.protectedBranches).toEqual(['rel'])
  expect(gone.sensitivePaths).toEqual(['p1/'])
  const dup = run({ ...base, personOnlyContexts: ['ctx-a'] }, [
    { ...base, personOnlyContexts: ['ctx-a'] },
  ]).rig!
  expect(dup.personOnlyContexts).toEqual(['ctx-a'])
  const none = run(base, [base]).rig!
  for (const k of ['personOnlyContexts', 'protectedBranches', 'sensitivePaths']) expect(k in none).toBe(false)
})

const E1 = { hosts: ['a.example.com'], key: 'ZQ_KEY', header: 'Authorization', prefix: 'Bearer ' }
const E2 = { hosts: ['b.example.com'], key: 'ZQ_KEY2', header: 'X-Key' }

test('AC3: a grant stays only while the snapshot and the live rig both hold it', () => {
  const snap = {
    ...base,
    mergeAuthority: true,
    egress: [E1, E2],
    env: { FACTORY_KUBE_SERVER: 'https://k', B: '1' },
    mcp: '/m.json',
  }
  const live = { ...base, egress: [E1], env: { B: '1' }, mcp: '/n.json', otelContent: false }
  const got = run(snap, [live]).rig!
  expect('mergeAuthority' in got).toBe(false)
  expect(got.egress).toEqual([E1])
  expect(got.env).toEqual({ B: '1' })
  expect('mcp' in got).toBe(false)
  expect(got.otelContent).toBe(false)
})

test('AC3: denied rows', () => {
  expect('mergeAuthority' in run(base, [{ ...base, mergeAuthority: true }]).rig!).toBe(false)
  const str = run({ ...base, mergeAuthority: true }, [{ ...base, mergeAuthority: 'true' }]).rig!
  expect('mergeAuthority' in str).toBe(false)
  const gone = run({ ...base, mergeAuthority: true, egress: [E1], env: { B: '1' }, mcp: '/m.json' }, []).rig!
  expect('mergeAuthority' in gone).toBe(false)
  expect(gone.egress).toEqual([])
  expect('env' in gone).toBe(false)
  expect('mcp' in gone).toBe(false)
  const e2 = run({ ...base, egress: [E1, E2] }, [
    { ...base, egress: [E1, { ...E2, header: 'X-Other' }] },
  ]).rig!
  expect(e2.egress).toEqual([E1])
  expect(run({ ...base, env: { B: '1' } }, [{ ...base, env: { B: '2' } }]).rig!.env).toBeUndefined()
  expect('egress' in run(base, [{ ...base, egress: [E1] }]).rig!).toBe(false)
})

test('AC3: allowed rows and the pinned beadsRemote', () => {
  const snap = {
    ...base,
    mergeAuthority: true,
    egress: [E1],
    env: { B: '1' },
    mcp: '/m.json',
    beadsRemote: { name: 'r1', url: 'http://a', user: 'u' },
  }
  const got = run(snap, [{ ...snap, beadsRemote: { name: 'r1', url: 'http://b', user: 'u' } }]).rig!
  expect(got.mergeAuthority).toBe(true)
  expect(got.egress).toEqual([E1])
  expect(got.env).toEqual({ B: '1' })
  expect(got.mcp).toBe('/m.json')
  expect(got.beadsRemote).toEqual(snap.beadsRemote)
})

test('AC4: legacy run, no rig at launch, bad file', () => {
  const live = {
    ...base,
    goal: 'live goal',
    runner: 'ax',
    personOnlyContexts: ['ctx-b'],
    mergeAuthority: true,
  }
  expect(run(undefined, [live]).rig).toEqual(live)
  const nul = run(null, [live]).rig!
  expect(nul.goal).toBeUndefined()
  expect(nul.runner).toBeUndefined()
  expect(nul.personOnlyContexts).toEqual(['ctx-b'])
  expect('mergeAuthority' in nul).toBe(false)
  expect(run(null, []).rig).toBeNull()
  expect(run('{', [live], true).rig).toEqual(live)
  expect(run('[]', [live], true).rig).toEqual(live)
})

test('AC4: factory start writes the rig entry, or null when the repo is no rig', () => {
  const dir = join(tmp, 'cli')
  const bin = join(dir, 'bin')
  const home = join(dir, 'home')
  const repo = join(dir, 'repo')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'claude-config'), { recursive: true })
  writeFileSync(join(dir, 'claude-config', '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  mkdirSync(join(repo, '.beads'), { recursive: true })
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a])
  git('init', '-q')
  git('remote', 'add', 'origin', 'https://github.com/acme/widget.git')
  git('commit', '--allow-empty', '-q', '-m', 'init')
  const script = (name: string, lines: string[]) => {
    writeFileSync(join(bin, name), ['#!/bin/sh', ...lines].join('\n'))
    chmodSync(join(bin, name), 0o755)
  }
  script('bd', [
    'case "$1" in',
    "  config) printf '%s' 'acme';;",
    `  show) printf '%s' '[{"id":"acme-1","title":"t","status":"open"}]';;`,
    "  ready|list|children) printf '%s' '[]';;",
    '  *) exit 0;;',
    'esac',
  ])
  script('herdr', [
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${join(dir, 'wt')}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ])
  script('gh', ['exit 1'])
  const def = join(dir, 'tiny.json')
  writeFileSync(
    def,
    JSON.stringify({
      name: 'tiny',
      start: 'work',
      nodes: { work: { prompt: 'Do it.', next: { ok: 'done' } } },
    }),
  )
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_AX_CONTEXT, FACTORY_AX_MANAGER, ...laptop } =
    process.env
  const seen = new Set<string>()
  const start = (bead: string) => {
    const p = Bun.spawnSync([CLI, 'start', def, repo, bead], {
      env: {
        ...laptop,
        FACTORY_HOME: home,
        FACTORY_NO_KICK: '1',
        PATH: `${bin}:${laptop.PATH}`,
        FACTORY_HERDR: join(bin, 'herdr'),
        CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
        FACTORY_SELF_UPDATE: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'commit.gpgsign',
        GIT_CONFIG_VALUE_0: 'false',
      },
    })
    expect(p.exitCode, p.stderr.toString()).toBe(0)
    const id = readdirSync(join(home, 'runs')).find(
      i => existsSync(join(home, 'runs', i, 'run.json')) && !seen.has(i),
    )!
    seen.add(id)
    return JSON.parse(readFileSync(join(home, 'runs', id, 'rig.json'), 'utf8'))
  }
  const entry = { name: 'a', repo, factory: def, goal: 'g' }
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([entry]))
  expect(start('acme-1')).toEqual(entry)
  writeFileSync(join(home, 'rigs.json'), '[]')
  expect(start('acme-2')).toBeNull()
})

test('a malformed sensitivePaths stays malformed, so the security route stays required', () => {
  const bad = ['p1/', 5]
  const rows: [unknown, unknown][] = [
    [
      { ...base, sensitivePaths: bad },
      { ...base, sensitivePaths: ['p2/'] },
    ],
    [
      { ...base, sensitivePaths: ['p1/'] },
      { ...base, sensitivePaths: 'p2/' },
    ],
    [
      { ...base, sensitivePaths: bad },
      { ...base, sensitivePaths: bad },
    ],
  ]
  for (const [snap, live] of rows) expect(rigPaths(run(snap, [live]).rig!.sensitivePaths)).toBeNull()
  const ok = run({ ...base, sensitivePaths: ['p1/'] }, [{ ...base, sensitivePaths: ['p2/'] }])
  expect(rigPaths(ok.rig!.sensitivePaths)).toEqual(['p1/', 'p2/'])
})
