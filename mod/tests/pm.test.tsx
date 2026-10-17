import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The kit's default timeout is 5000ms. Each test's first `$` call starts the plugin. Under
// high shared-host load, that first call can take longer than 5000ms (claude-factory-abm).
// This raises the limit to 30000ms.
const SLOW = { timeoutMs: 30_000 }

const HOME = '/home/acme'
/** no mail, no idle, no `working` sub, no rig goal: the patrol stays undue so a pm test's own
 * `agent.spawn` capture sees only the pm's own spawns */
const RUN = (id: string) => ({ id, rig: 'acme', node: 'implement', sub: 'waiting', goal: 'g' })
const mail = (at: number) => ({ run: 'r1', from: 'implement', text: 'blocked: which DB?', at })
const fenced = (body: string) => `\`\`\`json\n${body}\n\`\`\``
const PLAN_ANSWER = fenced('{"rigs":{},"proposals":[]}')

/** Answers `$.agent.list()` with one running agent of each named type. Lets the `isPmAgent` and
 * `isPatrolAgent` checks (register.tsx) confirm a `turn.complete`'s own `agentId` is really the
 * subagent it claims to be, the way a real session's `$.agent.list()` would. */
function agentListMock(on: On, patrolIds: readonly string[], pmIds: readonly string[] = []) {
  on(
    'agent.list',
    () =>
      ({
        value: [
          ...patrolIds.map(id => ({
            id,
            type: 'factory:patrol',
            description: 'factory patrol',
            status: 'running',
          })),
          ...pmIds.map(id => ({ id, type: 'factory:pm', description: 'factory pm', status: 'running' })),
        ],
      }) as never,
  )
}

/**
 * All the mocks a pm test needs, except `agent.spawn` and `turn.complete`. Each test sets up
 * those two itself.
 * - `runs`: feeds `factory tick`'s own `runs` field.
 * - `manager`: feeds its `manager` mail. `clearManager` clears that mail after one tick, the
 *   way a real `factory tick` clears mail it already sent.
 * - `files`: acts like a real `<home>` filesystem for the test. The mock for `factory plan
 *   set` writes a plan into `files`, so a later `readPlan` call in the same test finds a real
 *   plan.
 * - `paneOwner`: makes `isPaneSession` treat the pane as owned by a different session (a
 *   background fork). It sets the owner in the mock answer to `register.tsx`'s own pane check
 *   (`$.process.run(['sh', '-c', ...])`), and sets `$.session.id()`'s answer to `'me'`, a
 *   different id.
 */
function pmMocks(
  on: On,
  opts: {
    runs: () => readonly unknown[]
    manager?: () => readonly unknown[]
    clearManager?: () => void
    files?: Map<string, string>
    facts?: string
    planSetOut?: () => string
    paneOwner?: string
    calls?: string[][]
    /** captures every `$.ui.status` call, for a test that checks the pm's own status line */
    status?: unknown[]
    /** the manager session's own tool names, as `$.tool.list()` would answer. Left out: no
     * `tool.list` mock at all, the same as an old engine or an unmocked test (claude-factory-dun.29) */
    tools?: readonly string[]
  },
) {
  const files = opts.files ?? new Map<string, string>()
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('ui.status', (_, e) => (opts.status?.push(e), { value: undefined }) as never)
  if (opts.tools !== undefined)
    on(
      'tool.list',
      () => ({ value: opts.tools!.map(name => ({ name, description: '', mcp: false })) }) as never,
    )
  on('session.id', () => ({ value: 'me' }) as never)
  on('process.run', ($, e) => {
    opts.calls?.push(e.argv as string[])
    if (e.argv[0] === 'sh') {
      const stdout = opts.paneOwner
        ? JSON.stringify({ result: { pane: { agent_session: { value: opts.paneOwner } } } })
        : ''
      return { value: { exitCode: 0, stdout, stderr: '' } as never }
    }
    if (e.argv.includes('tick')) {
      const out = JSON.stringify({ manager: opts.manager ? opts.manager() : [], rigs: [], runs: opts.runs() })
      opts.clearManager?.()
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    }
    if (e.argv.includes('home')) return { value: { exitCode: 0, stdout: HOME, stderr: '' } as never }
    if (e.argv.includes('plan') && e.argv.includes('facts'))
      return { value: { exitCode: 0, stdout: opts.facts ?? '{"rigs":{}}', stderr: '' } as never }
    if (e.argv.includes('plan') && e.argv.includes('set')) {
      // a real `factory plan set` writes plan.json on success: this mock does the same, so a
      // later `readPlan` in the same test sees a fresh plan, the same as the real CLI
      files.set(`${HOME}/plan.json`, JSON.stringify({ at: 0, rigs: {}, proposals: [] }))
      const stdout = opts.planSetOut ? opts.planSetOut() : JSON.stringify({ items: 0, findings: 0, filed: 0 })
      return { value: { exitCode: 0, stdout, stderr: '' } as never }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('fs.read', ($, e) => {
    const path = (e as { path: string }).path
    if (!files.has(path)) throw new Error(`ENOENT: no such file, open '${path}'`)
    return { value: files.get(path)! } as never
  })
  on('fs.write', ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files.set(path, text)
    return { value: undefined } as never
  })
  return files
}

const logOf = (files: Map<string, string>) =>
  (files.get(`${HOME}/pm-log.jsonl`) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

test(
  'the pm spawns once at the first tick with no plan yet, and not again before 60 minutes once it has one',
  { ...SLOW, options: { pm: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: { subagent_type: string; description: string; prompt: string }[] = []
    pmMocks(on, { runs: () => [RUN('r1')] })
    on('agent.spawn', ($, e) => {
      const ev = e as unknown as { subagent_type: string; description: string; prompt: string }
      if (ev.subagent_type === 'factory:pm') spawns.push(ev)
      return { model: 'sonnet' } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, [], ['pm-1'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.subagent_type).toBe('factory:pm')
    expect(spawns[0]!.description).toBe('factory pm')
    expect(spawns[0]!.prompt).toBe('{"rigs":{}}')

    // a fenced answer gives it a real plan.json; the next due check is then driven by the 60
    // minute interval, not "no plan yet"
    await $.turn.complete({
      answer: PLAN_ANSWER,
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'pm-1',
    } as never)
    await clock.settle()

    // well under 60 minutes later: no second spawn
    await clock.advance(59 * 60_000)
    expect(spawns).toHaveLength(1)

    // past the hour, the plan is stale: the next tick spawns a second pm turn
    await clock.advance(2 * 60_000)
    expect(spawns).toHaveLength(2)

    // leave no pm turn running, so a later test in this file is not blocked by it
    await $.turn.complete({
      answer: PLAN_ANSWER,
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't2',
      agentId: 'pm-1',
    } as never)
  },
)

test(
  'a run going from live to not live wakes the pm again, after a 5 minute debounce',
  { ...SLOW, options: { pm: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    let live: readonly unknown[] = [RUN('r2')]
    pmMocks(on, { runs: () => live })
    on('agent.spawn', ($, e) => {
      const ev = e as unknown as { subagent_type: string }
      if (ev.subagent_type === 'factory:pm') spawns.push(ev)
      return { model: 'sonnet' } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, [], ['pm-2'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(spawns).toHaveLength(1)

    await $.turn.complete({
      answer: PLAN_ANSWER,
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'pm-2',
    } as never)
    await clock.settle()

    // the run finishes: liveIds drops it. Short of the debounce window, still one spawn
    live = []
    await clock.advance(2 * 60_000)
    expect(spawns).toHaveLength(1)

    // past the 5 minute debounce since the drop, it wakes the pm again
    await clock.advance(4 * 60_000)
    expect(spawns).toHaveLength(2)

    await $.turn.complete({
      answer: PLAN_ANSWER,
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't2',
      agentId: 'pm-2',
    } as never)
  },
)

test(
  'the pm never spawns when the pane belongs to a different session (a background fork)',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    pmMocks(on, { runs: () => [RUN('r3')], paneOwner: 'someone-else' })
    on('agent.spawn', ($, e) => {
      const ev = e as unknown as { subagent_type: string }
      if (ev.subagent_type === 'factory:pm') spawns.push(ev)
      return { model: 'sonnet' } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(70 * 60_000)

    expect(spawns).toHaveLength(0)
  },
)

test(
  'a fenced json answer writes plan-answer.json, runs plan set, and logs its summary',
  { ...SLOW, options: { pm: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const calls: string[][] = []
    const files = pmMocks(on, {
      runs: () => [RUN('r4')],
      calls,
      planSetOut: () => JSON.stringify({ items: 4, findings: 1, filed: 1 }),
    })
    on('agent.spawn', () => ({ model: 'sonnet' }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, [], ['pm-4'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    const answer = fenced('{"rigs":{"acme":[{"id":"acme-1","why":"fits the goal"}]},"proposals":[]}')
    await $.turn.complete({
      answer,
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'pm-4',
    } as never)

    const planSet = calls.find(a => a.includes('plan') && a.includes('set'))
    expect(planSet).toBeDefined()
    const answerPath = planSet!.at(-1)!
    expect(files.get(answerPath)).toBe(
      '{"rigs":{"acme":[{"id":"acme-1","why":"fits the goal"}]},"proposals":[]}',
    )

    const log = logOf(files)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ agentId: 'pm-4', items: 4, findings: 1, filed: 1 })
    expect(log[0].error).toBeUndefined()
  },
)

test(
  'a fenceless pm answer logs an error and never calls plan set',
  { ...SLOW, options: { pm: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const calls: string[][] = []
    const files = pmMocks(on, { runs: () => [RUN('r5')], calls })
    on('agent.spawn', () => ({ model: 'sonnet' }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, [], ['pm-5'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    await $.turn.complete({
      answer: 'no fenced block here, sorry',
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'pm-5',
    } as never)

    expect(calls.some(a => a.includes('plan') && a.includes('set'))).toBe(false)
    expect(files.has(`${HOME}/plan.json`)).toBe(false)
    const log = logOf(files)
    expect(log).toHaveLength(1)
    expect(log[0].error).toBe("the pm's answer had no fenced json block")
  },
)

test(
  "a pm turn.complete never frees the patrol, and the patrol's own turn never frees the pm",
  { ...SLOW, options: { pm: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    let queued: readonly unknown[] = [mail(1)]
    const patrolSpawns: unknown[] = []
    const pmSpawns: unknown[] = []
    pmMocks(on, {
      runs: () => [RUN('r1')],
      manager: () => queued,
      clearManager: () => (queued = []),
    })
    on('agent.spawn', ($, e) => {
      const ev = e as unknown as { subagent_type: string }
      if (ev.subagent_type === 'factory:pm') pmSpawns.push(ev)
      else patrolSpawns.push(ev)
      return { model: 'sonnet' } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['patrol-6'], ['pm-6'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(patrolSpawns).toHaveLength(1)
    expect(pmSpawns).toHaveLength(1)

    // complete only the pm's own turn
    await $.turn.complete({
      answer: PLAN_ANSWER,
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'pm-6',
    } as never)

    // the patrol stays blocked: fresh mail at the next tick starts no second patrol
    queued = [mail(2)]
    await clock.advance(5_000)
    expect(patrolSpawns).toHaveLength(1)
    expect(pmSpawns).toHaveLength(1)

    // leave neither subagent running, so a later test in this file is not blocked by either
    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't2',
      agentId: 'patrol-6',
    } as never)
  },
)

test(
  "pm=false in the plugin's own userConfig never spawns the pm, even past 60 minutes with no plan",
  { ...SLOW, options: { pm: false } },
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    pmMocks(on, { runs: () => [RUN('r7')] })
    on('agent.spawn', ($, e) => {
      spawns.push(e)
      return { model: 'sonnet' } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(70 * 60_000)

    expect(spawns).toHaveLength(0)
  },
)

// ---- claude-factory-dun.29: the manager has no Agent tool, so every `$.agent.spawn` throws ----

test(
  'the pm is blocked when the manager has no Agent tool: no plan facts, no spawn, one status line and one pm-log entry, even after 3 hours of ticks',
  { ...SLOW, options: { pm: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const calls: string[][] = []
    const status: unknown[] = []
    const spawns: unknown[] = []
    const files = pmMocks(on, { runs: () => [RUN('r8')], calls, status, tools: ['Bash', 'Read'] })
    on('agent.spawn', ($, e) => {
      spawns.push(e)
      return { model: 'sonnet' } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(3 * 60 * 60_000)

    expect(calls.some(a => a.includes('plan') && a.includes('facts'))).toBe(false)
    expect(spawns).toHaveLength(0)
    const log = logOf(files)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ reason: 'blocked' })
    expect(log[0].error).toContain('Agent tool')
    expect(status.filter(s => JSON.stringify(s).includes('pm is blocked'))).toHaveLength(1)
  },
)

test(
  'the pm spawns normally when tool.list resolves with Agent present',
  { ...SLOW, options: { pm: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    pmMocks(on, { runs: () => [RUN('r9')], tools: ['Bash', 'Agent'] })
    on('agent.spawn', ($, e) => {
      const ev = e as unknown as { subagent_type: string }
      if (ev.subagent_type === 'factory:pm') spawns.push(ev)
      return { model: 'sonnet' } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, [], ['pm-9'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    expect(spawns).toHaveLength(1)

    await $.turn.complete({
      answer: PLAN_ANSWER,
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'pm-9',
    } as never)
  },
)

test(
  'a pm spawn that is denied every time backs off: facts gather at t0, +60s, +180s, +420s, one pm-log error line each',
  { ...SLOW, options: { pm: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const calls: string[][] = []
    const files = pmMocks(on, { runs: () => [RUN('r10')], calls, tools: ['Bash', 'Agent'] })
    // a repeated throw deregisters a test's own mock after it first fires (unlike a plain denied
    // answer), so every retry in this test uses `res.deny`, the sibling failure path pmNow treats
    // the same way (claude-factory-dun.29): both count `rt.pmFailures` and back off the same.
    on('agent.spawn', () => ({ deny: 'spawn blew up' }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    const factsCalls = () => calls.filter(a => a.includes('plan') && a.includes('facts')).length

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(factsCalls()).toBe(1) // t0: due at once, spawn throws, failures=1, retry in 60s

    await clock.advance(55_000)
    expect(factsCalls()).toBe(1) // short of 60s since t0: no retry yet
    await clock.advance(5_000)
    expect(factsCalls()).toBe(2) // +60s: retry, throws again, failures=2, retry in 120s

    await clock.advance(115_000)
    expect(factsCalls()).toBe(2) // short of +180s since t0: no retry yet
    await clock.advance(5_000)
    expect(factsCalls()).toBe(3) // +180s: retry, throws again, failures=3, retry in 240s

    await clock.advance(235_000)
    expect(factsCalls()).toBe(3) // short of +420s since t0: no retry yet
    await clock.advance(5_000)
    expect(factsCalls()).toBe(4) // +420s: retry, throws again, failures=4

    const log = logOf(files)
    expect(log).toHaveLength(4)
    for (const entry of log) {
      expect(entry.reason).toBe('spawn-failed')
      expect(entry.error).toContain('spawn blew up')
    }
  },
)

test(
  'session.start registers the pm with no tool at all, matching its own prompt (claude-factory-dun.10)',
  SLOW,
  async ($, on) => {
    mock.clock(on)
    // nothing beneath the plugin under test answers session.start by default: this test's own
    // hook stands in for the engine's own, the same as a real session reaching this plugin's
    on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    on('ui.status', () => ({ value: undefined }) as never)
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    on('command.register', () => ({ value: { command: 'factory' } }) as never)
    const registered: { name: string; tools?: readonly string[] }[] = []
    on('agent.register', ($, e) => {
      registered.push(e as unknown as { name: string; tools?: readonly string[] })
      return { value: { agent: `factory:${(e as unknown as { name: string }).name}` } } as never
    })

    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)

    const pm = registered.find(r => r.name === 'pm')
    expect(pm).toBeDefined()
    // an empty array, not left out: a left-out `tools` field gives the pm every tool its parent
    // session has, which an untrusted bead title could use to leak a local file into a proposal
    expect(pm!.tools).toEqual([])
    // the patrol keeps its own tools: this guards the pm alone, not every agent
    const patrol = registered.find(r => r.name === 'patrol')
    expect(patrol!.tools).toEqual(['Bash', 'Read', 'Grep', 'Glob'])
  },
)

// ---- claude-factory-dun.32: the pm's default is on again, not just when a test says so ----

test(
  'the pm spawns when due with no options.pm override at all: the default is on, not only set true by the test (claude-factory-dun.32)',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    pmMocks(on, { runs: () => [RUN('r11')], tools: ['Bash', 'Agent'] })
    on('agent.spawn', ($, e) => {
      const ev = e as unknown as { subagent_type: string }
      if (ev.subagent_type === 'factory:pm') spawns.push(ev)
      return { model: 'sonnet' } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, [], ['pm-11'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    expect(spawns).toHaveLength(1)
  },
)
