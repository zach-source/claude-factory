// claude-factory-ldq9: a rig's base_branch param replaces origin/main in lifecycle's prompts and in mergeCheck.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseBranchOf, branchOk, brief } from './cli'
import lifecycle from '../factories/lifecycle'
import type { Factory } from './machine'

const repo = '/nonexistent/repo-ldq9'
const c = {
  seq: 1,
  attempt: 1,
  pane: null,
  session: null,
  resumes: 0,
  startedAt: Date.now(),
  nudgedAt: 0,
  nudges: 0,
  retryAt: 0,
  budget: 10,
  wakeAt: 0,
  error: null,
  mail: {},
  seen: {},
  log: [],
}
const run = {
  id: 'r1',
  factory: 'f',
  repo,
  goal: 'g',
  ws: 'ws',
  worktree: '/nonexistent/wt-ldq9',
  branch: 'b',
}
const stations = ['implement', 'verify', 'review', 'security', 'quick', 'check']
const nodes = (lifecycle as Factory).nodes

afterEach(() => {
  delete process.env.FACTORY_BASE_BRANCH
})

/** brief of a node, with the onTimeout section on when the node has one */
const briefOf = (node: string) => {
  const log = nodes[node]?.onTimeout
    ? [{ node, outcome: 'fail', summary: 'no report within 75 min', attempt: 1, at: 1 }]
    : []
  return brief(run, lifecycle as Factory, node, { ...c, log } as never, [])
}

test('AC1: base_branch=acme/deploy puts origin/acme/deploy in each lifecycle station, never origin/main or a raw placeholder', () => {
  process.env.FACTORY_BASE_BRANCH = 'acme/deploy'
  for (const s of stations.filter(s => nodes[s])) {
    // factory memory (rules text, before the goal) may still name origin/main; the task section may not
    const text = briefOf(s).slice(briefOf(s).indexOf('## Your task'))
    expect(text).not.toContain('origin/main')
    expect(text).not.toContain('{base_branch}')
  }
  expect(briefOf('implement')).toContain('Merge origin/acme/deploy last')
  expect(briefOf('verify')).toContain('git merge-tree')
  expect(briefOf('verify')).toContain('against origin/acme/deploy')
  expect(briefOf('review')).toContain('git diff --stat origin/acme/deploy...HEAD')
  expect(briefOf('security')).toContain('The previous attempt timed out')
  expect(briefOf('security')).toContain('git diff --stat origin/acme/deploy...HEAD')
})

test('AC2: with no base_branch the brief says origin/main, also for an empty value', () => {
  for (const s of stations.filter(s => nodes[s])) {
    expect(briefOf(s)).not.toContain('{base_branch}')
    expect(briefOf(s)).toContain('origin/main')
  }
  process.env.FACTORY_BASE_BRANCH = ' '
  expect(briefOf('verify')).toContain('against origin/main')
})

test('AC3: a bad base_branch never reaches a brief; the default branch is used', () => {
  for (const bad of ['a..b', '-x', 'x y', 'x`y`', '$(id)', 'a;b']) {
    expect(branchOk(bad)).toBe(false)
    process.env.FACTORY_BASE_BRANCH = bad
    expect(baseBranchOf(lifecycle as Factory, undefined, repo)).toBe('main')
    expect(briefOf('verify')).toContain('against origin/main')
    expect(briefOf('verify')).not.toContain(bad)
    expect(baseBranchOf(lifecycle as Factory, { params: { base_branch: bad } }, repo)).toBe('main')
  }
  expect(branchOk('acme/deploy')).toBe(true)
})

test('AC4: a factory without a base_branch param keeps a literal {name} in its prompt', () => {
  const def: Factory = {
    name: 'f',
    start: 'implement',
    params: { other: 'x' },
    nodes: { implement: { prompt: 'keep {base_branch} and {other}', next: { ready: 'done' } } },
  }
  expect(brief(run, def, 'implement', c as never, [])).toContain('keep {base_branch} and {other}')
})

test('a rig base_branch wins over the env; an empty one means the repo default branch (origin/HEAD)', () => {
  expect(baseBranchOf(lifecycle as Factory, { params: { base_branch: 'acme/deploy' } }, repo)).toBe(
    'acme/deploy',
  )
  const dir = mkdtempSync(join(tmpdir(), 'ldq9-'))
  try {
    mkdirSync(join(dir, 'r'))
    Bun.spawnSync(['git', '-C', join(dir, 'r'), 'init', '-q'])
    Bun.spawnSync([
      'git',
      '-C',
      join(dir, 'r'),
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/trunk',
    ])
    expect(baseBranchOf(lifecycle as Factory, undefined, join(dir, 'r'))).toBe('trunk')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AC6: rig add stores a plain base_branch, stores an empty one, and refuses a bad name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldq9-rig-'))
  try {
    const home = join(dir, 'home')
    const r = join(dir, 'r')
    mkdirSync(home)
    mkdirSync(join(r, '.beads'), { recursive: true })
    Bun.spawnSync(['git', '-C', r, 'init', '-q'])
    const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
    const add = (v: string) => {
      const p = Bun.spawnSync(
        [join(import.meta.dir, '..', 'bin', 'factory'), 'rig', 'add', 'a', r, 'lifecycle', '--param', v],
        { env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' } },
      )
      return { code: p.exitCode, err: p.stderr.toString() }
    }
    const stored = () => JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))[0].params?.base_branch
    expect(add('base_branch=acme/deploy').code).toBe(0)
    expect(stored()).toBe('acme/deploy')
    for (const bad of ['a..b', '-x', 'x y']) {
      const out = add(`base_branch=${bad}`)
      expect(out.code).not.toBe(0)
      expect(out.err).toContain('base_branch')
      expect(stored()).toBe('acme/deploy')
    }
    expect(add('base_branch=').code).toBe(0)
    expect(stored()).toBe('')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
