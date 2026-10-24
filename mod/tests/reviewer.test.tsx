import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// claude-factory-ag2: a hidden `factory:reviewer` subagent recommends install or reject for each pending
// dream skill and .proposals/ item. Same setup as briefer.test.tsx.
const SLOW = { timeoutMs: 30_000 }
const HOME = '/home/acme'
const item = (name: string, kind = 'skill') => ({
  key: `${kind}:${name}:abcdef012345`,
  kind,
  name,
  change: 'new',
})

function agentListMock(on: On, ids: readonly string[], type = 'factory:reviewer') {
  on(
    'agent.list',
    () =>
      ({
        value: ids.map(id => ({ id, type, description: 'factory reviewer', status: 'running' })),
      }) as never,
  )
}

/** `reviews` feeds `factory tick`'s own `reviews` field; `review set` removes the key, like the real CLI */
function reviewerMocks(
  on: On,
  opts: {
    reviews?: () => readonly unknown[]
    halt?: 'paused'
    factsOk?: boolean
    setOk?: boolean
    calls?: string[][]
    omitReviews?: boolean
  },
) {
  const files = new Map<string, string>()
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'me' }) as never)
  on('process.run', ($, e) => {
    opts.calls?.push(e.argv as string[])
    if (e.argv[0] === 'sh') return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    if (e.argv.includes('tick')) {
      const out = JSON.stringify({
        manager: [],
        rigs: [],
        runs: [],
        halt: opts.halt,
        ...(opts.omitReviews ? {} : { reviews: opts.reviews?.() ?? [] }),
      })
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    }
    if (e.argv.includes('home')) return { value: { exitCode: 0, stdout: HOME, stderr: '' } as never }
    if (e.argv.includes('review') && e.argv.includes('facts')) {
      const ok = opts.factsOk ?? true
      const key = e.argv.at(-1)
      return {
        value: {
          exitCode: ok ? 0 : 1,
          stdout: ok ? JSON.stringify({ key, text: 'a skill text' }) : '',
          stderr: ok ? '' : 'stale key',
        } as never,
      }
    }
    if (e.argv.includes('review') && e.argv.includes('set')) {
      const ok = opts.setOk ?? true
      return {
        value: { exitCode: ok ? 0 : 1, stdout: ok ? 'ok' : '', stderr: ok ? '' : 'bad answer' } as never,
      }
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
  (files.get(`${HOME}/review-log.jsonl`) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

const spawnsOf = (on: On) => {
  const spawns: { subagent_type: string; description: string; prompt: string }[] = []
  on('agent.spawn', ($, e) => {
    const ev = e as unknown as { subagent_type: string; description: string; prompt: string }
    if (ev.subagent_type === 'factory:reviewer') spawns.push(ev)
    return { model: 'sonnet' } as never
  })
  return spawns
}

const complete = (agentId: string, answer: string, extra = {}) =>
  ({
    answer,
    durationMs: 100,
    isAborted: false,
    reason: 'answer',
    turnId: `t-${agentId}`,
    agentId,
    ...extra,
  }) as never
const GOOD = 'Reads well.\n```json\n{"recommendation":"install","why":"Safe and useful."}\n```'

test(
  '2 pending items make 2 spawns over 2 ticks, one at a time; a third tick makes none',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const calls: string[][] = []
    const files = reviewerMocks(on, { reviews: () => [item('a'), item('b', 'proposal')], calls })
    const spawns = spawnsOf(on)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['rev-1', 'rev-2'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.description).toBe('factory reviewer')
    expect(spawns[0]!.prompt).toBe('{"key":"skill:a:abcdef012345","text":"a skill text"}')
    await clock.advance(15_000)
    expect(spawns).toHaveLength(1) // one at a time

    await $.turn.complete(
      complete('rev-1', GOOD, {
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
          model: 'claude-x',
        },
      }),
    )
    const setCall = calls.find(a => a.includes('review') && a.includes('set'))!
    expect(setCall).toContain('skill:a:abcdef012345')
    expect(files.get(setCall.at(-1)!)).toBe(GOOD)
    await clock.advance(5_000)
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!.prompt).toContain('proposal:b:abcdef012345')
    await $.turn.complete(complete('rev-2', GOOD))

    await clock.advance(30_000)
    expect(spawns).toHaveLength(2) // both keys are marked for this session, though the mock still lists them

    const log = logOf(files)
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ key: 'skill:a:abcdef012345', agentId: 'rev-1', tokens: 7 })
    expect(log[0].error).toBeUndefined()
    expect(
      (files.get(`${HOME}/manager-usage.jsonl`) ?? '')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l)),
    ).toEqual([
      {
        name: 'reviewer',
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
  'a new skill text (a new key) spawns a new review',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    let pending = [item('a')]
    reviewerMocks(on, { reviews: () => pending })
    const spawns = spawnsOf(on)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['rev-1', 'rev-2'])
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.turn.complete(complete('rev-1', GOOD))
    pending = [{ ...item('a'), key: 'skill:a:111111111111' }]
    await clock.advance(5_000)
    expect(spawns).toHaveLength(2)
  },
)

test('the reviewer is registered with no tool at all', SLOW, async ($, on) => {
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
  const reviewer = registered.find(r => r.name === 'reviewer')
  expect(reviewer).toBeDefined()
  expect(reviewer!.tools).toEqual([])
})

test('a halted factory spawns no reviewer', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  reviewerMocks(on, { reviews: () => [item('a')], halt: 'paused' })
  const spawns = spawnsOf(on)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await clock.advance(60_000)
  expect(spawns).toHaveLength(0)
})

test('reviewer=false spawns none', { ...SLOW, options: { reviewer: false } }, async ($, on) => {
  const clock = mock.clock(on)
  reviewerMocks(on, { reviews: () => [item('a')] })
  const spawns = spawnsOf(on)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await clock.advance(70 * 60_000)
  expect(spawns).toHaveLength(0)
})

test(
  'an old CLI with no reviews field spawns none',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    reviewerMocks(on, { omitReviews: true })
    const spawns = spawnsOf(on)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(60_000)
    expect(spawns).toHaveLength(0)
  },
)

test(
  'a denied spawn logs one error and never retries that key',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const files = reviewerMocks(on, { reviews: () => [item('a')] })
    on('agent.spawn', () => ({ deny: 'no agent tool' }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(60_000)
    const log = logOf(files)
    expect(log).toHaveLength(1)
    expect(log[0].error).toContain('no agent tool')
  },
)

test(
  'a thrown spawn logs one error and never retries that key',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const files = reviewerMocks(on, { reviews: () => [item('a')] })
    let spawned = 0
    on('agent.spawn', () => {
      spawned += 1
      throw new Error('boom')
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(60_000)
    expect(spawned).toBe(1)
    expect(logOf(files)).toHaveLength(1)
    expect(logOf(files)[0].error).toContain('agent.spawn')
  },
)

test(
  'failed facts log one error, spawn nothing and never retry that key',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const files = reviewerMocks(on, { reviews: () => [item('a')], factsOk: false })
    const spawns = spawnsOf(on)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(60_000)
    expect(spawns).toHaveLength(0)
    expect(logOf(files)).toHaveLength(1)
    expect(logOf(files)[0].error).toContain('stale key')
  },
)

test(
  'an empty answer logs an error, clears the guard, and the next item still spawns',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const files = reviewerMocks(on, { reviews: () => [item('a'), item('b')] })
    const spawns = spawnsOf(on)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['rev-1', 'rev-2'])
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.turn.complete(complete('rev-1', '  '))
    await clock.advance(5_000)
    expect(spawns).toHaveLength(2)
    expect(logOf(files)[0].error).toContain('empty')
  },
)

test(
  'a failed review set logs the error and the next item still spawns',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    const files = reviewerMocks(on, { reviews: () => [item('a'), item('b')], setOk: false })
    const spawns = spawnsOf(on)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['rev-1', 'rev-2'])
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.turn.complete(complete('rev-1', 'no json at all'))
    await clock.advance(5_000)
    expect(spawns).toHaveLength(2)
    expect(logOf(files)[0].error).toContain('bad answer')
  },
)

test(
  'the watchdog frees a reviewer that never answers after 10 min',
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    const clock = mock.clock(on)
    reviewerMocks(on, { reviews: () => [item('a'), item('b')] })
    const spawns = spawnsOf(on)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    agentListMock(on, ['rev-1', 'rev-2'])
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(9 * 60_000)
    expect(spawns).toHaveLength(1)
    await clock.advance(2 * 60_000)
    expect(spawns).toHaveLength(2)
  },
)

// ---- claude-factory-ag2.5: tool.call denies ----

const bashMocks = (on: On, subagents: { id: string; type: string }[]) => {
  const ran: string[] = []
  on(
    'agent.list',
    () => ({ value: subagents.map(s => ({ ...s, description: '', status: 'running' })) }) as never,
  )
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]!.question
    return { result: { questions: e.questions, answers: { [question]: 'Allow' } } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ran.push((e as { command: string }).command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return ran
}

for (const command of [
  '/repo/bin/factory skills install x',
  '/repo/bin/factory proposals install x',
  'ls',
  'factory \\\nskills \\\ninstall x',
]) {
  test(
    `[SECURITY] tool.call denies every Bash command from a reviewer: ${JSON.stringify(command)}`,
    SLOW,
    async ($, on) => {
      const ran = bashMocks(on, [{ id: 'rev-1', type: 'factory:reviewer' }])
      const denied = await $.tool.call({ tool: 'Bash', command, agentId: 'rev-1' } as never)
      expect(denied.deny).toBe('a reviewer runs no command: it only recommends install or reject')
      expect(ran).toEqual([])
    },
  )
}

for (const command of [
  '/repo/bin/factory skills install x',
  '/repo/bin/factory skills reject x because',
  '/repo/bin/factory proposals install x --rig acme',
  '/repo/bin/factory proposals reject x because',
  '/repo/bin/factory \\\nskills \\\ninstall x',
  'cd /repo && FACTORY_PATROL= /repo/bin/factory   skills   install x',
]) {
  test(`[SECURITY] tool.call denies a patrol subagent: ${JSON.stringify(command)}`, SLOW, async ($, on) => {
    const ran = bashMocks(on, [{ id: 'patrol-1', type: 'factory:patrol' }])
    const denied = await $.tool.call({ tool: 'Bash', command, agentId: 'patrol-1' } as never)
    expect(denied.deny).toContain('only the manager or the person installs')
    expect(ran).toEqual([])
  })
}

test('a patrol subagent can list skills and proposals; the main chat can install', SLOW, async ($, on) => {
  const ran = bashMocks(on, [{ id: 'patrol-1', type: 'factory:patrol' }])
  const list = await $.tool.call({
    tool: 'Bash',
    command: '/repo/bin/factory skills',
    agentId: 'patrol-1',
  } as never)
  expect(list.deny).toBeUndefined()
  const list2 = await $.tool.call({
    tool: 'Bash',
    command: '/repo/bin/factory proposals',
    agentId: 'patrol-1',
  } as never)
  expect(list2.deny).toBeUndefined()
  const main = await $.tool.call({ tool: 'Bash', command: '/repo/bin/factory skills install x' } as never)
  expect(main.deny).toBeUndefined()
  expect(ran).toHaveLength(3)
})

test(
  "a task-notification naming a reviewer's own id is dropped, once its Bash call showed the id",
  { ...SLOW, options: { reviewer: true } },
  async ($, on) => {
    bashMocks(on, [{ id: 'rev-9', type: 'factory:reviewer' }])
    await $.tool.call({ tool: 'Bash', command: 'true', agentId: 'rev-9' } as never)
    const own = await $.prompt.submit({
      text: '<task-notification> <task-id>rev-9</task-id> done',
      wait: false,
      origin: { kind: 'task-notification' },
    } as never)
    expect((own as { drop?: string }).drop).toBeDefined()
  },
)
