// `factory watch` end to end (claude-factory-960): a station parked on a pull request with no worker
// yet (an awaitsPr arrival) wakes on a merge or close, including one that predates the park, and stays
// asleep while the pull request is open and unchanged. Every run parked on the same pull request shares
// one `gh pr view` call this pass, however many runs link it.
//
// This drives the real CLI against on-disk run fixtures (run.json + state.json) built from the real
// machine, with a fake `gh` in PATH that logs every invocation so a test can count them.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `watch-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const calls = join(dir, 'gh-calls.log')
const prState = join(dir, 'pr-state.json')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0' },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** fake gh: `gh pr view <url> --json state,updatedAt` answers the control file's JSON and logs the call
 * (one line an invocation), so a test can count how many times gh actually ran */
function fakeGh() {
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "$*" >> ${calls}`,
    'case "$1 $2" in',
    `  "pr view") cat ${prState};;`,
    '  *) exit 1;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'gh'), script)
  chmodSync(join(bin, 'gh'), 0o755)
}

const repo = () => {
  const r = join(dir, 'repo')
  mkdirSync(r, { recursive: true })
  return r
}

const SHIP: Factory = {
  name: 'ship',
  start: 'release',
  nodes: {
    release: { prompt: 'ship it', next: { ready: 'deploy' } },
    deploy: { prompt: 'deploy it', awaitsPr: true, next: { deployed: 'done' } },
  },
}
const PR = 'https://github.com/acme/widget/pull/42'
// anchored to the real clock, not a fixed date: the plain park wait (60 min, the node has no parkMin) must
// stand well clear of it, so a wake in the "predates the park" test can only come from the isPreLaunch
// bypass, never from the plain wait having simply elapsed by the time the test runs
const PARKED_AT = Date.now() - 2 * 60_000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

/** writes run.json and state.json for a run already parked at deploy on PR, with no worker ever
 * launched (the pre-launch park an awaitsPr arrival makes) */
function parkedRun(id: string, repoDir: string, factoryFile: string) {
  const actor = createActor(compile(SHIP)).start()
  actor.send({ type: 'GOTO', node: 'release', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({ type: 'DONE', seq, outcome: 'ready', summary: `ready to ship ${PR}`, at: PARKED_AT })
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: factoryFile,
      repo: repoDir,
      goal: 'ship it',
      ws: 'ws1',
      worktree: repoDir,
      branch: 'b',
    }),
  )
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
}

function reset() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  fakeGh()
}

/** the MAIL lines a run's inbox was sent, if any */
function mailOf(id: string): { text: string }[] {
  const inbox = join(home, 'runs', id, 'inbox.jsonl')
  if (!existsSync(inbox)) return []
  return readFileSync(inbox, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(e => e.type === 'MAIL')
}

const ghCallCount = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [])

test('an open pull request with no activity since the park gets no mail (AC2)', () => {
  reset()
  const f = join(dir, 'ship.json')
  writeFileSync(f, JSON.stringify(SHIP))
  writeFileSync(prState, JSON.stringify({ state: 'OPEN', updatedAt: iso(3 * 60_000) })) // before the park
  parkedRun('r1', repo(), f)
  const out = factory(['watch'])
  expect(out.code).toBe(0)
  expect(mailOf('r1')).toEqual([])
  const watchJson = JSON.parse(readFileSync(join(home, 'watch.json'), 'utf8'))
  expect(watchJson.viewed).toBe(1)
  expect(watchJson.woke).toEqual([])
})

test('a merge after the park wakes the station at once (AC3)', () => {
  reset()
  const f = join(dir, 'ship.json')
  writeFileSync(f, JSON.stringify(SHIP))
  writeFileSync(prState, JSON.stringify({ state: 'MERGED', updatedAt: iso(1 * 60_000) })) // after the park
  parkedRun('r1', repo(), f)
  const out = factory(['watch'])
  expect(out.code).toBe(0)
  const mail = mailOf('r1')
  expect(mail).toHaveLength(1)
  expect(mail[0]!.text).toContain('it is merged')
  const watchJson = JSON.parse(readFileSync(join(home, 'watch.json'), 'utf8'))
  expect(watchJson.woke).toHaveLength(1)
  expect(watchJson.woke[0]).toMatchObject({ run: 'r1', node: 'deploy', url: PR })
})

test('a merge that predates a pre-launch park still wakes it at once, not out its plain park wait (AC3)', () => {
  reset()
  const f = join(dir, 'ship.json')
  writeFileSync(f, JSON.stringify(SHIP))
  // merged before the park (updatedAt before PARKED_AT): a worker's own park would wait out its plain
  // timer first (60 min; the test runs in well under that), but this park spent no worker on that
  // wait, so it wakes at the very next pass
  writeFileSync(prState, JSON.stringify({ state: 'MERGED', updatedAt: iso(3 * 60_000) }))
  parkedRun('r1', repo(), f)
  const out = factory(['watch'])
  expect(out.code).toBe(0)
  expect(mailOf('r1')).toHaveLength(1)
})

test('a closed pull request routes the same way a merge does (AC3)', () => {
  reset()
  const f = join(dir, 'ship.json')
  writeFileSync(f, JSON.stringify(SHIP))
  writeFileSync(prState, JSON.stringify({ state: 'CLOSED', updatedAt: iso(1 * 60_000) })) // after the park
  parkedRun('r1', repo(), f)
  const out = factory(['watch'])
  expect(out.code).toBe(0)
  expect(mailOf('r1')).toHaveLength(1)
})

test('two runs parked on the same pull request share one gh view this pass (AC6)', () => {
  reset()
  const f = join(dir, 'ship.json')
  writeFileSync(f, JSON.stringify(SHIP))
  writeFileSync(prState, JSON.stringify({ state: 'OPEN', updatedAt: iso(3 * 60_000) }))
  const r = repo()
  parkedRun('r1', r, f)
  parkedRun('r2', r, f)
  const out = factory(['watch'])
  expect(out.code).toBe(0)
  expect(ghCallCount()).toHaveLength(1) // one gh call, though two runs link the same pull request
  const watchJson = JSON.parse(readFileSync(join(home, 'watch.json'), 'utf8'))
  expect(watchJson.viewed).toBe(1)
})
