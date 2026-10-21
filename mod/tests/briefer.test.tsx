import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The kit's default timeout is 5000ms. Each test's first `$` call starts the plugin. Under
// high shared-host load, that first call can take longer than 5000ms (claude-factory-abm).
// This raises the limit to 30000ms, the same as pm.test.tsx's own SLOW.
const SLOW = { timeoutMs: 30_000 }

const HOME = '/home/acme'
const GATE = { question: 'ship it?', outcomes: ['approve', 'reject'] }
/** no mail, no idle, no `working` sub, no rig goal: the patrol stays undue, the same reason
 * pm.test.tsx's own `RUN` leaves the patrol undue, so a briefer test's `agent.spawn` capture
 * sees only the briefer's own spawns. `since` feeds the gate key (`gate:<id>@<since>`). */
const GATE_RUN = (id: string, since = 1, brief?: string) => ({
  id,
  rig: 'acme',
  node: 'gate',
  sub: 'waiting',
  since,
  gate: brief ? { ...GATE, brief } : { ...GATE },
})

/** Answers `$.agent.list()` with one running agent of each named type, the same shape
 * pm.test.tsx's own `agentListMock` uses, with a `brieferIds` list added for the briefer. */
function agentListMock(on: On, brieferIds: readonly string[]) {
  on(
    'agent.list',
    () =>
      ({
        value: brieferIds.map(id => ({
          id,
          type: 'factory:briefer',
          description: 'factory briefer',
          status: 'running',
        })),
      }) as never,
  )
}

/**
 * All the mocks a briefer test needs, except `agent.spawn` and `turn.complete`. Each test sets
 * up those two itself, the same split pm.test.tsx's own `pmMocks` uses.
 * - `runs`: feeds `factory tick`'s own `runs` field.
 * - `files`: acts like a real `<home>` filesystem. The mock for `factory gate-brief set` writes
 *   the brief into `runs`' own gate object, so a later tick sees the gate as already briefed,
 *   the same way the real CLI's `gate.brief` field would read once `gate-brief set` ran.
 */
function brieferMocks(
  on: On,
  opts: {
    runs: () => readonly unknown[]
    files?: Map<string, string>
    facts?: string
    factsOk?: boolean
    setOk?: boolean
    calls?: string[][]
  },
) {
  const files = opts.files ?? new Map<string, string>()
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'me' }) as never)
  on('process.run', ($, e) => {
    opts.calls?.push(e.argv as string[])
    if (e.argv[0] === 'sh') return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    if (e.argv.includes('tick')) {
      const out = JSON.stringify({ manager: [], rigs: [], runs: opts.runs() })
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    }
    if (e.argv.includes('home')) return { value: { exitCode: 0, stdout: HOME, stderr: '' } as never }
    if (e.argv.includes('gate-brief') && e.argv.includes('facts')) {
      const ok = opts.factsOk ?? true
      const stdout = ok ? (opts.facts ?? '{"rig":"acme"}') : ''
      return { value: { exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'no gate' } as never }
    }
    if (e.argv.includes('gate-brief') && e.argv.includes('set')) {
      const ok = opts.setOk ?? true
      return { value: { exitCode: ok ? 0 : 1, stdout: ok ? 'ok' : '', stderr: ok ? '' : 'bad key' } as never }
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
  (files.get(`${HOME}/brief-log.jsonl`) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

const spawnsOf = (on: On, type: string) => {
  const spawns: { subagent_type: string; description: string; prompt: string }[] = []
  on('agent.spawn', ($, e) => {
    const ev = e as unknown as { subagent_type: string; description: string; prompt: string }
    if (ev.subagent_type === type) spawns.push(ev)
    return { model: 'sonnet' } as never
  })
  return spawns
}

test(
  'a gate row spawns exactly one factory:briefer, and 3 more ticks spawn no second',
  { ...SLOW, options: { briefer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const files = brieferMocks(on, { runs: () => [GATE_RUN('r1')] })
    const spawns = spawnsOf(on, 'factory:briefer')
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['brief-1'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.subagent_type).toBe('factory:briefer')
    expect(spawns[0]!.description).toBe('factory briefer')
    expect(spawns[0]!.prompt).toBe('{"rig":"acme"}')

    // the gate still has no brief on the board (the mock's own `runs()` never changes), but
    // `rt.briefed` already marks this key: 3 more ticks (15s) spawn no second attempt
    await clock.advance(15_000)
    expect(spawns).toHaveLength(1)

    await $.turn.complete({
      answer: '- ship it, pr #1 merged',
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'brief-1',
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
        model: 'claude-x',
      },
    } as never)
    // claude-factory-hr94: the briefer's turn is counted under its own name
    expect(
      (files.get(`${HOME}/manager-usage.jsonl`) ?? '')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l)),
    ).toEqual([
      {
        name: 'briefer',
        at: expect.any(Number),
        model: 'claude-x',
        input: 3,
        cacheWrite: 2,
        cacheRead: 5,
        output: 4,
      },
    ])
  },
)

test(
  'a gate row whose gate already has a brief spawns no briefer',
  { ...SLOW, options: { briefer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    brieferMocks(on, { runs: () => [GATE_RUN('r2', 1, 'already briefed')] })
    const spawns = spawnsOf(on, 'factory:briefer')
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(60_000)

    expect(spawns).toHaveLength(0)
  },
)

test(
  'two gates make two serial spawns, one at a time',
  { ...SLOW, options: { briefer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    brieferMocks(on, { runs: () => [GATE_RUN('r3', 1), GATE_RUN('r4', 2)] })
    const spawns = spawnsOf(on, 'factory:briefer')
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['brief-3', 'brief-4'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    // one at a time: the second gate's briefer does not spawn while the first still runs
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.prompt).toContain('acme')

    await $.turn.complete({
      answer: '- r3 brief',
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'brief-3',
    } as never)
    await clock.advance(5_000)

    expect(spawns).toHaveLength(2)

    await $.turn.complete({
      answer: '- r4 brief',
      durationMs: 100,
      isAborted: false,
      reason: 'answer',
      turnId: 't2',
      agentId: 'brief-4',
    } as never)
  },
)

test('a denied spawn is not retried for that key', { ...SLOW, options: { briefer: true } }, async ($, on) => {
  const clock = mock.clock(on)
  const files = brieferMocks(on, { runs: () => [GATE_RUN('r5')] })
  on('agent.spawn', () => ({ deny: 'no agent tool' }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)

  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await clock.advance(60_000)

  // the deny leaves the key marked (rt.briefed): only one brief-log entry, ever, for this gate
  const log = logOf(files)
  expect(log).toHaveLength(1)
  expect(log[0].error).toContain('no agent tool')
})

test(
  "turn.complete runs `gate-brief set` with the gate's own key, writing the answer to a file first",
  { ...SLOW, options: { briefer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const calls: string[][] = []
    const files = brieferMocks(on, { runs: () => [GATE_RUN('r6', 7)], calls })
    on('agent.spawn', () => ({ model: 'sonnet' }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['brief-6'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    await $.turn.complete({
      answer: '- the pull request is green\n- the review found no risk',
      durationMs: 300,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'brief-6',
    } as never)

    const setCall = calls.find(a => a.includes('gate-brief') && a.includes('set'))
    expect(setCall).toBeDefined()
    expect(setCall).toContain('gate:r6@7')
    const answerPath = setCall!.at(-1)!
    expect(files.get(answerPath)).toBe('- the pull request is green\n- the review found no risk')

    const log = logOf(files)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ key: 'gate:r6@7', agentId: 'brief-6' })
    expect(log[0].error).toBeUndefined()
  },
)

test(
  "briefer=false in the plugin's own userConfig spawns no briefer, even past 60 minutes",
  { ...SLOW, options: { briefer: false } },
  async ($, on) => {
    const clock = mock.clock(on)
    brieferMocks(on, { runs: () => [GATE_RUN('r7')] })
    const spawns = spawnsOf(on, 'factory:briefer')
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(70 * 60_000)

    expect(spawns).toHaveLength(0)
  },
)

test(
  'session.start registers the briefer with no tool at all, matching its own prompt (claude-factory-2u2)',
  SLOW,
  async ($, on) => {
    mock.clock(on)
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

    const briefer = registered.find(r => r.name === 'briefer')
    expect(briefer).toBeDefined()
    // an empty array, not left out, the same guard the pm's own registration uses: the untrusted
    // pull request and journal text the briefer reads must never reach a tool call
    expect(briefer!.tools).toEqual([])
  },
)

// ---- claude-factory-2u2.4: tool.call denies every Bash call from a briefer, decide included ----

test(
  '[SECURITY] tool.call denies a `decide` from the briefer, with no dialog, before the briefer ever runs it',
  SLOW,
  async ($, on) => {
    let asked = 0
    let ran = 0
    on(
      'agent.list',
      () =>
        ({
          value: [{ id: 'brief-1', type: 'factory:briefer', description: '', status: 'running' }],
        }) as never,
    )
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked += 1
      const question = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [question]: 'Allow' } } }
    })
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: 'decided', stderr: '', interrupted: false } }
    })

    const denied = await $.tool.call({
      tool: 'Bash',
      command: '/repo/bin/factory decide r1 ship "looks good"',
      agentId: 'brief-1',
    } as never)

    expect(denied.deny).toBe('a briefer runs no command: it only writes the gate brief')
    expect(asked).toBe(0) // no dialog: a subagent gets none, the same reason a patrol gets none
    expect(ran).toBe(0) // the Bash mock never runs
  },
)

test(
  '[SECURITY] tool.call denies an ungated `factory status` from the briefer too, not only a gated command',
  SLOW,
  async ($, on) => {
    let ran = 0
    on(
      'agent.list',
      () =>
        ({
          value: [{ id: 'brief-2', type: 'factory:briefer', description: '', status: 'running' }],
        }) as never,
    )
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    const denied = await $.tool.call({
      tool: 'Bash',
      command: '/repo/bin/factory status',
      agentId: 'brief-2',
    } as never)

    expect(denied.deny).toBe('a briefer runs no command: it only writes the gate brief')
    expect(ran).toBe(0)
  },
)

test(
  'a `decide` from a non-briefer subagent is still denied, but by the generic gated-command path',
  SLOW,
  async ($, on) => {
    let asked = 0
    let ran = 0
    on('agent.list', () => ({ value: [] }) as never) // confirms no subagent as a briefer: the generic path alone denies this
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked += 1
      const question = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [question]: 'Allow' } } }
    })
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: 'decided', stderr: '', interrupted: false } }
    })

    const denied = await $.tool.call({
      tool: 'Bash',
      command: '/repo/bin/factory decide r1 ship "looks good"',
      agentId: 'some-other-agent',
    } as never)

    expect(denied.deny).toContain('did not confirm')
    expect(denied.deny).toContain('A patrol never decides this')
    expect(asked).toBe(0)
    expect(ran).toBe(0)
  },
)
