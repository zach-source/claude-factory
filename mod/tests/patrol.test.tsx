import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// raises the kit's 5000ms default: under high shared-host load the first `$` call in each of
// this file's tests (the plugin's own startup) can outlast 5000ms (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

const RUN = { id: 'r1', rig: 'api', node: 'implement', sub: 'waiting', goal: 'g' }
const mail = (at: number) => ({ run: 'r1', from: 'implement', text: 'blocked: which DB?', at })

/** Answers `$.agent.list()` with one running `factory:patrol` agent for each id in `patrolIds`.
 * This lets the tool.call hook's `isPatrolAgent` check (claude-factory-72v.9) confirm a Bash
 * call's `agentId` is really the patrol, the way a real session's `$.agent.list()` would. */
function agentListMock(on: On, patrolIds: readonly string[]) {
  on(
    'agent.list',
    () =>
      ({
        value: patrolIds.map(id => ({
          id,
          type: 'factory:patrol',
          description: 'factory patrol',
          status: 'running',
        })),
      }) as never,
  )
}

/** every mock a patrol test needs beside `agent.spawn`, `turn.complete` and `prompt.submit`, which
 * each test sets up its own way. `manager` is mutable: set it to delivery mail for the next tick,
 * read it is cleared right after, as the real `factory tick` would not resend delivered mail. */
function baseMocks(on: On, manager: () => readonly unknown[], clear: () => void) {
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('process.run', ($, e) => {
    if (e.argv.includes('tick')) {
      const out = JSON.stringify({ manager: manager(), rigs: [], runs: [RUN] })
      clear()
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
}

/**
 * `baseMocks` plus a real `factory home` answer and an in-memory `$.fs.read`/`$.fs.write`
 * (`files`, keyed by path), so `patrol-log.jsonl` behaves like a real file across the test.
 */
function homeMocks(
  on: On,
  manager: () => readonly unknown[],
  clear: () => void,
  home: string,
  files: Map<string, string>,
) {
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  on('ui.open', () => ({ value: undefined }) as never)
  on('process.run', ($, e) => {
    if (e.argv.includes('tick')) {
      const out = JSON.stringify({ manager: manager(), rigs: [], runs: [RUN] })
      clear()
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    }
    if (e.argv.includes('home')) return { value: { exitCode: 0, stdout: home, stderr: '' } as never }
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
}

test(
  'a due patrol spawns the hidden factory:patrol subagent, never prompt.submit, one at a time, freed by turn.complete',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: { subagent_type: string; description: string; prompt: string }[] = []
    const submits: unknown[] = []
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    const status: unknown[] = []
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    on('agent.spawn', ($, e) => {
      spawns.push(e as never)
      return { model: 'sonnet' } as never
    })
    on('prompt.submit', ($, e) => {
      submits.push(e)
      return { text: e.text } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    // claude-factory-72v.17: the fallback branch (rt.patrolId unset, as agent.spawn delivers no
    // agentId in this test kit) now also requires isPatrolAgent to confirm 'patrol-1' before
    // adopting it as this test's own patrol
    agentListMock(on, ['patrol-1'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.subagent_type).toBe('factory:patrol')
    expect(spawns[0]!.description).toBe('factory patrol')
    expect(spawns[0]!.prompt).toContain('[factory] patrol')
    expect(spawns[0]!.prompt).toContain('which DB?')
    expect(submits).toHaveLength(0) // the subagent path never falls back to the main chat

    // one patrol at a time: the next tick, with the subagent still running, spawns no second one
    await clock.advance(5_000)
    expect(spawns).toHaveLength(1)

    // its own turn.complete frees the next one
    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-1',
    } as never)
    queued = [mail(2)]
    await clock.advance(5_000)
    // freed, and new mail due: the next tick spawns a second patrol, carrying that mail
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!.prompt).toContain('which DB?')

    // leave no patrol running, so a later test in this file is not blocked by it
    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't2',
      agentId: 'patrol-1',
    } as never)
  },
)

test(
  'a patrol stuck past 15 minutes with no answer is freed by the watchdog, not left blocking every later one',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    const status: unknown[] = []
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    on('agent.spawn', () => {
      spawns.push({})
      return { model: 'sonnet', agentId: 'patrol-1' } as never
    })
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    // claude-factory-72v.17: agent.spawn delivers no agentId for a registered agent type in this
    // test kit, no matter what this mock answers (claude-factory-72v memory): the cleanup
    // turn.complete below needs isPatrolAgent to confirm 'patrol-1' before adopting it
    agentListMock(on, ['patrol-1'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(spawns).toHaveLength(1)

    // well short of 15 minutes: still one patrol, no watchdog message yet
    await clock.advance(10 * 60_000)
    expect(spawns).toHaveLength(1)
    expect(JSON.stringify(status)).not.toContain('watchdog')

    // past 15 minutes with no turn.complete: the watchdog frees it, and new mail lets a fresh one start
    queued = [mail(2)]
    await clock.advance(6 * 60_000)
    expect(JSON.stringify(status)).toContain('the watchdog freed the next one')
    expect(spawns).toHaveLength(2)

    // leave no patrol running, for the tests that follow
    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't3',
      agentId: 'patrol-1',
    } as never)
  },
)

test(
  'a rejected spawn (an old manager with no Agent tool) falls back to the main chat once, and says so',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const submits: { text: string }[] = []
    const status: unknown[] = []
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    on('agent.spawn', () => {
      throw new Error('no tool named "Agent" in this session')
    })
    on('prompt.submit', ($, e) => {
      submits.push(e as never)
      return { text: e.text } as never
    })

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    expect(submits).toHaveLength(1)
    expect(submits[0]!.text).toContain('[factory] patrol')
    expect(submits[0]!.text).toContain('which DB?')
    // claude-factory-72v.13: manual() no longer carries the patrol's own loop rules (PATROL does),
    // so the fallback must carry them itself, or the main chat gets due.text with no rules to work it
    expect(submits[0]!.text).toContain('## Factory patrol')
    expect(submits[0]!.text).toContain("You are the factory manager's patrol")
    expect(JSON.stringify(status)).toContain('fell back to the main chat')
  },
)

test(
  "a task-notification naming a patrol's own id is dropped before it reaches the main chat; an unrelated one is not",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const submits: unknown[] = []
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'patrol-9' }) as never)
    agentListMock(on, ['patrol-9'])
    on('prompt.submit', ($, e) => {
      submits.push(e)
      return { text: e.text } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    // the real Bash tool, beneath register.tsx's own tool.call hook
    on(
      'tool.call',
      { tool: 'Bash' },
      () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never,
    )

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    // the engine carries the running loop's id as e.agentId on the subagent's own Bash call
    // (AgentLoop, absent on the main loop): the patrol's first one lets rt.patrolNow learn its
    // real id, since agent.spawn's resolved value never carries one back in a mod test. The
    // agentListMock above confirms it (claude-factory-72v.9), the way $.agent.list() would in
    // a real session.
    await $.tool.call({ tool: 'Bash', command: 'true', agentId: 'patrol-9' } as never)

    const own = await $.prompt.submit({
      text: '<task-notification> <task-id>patrol-9</task-id> done',
      wait: false,
      origin: { kind: 'task-notification' },
    } as never)
    expect((own as { drop?: string }).drop).toBeDefined()
    expect(submits).toHaveLength(0)

    const other = await $.prompt.submit({
      text: '<task-notification> <task-id>some-other-agent</task-id> done',
      wait: false,
      origin: { kind: 'task-notification' },
    } as never)
    expect((other as { drop?: string }).drop).toBeUndefined()
    expect(submits).toHaveLength(1)

    // leave no patrol running, for the test that follows
    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't4',
      agentId: 'patrol-9',
    } as never)
  },
)

test(
  'a denied spawn keeps the mail unsent and retries after 60 seconds, losing nothing',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: { prompt: string }[] = []
    const status: unknown[] = []
    let isDenied = true
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    on('agent.spawn', ($, e) => {
      spawns.push(e as never)
      return (isDenied ? { deny: 'not now' } : { model: 'sonnet', agentId: 'patrol-5' }) as never
    })
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    // claude-factory-72v.17: agent.spawn delivers no agentId for a registered agent type in this
    // test kit, no matter what this mock answers (claude-factory-72v memory): the cleanup
    // turn.complete below needs isPatrolAgent to confirm 'patrol-5' before adopting it
    agentListMock(on, ['patrol-5'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(spawns).toHaveLength(1)
    expect(JSON.stringify(status)).toContain('the patrol spawn was denied')

    // within the 60 s retry window: no second attempt, even though the mail is still due
    await clock.advance(5_000)
    expect(spawns).toHaveLength(1)

    // past the window: the retry carries the very same mail, so nothing was lost to the denial
    isDenied = false
    await clock.advance(56_000)
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!.prompt).toContain('which DB?')

    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't5',
      agentId: 'patrol-5',
    } as never)
  },
)

test(
  "[SECURITY] a subagent's gated command is denied with no dialog; the main chat's own still asks",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    let asked = 0
    let ran = 0
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked += 1
      const question = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [question]: 'Allow' } } }
    })
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    // the patrol subagent's own call: e.agentId set, so the hook refuses it outright, no dialog
    const fromPatrol = await $.tool.call({
      tool: 'Bash',
      command: '/repo/bin/factory decide r1 ship "looks good"',
      agentId: 'patrol-1',
    } as never)
    expect(fromPatrol.deny).toContain('did not confirm')
    expect(fromPatrol.deny).toContain('A patrol never decides this')
    expect(asked).toBe(0)
    expect(ran).toBe(0)

    // a non-gated command from the same subagent runs normally, with no dialog either
    const patrolMail = await $.tool.call({
      tool: 'Bash',
      command: '/repo/bin/factory mail r1 implement "answered"',
      agentId: 'patrol-1',
    } as never)
    expect(patrolMail.deny).toBeUndefined()
    expect(asked).toBe(0)
    expect(ran).toBe(1)

    // the main chat's own identical gated call: still gets the dialog, same as before this change
    const fromMain = await $.tool.call({
      tool: 'Bash',
      command: '/repo/bin/factory decide r1 ship "looks good"',
    } as never)
    expect(fromMain.deny).toBeUndefined()
    expect(asked).toBe(1)
    expect(ran).toBe(2)
    await clock.settle()
  },
)

test(
  'a run the main chat touched is held out of the next patrol; its mail stays queued until the hold clears',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: { prompt: string }[] = []
    let queued: readonly unknown[] = [mail(1)]
    const runs = [
      RUN,
      { id: 'r2', rig: 'api', node: 'implement', sub: 'working', agent: 'blocked', since: 5 },
    ]
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
    on('ui.status', () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      if (e.argv.includes('tick')) {
        const out = JSON.stringify({ manager: queued, rigs: [], runs })
        queued = []
        return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    })
    on('agent.spawn', ($, e) => {
      spawns.push(e as never)
      return { model: 'sonnet' } as never
    })
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on(
      'tool.call',
      { tool: 'Bash' },
      () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never,
    )
    // claude-factory-72v.17: agent.spawn delivers no agentId here, so turn.complete's fallback
    // branch now needs isPatrolAgent to confirm 'patrol-6' before adopting it
    agentListMock(on, ['patrol-6'])

    // the main chat mails r1 directly: this touches r1, holding it out of the next patrol
    await $.tool.call({ tool: 'Bash', command: 'factory mail r1 implement "steer"' } as never)

    // r2's own new blocked state is real news on its own, so a patrol spawns even with r1 held
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.prompt).toMatch(/r1.*held/)
    expect(spawns[0]!.prompt).not.toContain('which DB?') // r1's own mail stays held, unreported

    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't6',
      agentId: 'patrol-6',
    } as never)

    // short of 5 min: r1's held mail is still the only news, so still no second patrol
    await clock.advance(4 * 60_000 + 55_000)
    expect(spawns).toHaveLength(1)

    // past 5 min: the hold clears, r1's held mail becomes news, and a fresh patrol carries it
    await clock.advance(10_000)
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!.prompt).toContain('which DB?')
    expect(spawns[1]!.prompt).not.toMatch(/r1.*held/)

    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't7',
      agentId: 'patrol-6',
    } as never)
  },
)

test(
  "the patrol's own turn.complete writes one patrol-log.jsonl line with its actions and toasts the report; a main-loop turn.complete writes nothing",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    const toasts: unknown[] = []
    let queued: readonly unknown[] = [mail(1)]
    homeMocks(
      on,
      () => queued,
      () => (queued = []),
      '/home/factory',
      files,
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('ui.toast', (_, e) => (toasts.push(e), { value: undefined }) as never)
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'patrol-1' }) as never)
    agentListMock(on, ['patrol-1'])
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on(
      'tool.call',
      { tool: 'Bash' },
      () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never,
    )

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    // the patrol's own non-gated action, recorded for the log (claude-factory-72v.4)
    await $.tool.call({
      tool: 'Bash',
      command: 'factory mail r1 implement "answered"',
      agentId: 'patrol-1',
    } as never)

    await $.turn.complete({
      answer: 'Mailed r1. Nothing needs you.',
      durationMs: 1234,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-1',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: 'claude-x',
      },
    } as never)

    expect(JSON.stringify(toasts)).toContain('Mailed r1')
    const log = (files.get('/home/factory/patrol-log.jsonl') ?? '').trim().split('\n').filter(Boolean)
    expect(log).toHaveLength(1)
    const entry = JSON.parse(log[0]!)
    expect(entry.reason).toBe('answer')
    expect(entry.durationMs).toBe(1234)
    expect(entry.tokens).toBe(150)
    expect(entry.actions).toEqual(['factory mail r1 implement "answered"'])
    expect(entry.report).toContain('Mailed r1')

    // the main loop's own turn.complete (no agentId, isPatrolling already false): writes nothing more
    await $.turn.complete({
      answer: 'a main-chat answer',
      durationMs: 10,
      isAborted: false,
      reason: 'answer',
      turnId: 't2',
    } as never)
    expect(
      (files.get('/home/factory/patrol-log.jsonl') ?? '').trim().split('\n').filter(Boolean),
    ).toHaveLength(1)
  },
)

test(
  'patrol-log.jsonl is capped at 50 lines; a fresh patrol carries the last 10 entries’ actions; /factory patrols prints them',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    const seeded = Array.from({ length: 50 }, (_, i) => ({
      at: i + 1,
      agentId: `patrol-seed-${i + 1}`,
      reason: 'answer',
      durationMs: 1,
      tokens: 1,
      actions: [`action-${i + 1}`],
      report: `report ${i + 1}`,
    }))
    files.set('/home/factory/patrol-log.jsonl', `${seeded.map(e => JSON.stringify(e)).join('\n')}\n`)
    const spawns: { prompt: string }[] = []
    let queued: readonly unknown[] = [mail(1)]
    homeMocks(
      on,
      () => queued,
      () => (queued = []),
      '/home/factory',
      files,
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('agent.spawn', ($, e) => {
      spawns.push(e as never)
      return { model: 'sonnet', agentId: 'patrol-51' } as never
    })
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on(
      'tool.call',
      { tool: 'Bash' },
      () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never,
    )
    // claude-factory-72v.17: agent.spawn delivers no agentId for a registered agent type in this
    // test kit, no matter what this mock answers (claude-factory-72v memory): turn.complete's
    // fallback branch needs isPatrolAgent to confirm 'patrol-51' before adopting it
    agentListMock(on, ['patrol-51'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    // the fresh subagent's prompt lists only the newest 10 seeded entries' actions
    expect(spawns).toHaveLength(1)
    for (let i = 41; i <= 50; i++) expect(spawns[0]!.prompt).toContain(`action-${i}`)
    expect(spawns[0]!.prompt).not.toContain('action-40')
    expect(spawns[0]!.prompt).not.toContain('action-1\n')

    // /factory patrols prints the newest 10 seeded reports, not the older ones
    const patrols = await $.command.run({ command: 'factory', args: 'patrols' } as never)
    expect((patrols as { text: string }).text).toContain('report 50')
    expect((patrols as { text: string }).text).not.toContain('report 40')

    // this patrol's own turn.complete appends a 51st entry; the file still holds only 50, oldest dropped
    await $.turn.complete({
      answer: 'report 51',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-51',
    } as never)
    const log = (files.get('/home/factory/patrol-log.jsonl') ?? '').trim().split('\n').filter(Boolean)
    expect(log).toHaveLength(50)
    const parsed = log.map(l => JSON.parse(l) as { at: number; report: string })
    expect(parsed[0]!.at).toBe(2) // the oldest seeded entry (at: 1) was dropped
    expect(parsed.at(-1)!.report).toBe('report 51') // the freshly appended entry, kept
  },
)

test(
  'the pane header and the band above the prompt say how long ago the last patrol ran',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    let queued: readonly unknown[] = [mail(1)]
    homeMocks(
      on,
      () => queued,
      () => (queued = []),
      '/home/factory',
      files,
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('ui.panes', () => ({ value: [] }) as never)
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'patrol-1' }) as never)
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on(
      'tool.call',
      { tool: 'Bash' },
      () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never,
    )
    // claude-factory-72v.17: agent.spawn delivers no agentId for a registered agent type in this
    // test kit, no matter what this mock answers (claude-factory-72v memory): turn.complete's
    // fallback branch needs isPatrolAgent to confirm 'patrol-1' before adopting it
    agentListMock(on, ['patrol-1'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-1',
    } as never)
    await clock.advance(3 * 60_000)

    const pane = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    expect(JSON.stringify(await pane.drawn())).toContain('patrol 3m ago')

    const band = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'AbovePrompt',
      requestId: 'factory',
      props: { bodyColumns: 100, hasSurvey: false } as never,
      viewport: { columns: 100, rows: 3 },
    })
    expect(JSON.stringify(await band.drawn())).toContain('patrol 3m ago')
  },
)

test(
  'a main-loop turn.complete while a patrol runs does not free it; only a fresh agentId does (claude-factory-72v.8)',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('agent.spawn', () => {
      spawns.push({})
      // no agentId delivered, as in this test kit (claude-factory-72v memory): rt.patrolId stays
      // undefined, the same gap a main-loop turn.complete must not be able to exploit
      return { model: 'sonnet' } as never
    })
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    // claude-factory-72v.17: the fallback branch (rt.patrolId unset) now also requires
    // isPatrolAgent to confirm 'patrol-8' before adopting it as this test's own patrol
    agentListMock(on, ['patrol-8'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(spawns).toHaveLength(1)

    // a main-loop turn carries no agentId at all: it must not free the running patrol
    await $.turn.complete({
      answer: 'a main-chat answer',
      durationMs: 5,
      isAborted: false,
      reason: 'answer',
      turnId: 'm1',
    } as never)
    queued = [mail(2)]
    await clock.advance(5_000)
    expect(spawns).toHaveLength(1) // still running: no second spawn

    // the real patrol's own turn, a fresh (never-seen) agentId, does free it
    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-8',
    } as never)
    await clock.advance(5_000)
    expect(spawns).toHaveLength(2)

    await $.turn.complete({
      answer: 'done',
      durationMs: 500,
      isAborted: false,
      reason: 'answer',
      turnId: 't2',
      agentId: 'patrol-8',
    } as never)
  },
)

test(
  "an unrelated subagent's own turn.complete, ending first with a never-seen agentId, does not free the patrol or get logged as its report (claude-factory-72v.17)",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    const status: unknown[] = []
    let queued: readonly unknown[] = [mail(1)]
    homeMocks(
      on,
      () => queued,
      () => (queued = []),
      '/home/factory',
      files,
    )
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    // agent.spawn delivers no agentId, as in this test kit (claude-factory-72v memory): rt.patrolId
    // stays undefined, the same gap the fallback branch's isPatrolAgent check must close
    on('agent.spawn', () => ({ model: 'sonnet' }) as never)
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    // agent.list names only 'patrol-X' as the running factory:patrol agent: 'other-2' is some
    // other subagent entirely, one isPatrolAgent must refuse to adopt
    agentListMock(on, ['patrol-X'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    // an unrelated subagent's own turn ends first, with a never-seen agentId
    await $.turn.complete({
      answer: 'from the other subagent',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 'o1',
      agentId: 'other-2',
    } as never)
    expect(files.get('/home/factory/patrol-log.jsonl')).toBeUndefined()
    expect(JSON.stringify(status)).not.toContain('other subagent')

    // the real patrol's own turn, confirmed by agent.list, still frees it and is logged
    await $.turn.complete({
      answer: 'from the real patrol',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-X',
    } as never)
    const log = (files.get('/home/factory/patrol-log.jsonl') ?? '').trim().split('\n').filter(Boolean)
    expect(log).toHaveLength(1)
    expect(JSON.parse(log[0]!).report).toBe('from the real patrol')
  },
)

test(
  "a second, unrelated subagent's own Bash commands never land in the patrol log or move rt.patrolId (claude-factory-72v.9)",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    let queued: readonly unknown[] = [mail(1)]
    homeMocks(
      on,
      () => queued,
      () => (queued = []),
      '/home/factory',
      files,
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    // the real patrol's own id comes back from agent.spawn directly, as in a real session
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'patrol-A' }) as never)
    // agent.list says 'patrol-A' is the factory:patrol agent, but has no entry for 'other-1' at
    // all: isPatrolAgent (claude-factory-72v.9) must read that as "not the patrol", not adopt it
    // by the old "first Bash call wins" guess, even though 'other-1' calls Bash first below
    agentListMock(on, ['patrol-A'])
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on(
      'tool.call',
      { tool: 'Bash' },
      () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never,
    )

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    // a second, unrelated subagent's own Bash call, before the real patrol's first one
    await $.tool.call({
      tool: 'Bash',
      command: 'factory mail r1 implement "from the other agent"',
      agentId: 'other-1',
    } as never)
    // the real patrol's own command
    await $.tool.call({
      tool: 'Bash',
      command: 'factory mail r1 implement "from the patrol"',
      agentId: 'patrol-A',
    } as never)

    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-A',
    } as never)

    const log = (files.get('/home/factory/patrol-log.jsonl') ?? '').trim().split('\n').filter(Boolean)
    expect(log).toHaveLength(1)
    const entry = JSON.parse(log[0]!)
    expect(entry.actions).toEqual(['factory mail r1 implement "from the patrol"'])
  },
)

test(
  'a denied heartbeat (a long-working run, no mail) still retries after the window, not left sig-silent for up to an hour (claude-factory-72v.10)',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    const status: unknown[] = []
    const runs = [{ id: 'r1', rig: 'api', node: 'implement', sub: 'working', goal: 'g' }]
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    on('process.run', ($, e) => {
      if (e.argv.includes('tick'))
        return {
          value: {
            exitCode: 0,
            stdout: JSON.stringify({ manager: [], rigs: [], runs }),
            stderr: '',
          } as never,
        }
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    })
    on('agent.spawn', ($, e) => {
      spawns.push(e as never)
      return { deny: 'not now' } as never
    })
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    // the first ever heartbeat (a long-working run, due at 10 min), denied
    await clock.advance(10 * 60_000)
    expect(spawns).toHaveLength(1)
    expect(JSON.stringify(status)).toContain('the patrol spawn was denied')

    // past the 60 s retry window, with nothing else changed: the board's own sig was never
    // committed by the denied attempt, so this heartbeat is still due, and retries
    await clock.advance(61_000)
    expect(spawns).toHaveLength(2)
  },
)

test(
  'a patrol-log write failure is shown in the status line, not left to break turn.complete (claude-factory-72v.11)',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const status: unknown[] = []
    let queued: readonly unknown[] = [mail(1)]
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    on('ui.open', () => ({ value: undefined }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    on('process.run', ($, e) => {
      if (e.argv.includes('tick')) {
        const out = JSON.stringify({ manager: queued, rigs: [], runs: [RUN] })
        queued = []
        return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
      }
      if (e.argv.includes('home'))
        return { value: { exitCode: 0, stdout: '/home/factory', stderr: '' } as never }
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    })
    on('fs.read', () => {
      throw new Error("ENOENT: no such file, open 'patrol-log.jsonl'")
    })
    on('fs.write', () => {
      throw new Error('ENOSPC: no space left on device')
    })
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'patrol-11' }) as never)
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    // the base implementation beneath register.tsx's own turn.complete hook, or next(e) throws
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    // claude-factory-72v.17: agent.spawn delivers no agentId for a registered agent type in this
    // test kit, no matter what this mock answers (claude-factory-72v memory): the turn.complete
    // call below needs isPatrolAgent to confirm 'patrol-11' before adopting it
    agentListMock(on, ['patrol-11'])

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-11',
    } as never)

    expect(JSON.stringify(status)).toContain('failed to write the patrol log')
  },
)

test(
  "[SECURITY] the patrol's own command on a run the person just touched is denied too, not only left off its prompt (claude-factory-72v.14); a different, non-patrol subagent is not held (claude-factory-72v.16)",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    let ran = 0
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', () => ({ value: undefined }) as never)
    // agent.spawn delivers no agentId for a registered agent type in this test kit, no matter
    // what this mock answers (claude-factory-72v memory): the patrol's own first Bash call below
    // learns rt.patrolId through the agentListMock-confirmed adoption path instead
    // (claude-factory-72v.9), the only way the hold and the gated-command deny can tell the
    // patrol apart from any other subagent's own agentId.
    on('agent.spawn', () => ({ model: 'sonnet' }) as never)
    agentListMock(on, ['patrol-14'])
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(ran).toBe(0) // agent.spawn alone runs no Bash call

    // the main chat touches r9 directly: this holds it for PATROL_HOLD_MS
    await $.tool.call({ tool: 'Bash', command: 'factory mail r9 implement "steer"' } as never)
    expect(ran).toBe(1)

    // the patrol's own command naming that same, still-held run is denied, with no dialog
    const denied = await $.tool.call({
      tool: 'Bash',
      command: 'factory poke r9',
      agentId: 'patrol-14',
    } as never)
    expect(denied.deny).toContain('touched by the person')
    expect(ran).toBe(1) // not run

    // claude-factory-72v.16: a different, non-patrol subagent (one the person started themselves,
    // e.g. via the manager's own Agent tool) on that same held run must not be denied: the hold is
    // the patrol's own rule, not a rule for every subagent.
    const allowed = await $.tool.call({
      tool: 'Bash',
      command: 'factory poke r9',
      agentId: 'other-1',
    } as never)
    expect(allowed.deny).toBeUndefined()
    expect(ran).toBe(2) // ran this time

    // leave no patrol running, so a later test in this file is not blocked by it
    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-14',
    } as never)
    await clock.settle()
  },
)

test(
  "[SECURITY] a subagent's Bash command is pinned with FACTORY_PATROL=1, a 2nd CLI-side layer behind the regex deny; the main chat's own command carries no such var (claude-factory-72v.19)",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const commands: string[] = []
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('agent.spawn', () => ({ model: 'sonnet' }) as never)
    agentListMock(on, ['patrol-19'])
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      commands.push(e.command)
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    await $.tool.call({
      tool: 'Bash',
      command: 'factory mail r20 implement "ok"',
      agentId: 'patrol-19',
    } as never)
    expect(commands.at(-1)).toContain('export FACTORY_PATROL=1')

    await $.tool.call({ tool: 'Bash', command: 'factory mail r20 implement "ok"' } as never)
    expect(commands.at(-1)).not.toContain('FACTORY_PATROL')

    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-19',
    } as never)
    await clock.settle()
  },
)

test(
  "[SECURITY] a compound Bash command naming more than one run holds every target, and the patrol's own compound command is denied when any one of them is held (claude-factory-72v.20)",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    let ran = 0
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('agent.spawn', () => ({ model: 'sonnet' }) as never)
    agentListMock(on, ['patrol-20'])
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()

    // the main chat's own compound command names two runs: both are held, not only the first
    await $.tool.call({
      tool: 'Bash',
      command: 'factory mail r21a implement "a" && factory mail r21b implement "b"',
    } as never)
    expect(ran).toBe(1)

    // a patrol's own compound command puts a benign target first and a held run second: denied
    const denied = await $.tool.call({
      tool: 'Bash',
      command: 'factory poke r21c && factory poke r21b',
      agentId: 'patrol-20',
    } as never)
    expect(denied.deny).toContain('r21b')
    expect(denied.deny).toContain('touched by the person')
    expect(ran).toBe(1) // not run

    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-20',
    } as never)
    await clock.settle()
  },
)

test(
  "[SECURITY] a patrol the watchdog freed, still running late, is held off a run the next patrol's own hold covers too (claude-factory-72v.21)",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    let ran = 0
    let queued: readonly unknown[] = [mail(1)]
    baseMocks(
      on,
      () => queued,
      () => (queued = []),
    )
    on('ui.status', () => ({ value: undefined }) as never)
    on('agent.spawn', () => ({ model: 'sonnet' }) as never)
    // both the old, watchdog-freed patrol and the fresh one it was replaced by are real patrols
    agentListMock(on, ['patrol-21-old', 'patrol-21-new'])
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    // the old patrol starts and calls Bash once, adopting rt.patrolId
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.tool.call({ tool: 'Bash', command: 'factory status', agentId: 'patrol-21-old' } as never)
    expect(ran).toBe(1)

    // the watchdog frees it past 15 minutes, with no turn.complete: it is still running late
    await clock.advance(16 * 60_000)
    queued = [mail(2)]
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    // the new patrol calls Bash once too, adopting rt.patrolId as its own
    await $.tool.call({ tool: 'Bash', command: 'factory status', agentId: 'patrol-21-new' } as never)
    expect(ran).toBe(2)

    // the main chat touches r22 directly: this holds it for PATROL_HOLD_MS
    await $.tool.call({ tool: 'Bash', command: 'factory mail r22 implement "steer"' } as never)
    expect(ran).toBe(3)

    // the old, freed-but-still-running patrol's late command on that same held run is denied too,
    // even though rt.patrolId now names the new patrol, not this one
    const denied = await $.tool.call({
      tool: 'Bash',
      command: 'factory poke r22',
      agentId: 'patrol-21-old',
    } as never)
    expect(denied.deny).toContain('touched by the person')
    expect(ran).toBe(3) // not run

    // leave no patrol running, so a later test in this file is not blocked by it
    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-21-new',
    } as never)
    await clock.settle()
  },
)

test(
  'patrolNow reads <home>/plan.json and carries a fresh plan into the prompt; a corrupt plan.json reads as none, the same as a missing one (claude-factory-dun.4)',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    const spawns: { prompt: string }[] = []
    // a long-working run, no mail: the 10-minute heartbeat alone fires the first patrol, with no
    // news to carry, so that spawn proves the Plan section on its own
    const working = [{ id: 'r1', rig: 'api', node: 'implement', sub: 'working', goal: 'g' }]
    let queued: readonly unknown[] = []
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    on('ui.open', () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      if (e.argv.includes('tick')) {
        const out = JSON.stringify({ manager: queued, rigs: [], runs: working })
        queued = []
        return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
      }
      if (e.argv.includes('home'))
        return { value: { exitCode: 0, stdout: '/home/factory', stderr: '' } as never }
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
    on('ui.status', () => ({ value: undefined }) as never)
    on('ui.toast', () => ({ value: undefined }) as never)
    on('agent.spawn', ($, e) => {
      spawns.push(e as never)
      return { model: 'sonnet', agentId: `patrol-${spawns.length}` } as never
    })
    agentListMock(on, ['patrol-1', 'patrol-2'])
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    files.set(
      '/home/factory/plan.json',
      JSON.stringify({
        at: 0, // the mock clock starts at 0
        rigs: {
          api: {
            items: [{ id: 'api-1', title: 'fix it', priority: 1, why: 'blocks release' }],
            findings: [],
          },
        },
        proposals: [],
      }),
    )
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(spawns).toHaveLength(0) // not yet due: no mail, and the 10-minute heartbeat has not elapsed
    // the first heartbeat (a long-working run, no mail): the plan is now 10 min old, still fresh
    await clock.advance(10 * 60_000)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.prompt).toContain('Plan (from the pm, 10m old)')
    expect(spawns[0]!.prompt).toContain('api-1 (P1) blocks release')
    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't1',
      agentId: 'patrol-1',
    } as never)

    // a corrupt plan.json: register.tsx's own JSON.parse catch reads it as no plan at all, the
    // same as a missing file. New mail (not a repeat heartbeat) drives the next patrol, so this
    // does not depend on the heartbeat's own repeat-sig dedupe.
    files.set('/home/factory/plan.json', 'not json')
    queued = [mail(2)]
    await clock.advance(5_000)
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!.prompt).not.toContain('Plan (from the pm,')

    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 't2',
      agentId: 'patrol-2',
    } as never)
  },
)
