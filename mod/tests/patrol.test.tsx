import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// raises the kit's 5000ms default: under high shared-host load the first `$` call in each of
// this file's tests (the plugin's own startup) can outlast 5000ms (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

const RUN = { id: 'r1', rig: 'api', node: 'implement', sub: 'waiting', goal: 'g' }
const mail = (at: number) => ({ run: 'r1', from: 'implement', text: 'blocked: which DB?', at })

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
    // real id, since agent.spawn's resolved value never carries one back in a mod test
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
