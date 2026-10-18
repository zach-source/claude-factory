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
function parkedRun(
  id: string,
  repoDir: string,
  factoryFile: string,
  opts: { def?: Factory; at?: number; bead?: string; url?: string } = {},
) {
  const actor = createActor(compile(opts.def ?? SHIP)).start()
  actor.send({ type: 'GOTO', node: 'release', at: 0 })
  const { seq } = actor.getSnapshot().context
  actor.send({
    type: 'DONE',
    seq,
    outcome: 'ready',
    summary: `ready to ship ${opts.url ?? PR}`,
    at: opts.at ?? PARKED_AT,
  })
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
      ...(opts.bead && { bead: opts.bead }),
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

const ghCallCount = () =>
  existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []

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

// kickWatch (src/cli.ts) is the only caller of a watch pass since watchPass left beadsPass
// (claude-factory-960.7): `factory tick` must spawn it at most once a minute, never while the factory
// is halted, and never while another watch pass still holds watch.lock. These drive `factory tick`
// itself, not `factory watch`, since kickWatch is tick's own gate before it ever spawns that process.
async function waitForWatch(since = 0, tries = 300): Promise<unknown> {
  const file = join(home, 'watch.json')
  for (let i = 0; i < tries; i++) {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      if (j.at > since) return j
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitForWatch: no watch pass landed in time')
}

test('tick spawns one watch pass, then none while still inside that pass’s minute (claude-factory-960.7)', async () => {
  reset()
  const f = join(dir, 'ship.json')
  writeFileSync(f, JSON.stringify(SHIP))
  writeFileSync(prState, JSON.stringify({ state: 'OPEN', updatedAt: iso(3 * 60_000) }))
  parkedRun('r1', repo(), f)
  expect(existsSync(join(home, 'watch.json'))).toBe(false)
  factory(['tick'])
  const first = (await waitForWatch()) as { at: number }
  expect(ghCallCount()).toHaveLength(1)
  factory(['tick']) // immediately after: well inside the same minute, so this must spawn nothing
  await new Promise(resolve => setTimeout(resolve, 1200)) // well over the ~500ms a spawned pass takes to land
  expect(ghCallCount()).toHaveLength(1) // still one gh call, not two
  const second = JSON.parse(readFileSync(join(home, 'watch.json'), 'utf8'))
  expect(second.at).toBe(first.at) // the file is untouched since the first pass
})

test('tick spawns no watch pass while the factory is halted (claude-factory-960.7)', async () => {
  reset()
  const f = join(dir, 'ship.json')
  writeFileSync(f, JSON.stringify(SHIP))
  writeFileSync(prState, JSON.stringify({ state: 'OPEN', updatedAt: iso(3 * 60_000) }))
  parkedRun('r1', repo(), f)
  writeFileSync(
    join(home, 'halt.json'),
    JSON.stringify({ state: 'stopping', at: Date.now(), told: {}, closed: {} }),
  )
  factory(['tick'])
  await new Promise(resolve => setTimeout(resolve, 1200)) // well over the ~500ms a spawned pass takes to land
  expect(existsSync(join(home, 'watch.json'))).toBe(false)
  expect(ghCallCount()).toHaveLength(0)
})

test('tick spawns no watch pass while another one still holds watch.lock (claude-factory-960.7)', async () => {
  reset()
  const f = join(dir, 'ship.json')
  writeFileSync(f, JSON.stringify(SHIP))
  writeFileSync(prState, JSON.stringify({ state: 'OPEN', updatedAt: iso(3 * 60_000) }))
  parkedRun('r1', repo(), f)
  mkdirSync(join(home, 'watch.lock'))
  writeFileSync(join(home, 'watch.lock', 'pid'), String(process.pid)) // this test process: alive
  factory(['tick'])
  await new Promise(resolve => setTimeout(resolve, 1200)) // well over the ~500ms a spawned pass takes to land
  expect(existsSync(join(home, 'watch.json'))).toBe(false)
  expect(ghCallCount()).toHaveLength(0)
})

// claude-factory-5wav: the watch wakes a parked station only for a real change, and routes a close or a
// person's change request with no worker.
const ROUTE_SHIP: Factory = {
  name: 'ship',
  start: 'release',
  nodes: {
    release: { prompt: 'ship it', next: { ready: 'deploy' } },
    implement: { prompt: 'rework it', next: { ready: 'deploy' } },
    deploy: {
      prompt: 'deploy it',
      awaitsPr: true,
      next: { deployed: 'done', hold: 'done', changes: 'implement' },
    },
  },
}
const bdCalls = join(dir, 'bd-calls.log')

/** the fake gh answer for the pull request: open, no notes, head aaa1111 unless a test says otherwise */
const prJson = (over: Record<string, unknown> = {}) =>
  writeFileSync(
    prState,
    JSON.stringify({
      state: 'OPEN',
      updatedAt: iso(3 * 60_000),
      headRefOid: 'aaa1111',
      mergedAt: null,
      closedAt: null,
      reviews: [],
      comments: [],
      ...over,
    }),
  )
const comment = (body: string, who: { login: string; assoc: string }) => ({
  author: { login: who.login },
  authorAssociation: who.assoc,
  body,
  createdAt: iso(60_000),
})
const OWNER = { login: 'zach', assoc: 'OWNER' }
const BOT = { login: 'github-actions', assoc: 'NONE' }

function fakeBd() {
  writeFileSync(join(bin, 'bd'), ['#!/bin/sh', `echo "$*" >> ${bdCalls}`, `printf '%s' task-1`].join('\n'))
  chmodSync(join(bin, 'bd'), 0o755)
}

/** every event line a run's inbox was sent */
function inboxOf(id: string): { type: string; [k: string]: unknown }[] {
  const inbox = join(home, 'runs', id, 'inbox.jsonl')
  if (!existsSync(inbox)) return []
  return readFileSync(inbox, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
}
const stateOf = (id: string) =>
  JSON.parse(readFileSync(join(home, 'runs', id, 'state.json'), 'utf8')).snapshot
const watchJson = () => JSON.parse(readFileSync(join(home, 'watch.json'), 'utf8'))

function routeRun(id: string, opts: { at?: number; bead?: string; url?: string } = {}) {
  const f = join(dir, 'route-ship.json')
  writeFileSync(f, JSON.stringify(ROUTE_SHIP))
  const r = repo()
  if (opts.bead) mkdirSync(join(r, '.beads'), { recursive: true })
  parkedRun(id, r, f, { def: ROUTE_SHIP, ...opts })
}

test('CI status, label and bot comment changes wake nothing, route nothing and re-park nothing (5wav AC1)', () => {
  reset()
  routeRun('r1')
  prJson({
    updatedAt: iso(30_000),
    comments: [comment('/changes fix it', BOT), comment('CI passed', BOT)],
    reviews: [
      {
        author: { login: 'github-actions' },
        authorAssociation: 'NONE',
        state: 'CHANGES_REQUESTED',
        body: 'bot',
        submittedAt: iso(30_000),
      },
    ],
  })
  expect(factory(['watch']).code).toBe(0)
  expect(inboxOf('r1')).toEqual([])
  const j = watchJson()
  expect([j.woke, j.routed, j.reparked]).toEqual([[], [], []])
})

test('a head push after the park wakes the station once (5wav AC2)', () => {
  reset()
  routeRun('r1')
  prJson()
  factory(['watch']) // the first view is the baseline
  expect(inboxOf('r1')).toEqual([])
  prJson({ headRefOid: 'bbb2222' })
  factory(['watch'])
  const mail = inboxOf('r1')
  expect(mail).toHaveLength(1)
  expect(mail[0]).toMatchObject({ type: 'MAIL', to: 'deploy' })
  expect(String(mail[0]!.text)).toContain('new head commit bbb2222')
})

test('a free-text comment by a person wakes the station; the same comment by a bot does not (5wav AC2)', () => {
  reset()
  routeRun('r1')
  prJson({ comments: [comment('please look at the log', OWNER)] })
  factory(['watch'])
  expect(inboxOf('r1').map(e => e.type)).toEqual(['MAIL'])
  reset()
  routeRun('r2')
  prJson({ comments: [comment('please look at the log', BOT)] })
  factory(['watch'])
  expect(inboxOf('r2')).toEqual([])
})

test('a pull request closed unmerged routes hold with no worker: the run ends done (5wav AC3)', () => {
  reset()
  routeRun('r1')
  const before = stateOf('r1').context.seq
  prJson({
    state: 'CLOSED',
    closedAt: iso(60_000),
    comments: [comment('superseded by the new pull request', OWNER)],
  })
  factory(['watch'])
  const events = inboxOf('r1')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: 'ROUTE', node: 'deploy', outcome: 'hold' })
  expect(String(events[0]!.summary)).toContain('superseded by the new pull request')
  expect(watchJson().routed).toMatchObject([{ run: 'r1', node: 'deploy', url: PR, outcome: 'hold' }])
  factory(['watch']) // a second pass before the tick routes nothing twice
  expect(inboxOf('r1')).toHaveLength(1)
  factory(['tick'])
  const snap = stateOf('r1')
  expect(snap.value).toBe('done')
  expect(snap.context.seq).toBe(before) // no worker ever launched for deploy
  expect(snap.context.log.at(-1)).toMatchObject({ node: 'deploy', attempt: 0, outcome: 'hold' })
})

test('a person change request routes changes to implement with a bd task each, and no deploy worker (5wav AC4)', () => {
  reset()
  fakeBd()
  routeRun('r1', { bead: 'acme-1' })
  prJson({
    comments: [comment('/changes rename the flag', OWNER), comment('/changes ignore me', BOT)],
    reviews: [
      {
        author: { login: 'zach' },
        authorAssociation: 'OWNER',
        state: 'CHANGES_REQUESTED',
        body: 'the test is vacuous',
        submittedAt: iso(30_000),
      },
    ],
  })
  factory(['watch'])
  const events = inboxOf('r1')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: 'ROUTE', node: 'deploy', outcome: 'changes' })
  const text = String(events[0]!.summary)
  expect(text).toContain('/changes rename the flag')
  expect(text).toContain('the test is vacuous')
  expect(text).not.toContain('ignore me')
  const creates = readFileSync(bdCalls, 'utf8')
    .trim()
    .split('\n')
    .filter(l => l.startsWith('create '))
  expect(creates).toHaveLength(2)
  expect(creates.every(l => l.startsWith('create PR change request: '))).toBe(true)
  // the description holds line breaks, so bd's argv spreads over lines: count the parent flags in all
  expect(readFileSync(bdCalls, 'utf8').split('--parent acme-1')).toHaveLength(3)
  expect(watchJson().routed).toMatchObject([{ outcome: 'changes' }])
})

test('near its timer an unchanged open pull request parks again with no worker (5wav AC5)', () => {
  reset()
  routeRun('r1', { at: Date.now() - 475 * 60_000 }) // the 480 min timer is 5 min away
  const before = stateOf('r1').context.seq
  prJson({ updatedAt: iso(30_000) })
  factory(['watch'])
  const events = inboxOf('r1')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: 'REPARK', node: 'deploy' })
  expect(watchJson().reparked).toHaveLength(1)
  factory(['watch']) // posted twice before the tick would move wakeAt again: it does not
  expect(inboxOf('r1')).toHaveLength(1)
  factory(['tick'])
  const snap = stateOf('r1')
  expect(snap.value).toEqual({ deploy: 'waiting' })
  expect(snap.context.wakeAt).toBeGreaterThan(Date.now() + 470 * 60_000)
  expect(snap.context.seq).toBe(before)
})

test('a failed gh view posts no route and no re-park (5wav AC6)', () => {
  reset()
  routeRun('r1', { at: Date.now() - 475 * 60_000 })
  rmSync(prState, { force: true }) // the fake gh cats a missing file and exits 1
  factory(['watch'])
  expect(inboxOf('r1')).toEqual([])
  expect(watchJson().errors).toBe(1)
})

const MR_URL = 'https://gitlab.example.com/acme/widget/-/merge_requests/9'

/** a fake glab: `glab api ... <path>` answers the control files for the MR, its approvals and its notes */
function fakeGlab(mr: object, notes: object[]) {
  writeFileSync(join(dir, 'mr.json'), JSON.stringify(mr))
  writeFileSync(join(dir, 'notes.json'), JSON.stringify(notes))
  writeFileSync(
    join(bin, 'glab'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *"/notes?"*) cat ${join(dir, 'notes.json')};;`,
      `  *"/approvals") echo '{}';;`,
      `  *) cat ${join(dir, 'mr.json')};;`,
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'glab'), 0o755)
}
const mrBody = (over: object = {}) => ({
  title: 't',
  state: 'opened',
  updated_at: iso(30_000),
  source_branch: 'b',
  sha: 'aaa1111',
  detailed_merge_status: 'mergeable',
  ...over,
})
const mrNote = (body: string, username: string, over: object = {}) => ({
  created_at: iso(30_000),
  body,
  system: false,
  author: { username },
  ...over,
})

test('a merge request: system and bot notes wake nothing; a person /changes note routes changes (5wav AC10)', () => {
  reset()
  routeRun('r1', { url: MR_URL })
  fakeGlab(mrBody(), [
    mrNote('added label', 'zach', { system: true }),
    mrNote('/changes from a bot', 'project_3_bot_x'),
  ])
  factory(['watch'])
  expect(inboxOf('r1')).toEqual([])
  fakeGlab(mrBody({ sha: 'bbb2222' }), [mrNote('/changes use the helper', 'zach')])
  factory(['watch'])
  const events = inboxOf('r1')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: 'ROUTE', node: 'deploy', outcome: 'changes' })
  expect(String(events[0]!.summary)).toContain('/changes use the helper')
})

test('a merge request closed after the park routes hold; a new head sha wakes (5wav AC10)', () => {
  reset()
  routeRun('r1', { url: MR_URL })
  fakeGlab(mrBody(), [])
  factory(['watch'])
  fakeGlab(mrBody({ sha: 'bbb2222' }), [])
  factory(['watch'])
  expect(inboxOf('r1').map(e => e.type)).toEqual(['MAIL'])
  routeRun('r2', { url: MR_URL })
  fakeGlab(mrBody({ state: 'closed', closed_at: iso(30_000) }), [])
  factory(['watch'])
  expect(inboxOf('r2')).toMatchObject([{ type: 'ROUTE', outcome: 'hold' }])
})
