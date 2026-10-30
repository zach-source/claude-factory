// Tests for `factory gate-brief facts|set` (claude-factory-2u2).
// The briefer subagent has no Bash. This CLI gathers the facts it needs: a gate's PR, and the verify
// and review/security facts. `gatebrief.ts`'s pure helpers clean and check the briefer's answer by hand.
// These tests drive the real CLI against on-disk run fixtures (run.json and state.json), built from the
// real machine, the same harness as watch.test.ts and remote.test.ts's `launched()`.
// A fake `gh` in PATH answers the one-PR diff-stat call.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `gatebrief-cli-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const calls = join(dir, 'gh-calls.log')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_PATROL, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0', ...env },
    timeout: 30_000,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** fake gh: `gh api repos/<slug>/pulls/N` answers one fixed diff stat, and
 * logs every call (one line an invocation), so a test can count how many times it actually ran */
function fakeGh() {
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${calls}'`,
    'case "$1 $2" in',
    `  "api repos/acme/widget/pulls/"*) printf '%s' '{"additions":12,"deletions":3,"changed_files":4}' ;;`,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'gh'), script)
  chmodSync(join(bin, 'gh'), 0o755)
}

function reset() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  fakeGh()
}

const DEF: Factory = {
  name: 'lifecycle',
  start: 'verify',
  nodes: {
    verify: { prompt: 'run the tests', next: { green: 'review' } },
    review: { prompt: 'review the diff', next: { approve: 'g' } },
    g: { prompt: 'ship it?', gate: true, next: { approve: 'done' } },
  },
}

/** a run already past verify and review, sitting at the gate `g` (claude-factory-2u2): the actor's own
 * log carries the two stations' summaries, exactly as a real run's journal would. */
function gateRun(id: string, repoDir: string, verify = 'verify: all green', review = 'review: looks good') {
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'DONE', seq: actor.getSnapshot().context.seq, outcome: 'green', summary: verify, at: 1 })
  actor.send({
    type: 'DONE',
    seq: actor.getSnapshot().context.seq,
    outcome: 'approve',
    summary: review,
    at: 2,
  })
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo: repoDir,
      goal: 'ship the thing',
      ws: 'ws1',
      worktree: repoDir,
      branch: `factory/${id}`,
    }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
}

/** a run still working at `verify`, never having reached the gate */
function workingRun(id: string, repoDir: string) {
  const actor = createActor(compile(DEF)).start()
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  const factoryFile = join(d, 'factory.ts')
  writeFileSync(factoryFile, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo: repoDir,
      goal: 'g',
      ws: 'w',
      worktree: repoDir,
      branch: 'b',
    }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
}

const repoFor = (name: string) => {
  const r = join(dir, name)
  mkdirSync(r, { recursive: true })
  return r
}

const codePr = {
  url: 'https://github.com/acme/widget/pull/7',
  repo: 'acme/widget',
  number: 7,
  title: 'ship it',
  role: 'code',
  station: 'implement',
  firstSeenAt: 1,
  source: 'report',
  corroborated: true,
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'APPROVED',
  mergeStateStatus: 'CLEAN',
  checks: { pass: 3, fail: 0, pending: 0 },
  updatedAt: '2024-01-01T00:00:00Z',
  checkedAt: 1,
  ownHead: true,
  namesIt: true,
  errorStreak: 0,
  erroredAt: 0,
}
const companionPr = {
  ...codePr,
  url: 'https://github.com/acme/widget/pull/8',
  number: 8,
  title: 'companion doc',
  role: 'companion',
  reviewDecision: '',
}

test('gate-brief facts: key, goal, gate, verify/review summaries, and PR facts with a diff stat for the code PR only', () => {
  reset()
  const repoDir = repoFor('repo1')
  gateRun('r1', repoDir)
  writeFileSync(
    join(home, 'runs', 'r1', 'prs.json'),
    JSON.stringify({ version: 1, prs: [codePr, companionPr] }),
  )
  const r = factory(['gate-brief', 'facts', 'r1'])
  expect(r.code).toBe(0)
  const facts = JSON.parse(r.out)
  expect(facts.key).toBe('gate:r1@0')
  expect(facts.goal).toBe('ship the thing')
  expect(facts.gate).toEqual({ question: 'ship it?', outcomes: ['approve'] })
  expect(facts.verify).toBe('verify: all green')
  expect(facts.review).toBe('review: looks good')
  expect(facts.prs).toHaveLength(2)
  const code = facts.prs.find((p: { role: string }) => p.role === 'code')
  expect(code).toMatchObject({
    title: 'ship it',
    url: codePr.url,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    additions: 12,
    deletions: 3,
    changedFiles: 4,
  })
  const companion = facts.prs.find((p: { role: string }) => p.role === 'companion')
  expect(companion).toMatchObject({ additions: null, deletions: null, changedFiles: null })
  // only the code-role PR costs a `gh api` call
  const logged = readFileSync(calls, 'utf8').trim().split('\n')
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatch(/^api repos\/acme\/widget\/pulls\/\d+$/)
})

test('gate-brief facts refuses a run that is not at a gate', () => {
  reset()
  workingRun('r2', repoFor('repo2'))
  const r = factory(['gate-brief', 'facts', 'r2'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('not at a gate')
})

test('gate-brief set refuses a worker env, a patrol env, and a malformed key, writing nothing', () => {
  reset()
  gateRun('r3', repoFor('repo3'))
  const briefFile = join(dir, 'brief3.txt')
  writeFileSync(briefFile, 'looks fine\nship it')
  const key = 'gate:r3@0'

  const asWorker = factory(['gate-brief', 'set', key, briefFile], { FACTORY_FROM: 'implement' })
  expect(asWorker.code).toBe(1)
  expect(asWorker.err).toContain('worker cannot set')

  const asPatrol = factory(['gate-brief', 'set', key, briefFile], { FACTORY_PATROL: '1' })
  expect(asPatrol.code).toBe(1)
  expect(asPatrol.err).toContain('patrol cannot set')

  const malformed = factory(['gate-brief', 'set', 'not-a-key', briefFile])
  expect(malformed.code).toBe(1)
  expect(malformed.err).toContain('malformed gate-brief key')

  expect(existsSync(join(home, 'gate-briefs.json'))).toBe(false)
})

test('gate-brief set refuses a key whose gate visit is not live (a wrong startedAt, or no such run)', () => {
  reset()
  gateRun('r4', repoFor('repo4'))
  const briefFile = join(dir, 'brief4.txt')
  writeFileSync(briefFile, 'hello')

  const wrongAt = factory(['gate-brief', 'set', 'gate:r4@999', briefFile])
  expect(wrongAt.code).toBe(1)
  expect(wrongAt.err).toContain('not a live gate visit')

  const noRun = factory(['gate-brief', 'set', 'gate:nope@0', briefFile])
  expect(noRun.code).toBe(1)
  expect(noRun.err).toContain('not a live gate visit')

  expect(existsSync(join(home, 'gate-briefs.json'))).toBe(false)
})

test('gate-brief set keeps at most 8 lines of a 9-line file, and the run row then carries gate.brief', () => {
  reset()
  gateRun('r5', repoFor('repo5'))
  const nineLines = Array.from({ length: 9 }, (_, i) => `point ${i + 1}`).join('\n')
  const briefFile = join(dir, 'brief5.txt')
  writeFileSync(briefFile, nineLines)

  const set = factory(['gate-brief', 'set', 'gate:r5@0', briefFile])
  expect(set.code).toBe(0)
  const stored = JSON.parse(readFileSync(join(home, 'gate-briefs.json'), 'utf8'))
  const lines = (stored['gate:r5@0'].text as string).split('\n')
  expect(lines).toHaveLength(8)
  expect(lines[0]).toBe('point 1')
  expect(lines.at(-1)).toBe('point 8')

  const shown = factory(['show', 'r5'])
  expect(shown.code).toBe(0)
  const row = JSON.parse(shown.out)
  expect(row.gate.brief.split('\n')).toHaveLength(8)
  expect(row.gate.brief).toContain('point 1')
})

test('gate-brief set prunes a brief whose gate visit is no longer live', () => {
  reset()
  gateRun('rA', repoFor('repoA'))
  gateRun('rB', repoFor('repoB'))
  const briefA = join(dir, 'briefA.txt')
  writeFileSync(briefA, 'a note')
  expect(factory(['gate-brief', 'set', 'gate:rA@0', briefA]).code).toBe(0)

  // rA's gate is decided: its visit ends, so its key is no longer live. `decide` only queues the DONE
  // event (post() appends to inbox.jsonl); `tick` applies it to the run's state.
  expect(factory(['decide', 'rA', 'approve']).code).toBe(0)
  expect(factory(['tick']).code).toBe(0)

  const briefB = join(dir, 'briefB.txt')
  writeFileSync(briefB, 'b note')
  expect(factory(['gate-brief', 'set', 'gate:rB@0', briefB]).code).toBe(0)

  const stored = JSON.parse(readFileSync(join(home, 'gate-briefs.json'), 'utf8'))
  expect(Object.keys(stored)).toEqual(['gate:rB@0'])
})
