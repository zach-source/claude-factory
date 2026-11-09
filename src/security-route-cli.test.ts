// The security route (claude-factory-aure.2): the runner writes it into the brief when a securityRoute
// station starts, and `report` refuses approve when the route is required, and security when it is not required and the summary has no `Security-reason:` line.
// The tick tests use a temp bare origin and a clone, as mergecheck.test.ts does.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `secroute-${process.pid}`)
const home = join(dir, 'home')
const origin = join(dir, 'origin.git')
const clone = join(dir, 'clone')
const other = join(dir, 'other')
const runDir = join(home, 'runs', 'r1')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args])
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

/** origin with main; branch b changes `file` */
function setup(file: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', origin])
  Bun.spawnSync(['git', 'clone', '-q', origin, other])
  writeFileSync(join(other, 'README.md'), 'base\n')
  git(other, 'add', '.')
  git(other, 'commit', '-qm', 'base')
  git(other, 'push', '-q', 'origin', 'HEAD:main')
  Bun.spawnSync(['git', 'clone', '-q', origin, clone])
  git(other, 'checkout', '-qb', 'b')
  mkdirSync(join(other, file, '..'), { recursive: true })
  writeFileSync(join(other, file), 'x\n')
  git(other, 'add', '.')
  git(other, 'commit', '-qm', 'branch')
  git(other, 'push', '-q', 'origin', 'b')
  mkdirSync(home, { recursive: true })
}

const def = (route: boolean): Factory => ({
  name: 'sr',
  start: 'plan',
  nodes: {
    plan: { prompt: 'x', agent: 'true', next: { ready: 'review' } },
    review: {
      prompt: 'review it',
      agent: 'true',
      ...(route && { securityRoute: true as const }),
      next: { approve: 'done', security: 'done', changes: 'plan' },
    },
  },
})

/** a run at review, working; the log holds a plan `ready` entry when `plan` is set */
function reviewRun(d: Factory, plan?: string) {
  const f = join(dir, 'sr.json')
  writeFileSync(f, JSON.stringify(d))
  const actor = createActor(compile(d)).start()
  if (plan !== undefined) {
    actor.send({ type: 'GOTO', node: 'plan', at: 0 })
    actor.send({ type: 'DONE', seq: actor.getSnapshot().context.seq, outcome: 'ready', summary: plan, at: 0 })
  } else actor.send({ type: 'GOTO', node: 'review', at: 0 })
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ id: 'r1', factory: f, repo: clone, goal: 'g', ws: 'ws1', worktree: clone, branch: 'b' }),
  )
  writeFileSync(
    join(runDir, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
  )
}

const env = () => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...rest } = process.env
  return { ...rest, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1' }
}
const tick = () => {
  Bun.spawnSync([CLI, 'tick'], { env: env() })
  return JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).snapshot
}
const prompt = () => {
  const snap = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).snapshot
  return readFileSync(join(runDir, 'prompts', `${snap.context.seq}-review.md`), 'utf8')
}
const routeJson = () => JSON.parse(readFileSync(join(runDir, 'security-route.json'), 'utf8'))

test('a branch that changes factories/ gets a required route in the brief and the route file (AC5)', () => {
  setup('factories/x.ts')
  reviewRun(def(true))
  const snap = tick()
  expect(prompt()).toContain('## Security route\nrequired: factories/x.ts (dir:factories)')
  expect(routeJson()).toEqual({
    seq: snap.context.seq,
    route: { required: true, why: ['factories/x.ts (dir:factories)'] },
  })
}, 60_000)

test('a plain branch with a "no" plan line gets "not required" (AC5)', () => {
  setup('src/metrics.ts')
  reviewRun(def(true), 'Risk: low.\nSecurity-sensitive: no')
  tick()
  expect(prompt()).toContain('## Security route\nnot required: ')
  expect(routeJson().route.required).toBe(false)
}, 60_000)

test('a plan "yes" line makes a plain branch required', () => {
  setup('src/metrics.ts')
  reviewRun(def(true), 'Security-sensitive: yes (parses input)')
  tick()
  expect(prompt()).toContain('required: plan says security-sensitive')
}, 60_000)

test('a non-ASCII path stays whole (AC5)', () => {
  setup('factories/naïve.ts')
  reviewRun(def(true))
  tick()
  expect(prompt()).toContain('required: factories/naïve.ts (dir:factories)')
}, 60_000)

test('a fetch that fails gives a required route with paths unknown (AC5)', () => {
  setup('src/metrics.ts')
  git(clone, 'fetch', '-q', 'origin', '+refs/heads/b:refs/remotes/origin/b') // a stale ref must not pass for a fresh diff
  git(clone, 'remote', 'set-url', 'origin', join(dir, 'gone.git'))
  reviewRun(def(true), 'Security-sensitive: no')
  tick()
  expect(prompt()).toContain('required: paths unknown')
}, 60_000)

test('the route diffs the branch the run started from, not the run branch (security round 1)', () => {
  setup('factories/x.ts')
  git(other, 'push', '-q', 'origin', 'main:empty')
  reviewRun(def(true))
  const f = join(runDir, 'run.json')
  const run = JSON.parse(readFileSync(f, 'utf8'))
  writeFileSync(f, JSON.stringify({ ...run, branch: 'empty', shipBranch: 'b' }))
  tick()
  expect(routeJson().route.required).toBe(true)
}, 60_000)

test('a station without securityRoute has no section and no route file (AC5)', () => {
  setup('factories/x.ts')
  reviewRun(def(false))
  tick()
  expect(prompt()).not.toContain('## Security route')
  expect(existsSync(join(runDir, 'security-route.json'))).toBe(false)
}, 60_000)

// report: the route file is written by the test; no git or bd runs
type Row = {
  route?: unknown
  seqOffset?: number
  outcome: string
  code: number
  err?: string[]
  def?: boolean
  summary?: string
  file?: boolean
}
const NOT = { required: false, why: [] }
const YES = { required: true, why: ['factories/x.ts (dir:factories)'] }
const rows: [string, Row][] = [
  [
    'not required, security',
    {
      route: NOT,
      outcome: 'security',
      code: 1,
      err: ['is not required', 'report approve', 'Security-reason: <path>:<line> <what is sensitive>'],
    },
  ],
  ...(
    [
      ['reason', 'Security-reason: src/cli.ts:13388 report refusal', 0],
      ['reason without line', 'Security-reason: src/cli.ts report', 1],
      ['reason with empty line', 'Security-reason: src/cli.ts: report', 1],
      ['reason with no text', 'Security-reason: src/cli.ts:12\nReviewed head: abc', 1],
      ['reason inline', 'see Security-reason: a.ts:1 b', 1],
      ['reason after U+2028', 'see\u2028Security-reason: a.ts:1 b', 1],
    ] as [string, string, number][]
  ).map(([n, summary, code]): [string, Row] => [
    `not required, security, ${n}`,
    { route: NOT, outcome: 'security', code, summary },
  ]),
  [
    'not required, security, summary file, bullet on line 2',
    {
      route: NOT,
      outcome: 'security',
      code: 0,
      file: true,
      summary: 'Reviewed head: abc\n- Security-reason: a.ts:1 b',
    },
  ],
  [
    'required, approve',
    {
      route: YES,
      outcome: 'approve',
      code: 1,
      err: ['needs the security station', 'gh pr ready <n> --undo', 'dismissals'],
    },
  ],
  ['required, security', { route: YES, outcome: 'security', code: 0 }],
  ['not required, approve', { route: NOT, outcome: 'approve', code: 0 }],
  ['no file, approve', { outcome: 'approve', code: 1 }],
  ['no file, security', { outcome: 'security', code: 0 }],
  ['older seq, approve', { route: NOT, seqOffset: -1, outcome: 'approve', code: 1 }],
  ['wrong shape, approve', { route: {}, outcome: 'approve', code: 1 }],
  ['not required, changes', { route: NOT, outcome: 'changes', code: 0 }],
  ['required, changes', { route: YES, outcome: 'changes', code: 0 }],
  ['old def, security, no file', { outcome: 'security', code: 0, def: false }],
  ['old def, approve, no file', { outcome: 'approve', code: 0, def: false }],
]
test.each(rows)(
  'report %s (AC6)',
  (_name, row) => {
    setup('src/metrics.ts')
    reviewRun(def(row.def ?? true))
    const seq = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).snapshot.context.seq
    if (row.route !== undefined)
      writeFileSync(
        join(runDir, 'security-route.json'),
        JSON.stringify({ seq: seq + (row.seqOffset ?? 0), route: row.route }),
      )
    const inbox = join(runDir, 'inbox.jsonl')
    const lines = () =>
      existsSync(inbox)
        ? readFileSync(inbox, 'utf8')
            .split('\n')
            .filter(l => l).length
        : 0
    const before = lines()
    const summary = row.summary ?? 'summary text'
    const sf = join(dir, 'summary.txt')
    if (row.file) writeFileSync(sf, summary)
    const tail = row.file ? ['--summary-file', sf] : [summary]
    const p = Bun.spawnSync([CLI, 'report', 'r1', String(seq), row.outcome, ...tail], { env: env() })
    expect(p.exitCode).toBe(row.code)
    expect(lines() - before).toBe(row.code === 0 ? 1 : 0)
    for (const e of row.err ?? []) expect(p.stderr.toString()).toContain(e)
  },
  60_000,
)
