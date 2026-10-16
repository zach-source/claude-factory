import { expect, mock, test } from 'claude-code/testing'

// raises the kit's 5000ms default: under high shared-host load the first `$` call in each of
// this file's tests (the plugin's own startup) can outlast 5000ms (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

// a run parked on the person, its worker's question and options in its blocked report
const TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [
    {
      id: 'r1',
      rig: 'api',
      node: 'triage',
      sub: 'waiting',
      goal: 'g',
      last: {
        node: 'triage',
        attempt: 1,
        outcome: 'blocked',
        summary: 'Two specs disagree.\nQuestion: Which spec wins?\nOptions: the ADR | the bead',
        at: 1,
      },
    },
  ],
}

test(
  'the interview tab asks a parked run its question and mails the chosen answer to its station',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[][] = []
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      ran.push([...e.argv])
      return {
        value: {
          exitCode: 0,
          stdout: e.argv.includes('tick') ? JSON.stringify(TICK) : '',
          stderr: '',
        } as never,
      }
    })
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'interview' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('r1: Which spec wins?') // the title: run id and the plain-words decision
    expect(drawn).toContain('Two specs disagree.') // the one-line context
    expect(drawn).toContain('questions (1)')
    // the collapsed row never shows the raw Question:/Options: text; the details toggle does
    expect(drawn).not.toContain('Options: the ADR | the bead')
    expect(drawn).toContain('details ▸')
    await ui.press({ key: 'iv-details-iv:r1@1' })
    await clock.settle()
    const opened = JSON.stringify(await ui.drawn())
    expect(opened).toContain('details ▾')
    expect(opened).toContain('Options: the ADR | the bead')
    await ui.press({ key: 'iv-details-iv:r1@1' }) // closes again
    await clock.settle()
    expect(JSON.stringify(await ui.drawn())).not.toContain('Options: the ADR | the bead')

    await ui.press({ key: 'iv-opt-iv:r1@1-0' })
    await clock.settle()
    const mail = ran.find(a => a.includes('mail'))
    expect(mail?.slice(-3)).toEqual([
      'r1',
      'triage',
      'Answering "Which spec wins?": The person chose: the ADR.',
    ])
    expect(JSON.stringify(await ui.drawn())).toContain('answered (1)')
    await ui.unmount()
  },
)

// a run at a gate, open from the tick alone (no sweep needed); the sweep adds a rig's human-flagged bead
const GATE_TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [
    {
      id: 'r2',
      rig: 'web',
      node: 'release',
      sub: 'working',
      since: 20,
      gate: { question: 'Ship it?', outcomes: ['ship', 'hold'] } as
        { question: string; outcomes: string[] } | undefined,
      agent: undefined as string | undefined,
    },
  ],
}
const DECISIONS = {
  rigs: [
    {
      rig: 'api',
      factory: 'lifecycle',
      beads: [
        {
          id: 'api-7',
          title: 'Which DB?',
          description: 'Question: Which DB?\nOptions: postgres | mysql',
          kind: 'bead',
        },
      ],
    },
  ],
  proposals: {},
}

test(
  "'Interview me' sweeps bd into the open list; answering a bead calls decisions answer; a gate decides directly",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[][] = []
    // a decided gate's run really would come back from a live tick with no gate: the fake backend mirrors that
    let runs = GATE_TICK.runs
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      ran.push([...e.argv])
      if (e.argv.includes('decide')) {
        const [run, outcome] = e.argv.slice(e.argv.indexOf('decide') + 1)
        runs = runs.map(r => (r.id === run ? { ...r, gate: undefined, agent: `${outcome} decided` } : r))
      }
      const out = e.argv.includes('tick')
        ? JSON.stringify({ ...GATE_TICK, runs })
        : e.argv.includes('decisions') && e.argv.includes('answer')
          ? 'answered api-7'
          : e.argv.includes('decisions')
            ? JSON.stringify(DECISIONS)
            : ''
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    })
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'interview' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    // the gate alone, nothing swept yet
    expect(JSON.stringify(await ui.drawn())).toContain('questions (1)')

    await ui.press({ key: 'iv-sweep' })
    await clock.settle()
    expect(ran.some(a => a.includes('decisions') && !a.includes('answer'))).toBe(true)
    const swept = JSON.stringify(await ui.drawn())
    expect(swept).toContain('Which DB?')
    expect(swept).toContain('questions (2)')

    await ui.press({ key: 'iv-opt-bd:api:api-7-0' }) // 'postgres'
    await clock.settle()
    const answer = ran.filter(a => a.includes('decisions') && a.includes('answer')).at(-1)
    expect(answer?.slice(-5)).toEqual([
      'decisions',
      'answer',
      'api',
      'api-7',
      'Answering "Which DB?": The person chose: postgres.',
    ])
    const afterAnswer = JSON.stringify(await ui.drawn())
    expect(afterAnswer).toContain('answered (1)')
    expect(afterAnswer).toContain('questions (1)') // the bead is gone, the gate remains

    await ui.press({ key: 'decide-r2-ship' })
    await clock.settle()
    const decide = ran.filter(a => a.includes('decide')).at(-1)
    expect(decide?.slice(-3)).toEqual(['decide', 'r2', 'ship'])
    expect(JSON.stringify(await ui.drawn())).toContain('questions (0)') // the gate is decided and gone
    await ui.unmount()
  },
)

test(
  "the interview tab shows a rig's own bd error, and a failed sweep itself as a status line",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const status: unknown[] = []
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
    let decisionsOk = true
    on('process.run', ($, e) => {
      if (e.argv.includes('tick'))
        return {
          value: {
            exitCode: 0,
            stdout: JSON.stringify({ manager: [], rigs: [], runs: [] }),
            stderr: '',
          } as never,
        }
      if (e.argv.includes('decisions'))
        return decisionsOk
          ? {
              value: {
                exitCode: 0,
                stdout: JSON.stringify({
                  rigs: [{ rig: 'api', factory: 'lifecycle', beads: [], error: 'boom: bd ready failed' }],
                  proposals: {},
                }),
                stderr: '',
              } as never,
            }
          : { value: { exitCode: 1, stdout: '', stderr: 'bd: connection refused' } as never }
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    })
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'interview' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    await ui.press({ key: 'iv-sweep' })
    await clock.settle()
    expect(JSON.stringify(await ui.drawn())).toContain('boom: bd ready failed')

    decisionsOk = false
    await ui.press({ key: 'iv-sweep' })
    await clock.settle()
    expect(JSON.stringify(status)).toContain('factory decisions failed')
    await ui.unmount()
  },
)

// factory 'custom', not 'lifecycle' (the fallback `row?.factory ?? 'lifecycle'` in register.tsx falls back to):
// a test that expected 'lifecycle' here would pass even if the row's own factory were silently ignored
const OWNED_DECISIONS = {
  rigs: [
    {
      rig: 'api',
      factory: 'custom',
      beads: [{ id: 'api-9', title: 'A pilot bead', description: 'no shape here', kind: 'owned' }],
    },
  ],
  proposals: {},
}

test(
  "an owner-only bead's 'not now' only comments through decisions answer, never starts it",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[][] = []
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      ran.push([...e.argv])
      const out = e.argv.includes('tick')
        ? JSON.stringify({ manager: [], rigs: [], runs: [] })
        : e.argv.includes('decisions') && e.argv.includes('answer')
          ? 'answered api-9'
          : e.argv.includes('decisions')
            ? JSON.stringify(OWNED_DECISIONS)
            : ''
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    })
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'interview' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    await ui.press({ key: 'iv-sweep' })
    await clock.settle()
    expect(JSON.stringify(await ui.drawn())).toContain('A pilot bead')

    // 'not now': comments through decisions answer, never starts the bead
    await ui.press({ key: 'iv-opt-own:api:api-9-1' }) // 'not now'
    await clock.settle()
    expect(ran.some(a => a.includes('decisions') && a.includes('answer'))).toBe(true)
    expect(ran.some(a => a.includes('start'))).toBe(false)
    await ui.unmount()
  },
)

test(
  "an owner-only bead's 'start now' also runs factory start with the rig's factory",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[][] = []
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      ran.push([...e.argv])
      const out = e.argv.includes('tick')
        ? JSON.stringify({ manager: [], rigs: [], runs: [] })
        : e.argv.includes('decisions') && e.argv.includes('answer')
          ? 'answered api-9'
          : e.argv.includes('decisions')
            ? JSON.stringify(OWNED_DECISIONS)
            : e.argv.includes('start')
              ? 'started lifecycle-xyz'
              : ''
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    })
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'interview' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    await ui.press({ key: 'iv-sweep' })
    await clock.settle()
    await ui.press({ key: 'iv-opt-own:api:api-9-0' }) // 'start now'
    await clock.settle()
    const answer = ran.filter(a => a.includes('decisions') && a.includes('answer')).at(-1)
    expect(answer?.slice(-5)).toEqual([
      'decisions',
      'answer',
      'api',
      'api-9',
      'Answering "A pilot bead": The person chose: start now.',
    ])
    const start = ran.filter(a => a.includes('start')).at(-1)
    expect(start?.slice(-5)).toEqual(['start', 'custom', 'api', 'api-9', '--owned'])
    await ui.unmount()
  },
)

test(
  "an owner-only bead's 'start now' stays open when the start fails, instead of vanishing unstarted",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[][] = []
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      ran.push([...e.argv])
      if (e.argv.includes('start'))
        return { value: { exitCode: 1, stdout: '', stderr: 'no room on the rig' } as never }
      const out = e.argv.includes('tick')
        ? JSON.stringify({ manager: [], rigs: [], runs: [] })
        : e.argv.includes('decisions') && e.argv.includes('answer')
          ? 'answered api-9'
          : e.argv.includes('decisions')
            ? JSON.stringify(OWNED_DECISIONS)
            : ''
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    })
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'interview' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    await ui.press({ key: 'iv-sweep' })
    await clock.settle()
    await ui.press({ key: 'iv-opt-own:api:api-9-0' }) // 'start now'
    await clock.settle()
    // the comment was sent (the bead now knows the person's answer) but the failed start means the item is not
    // recorded as answered: it stays in the open list rather than silently vanishing while the bead never ran
    expect(ran.some(a => a.includes('decisions') && a.includes('answer'))).toBe(true)
    expect(ran.some(a => a.includes('start'))).toBe(true)
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('questions (1)')
    expect(drawn).not.toContain('answered (1)')
    await ui.unmount()
  },
)

// a stuck run with no Question:/Options: shape of its own: bare until the manager proposes options
const STUCK_TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [
    {
      id: 's1',
      rig: 'api',
      node: 'verify',
      sub: 'stuck',
      error: 'timed out, no shape to the error',
      since: 5,
    },
  ],
}
const DECISIONS_WITH_PROPOSAL = {
  rigs: [],
  proposals: {
    'iv:s1@5': { question: 'How should it go on?', options: ['retry it', 'escalate to the person'], at: 9 },
  },
}

test(
  "the sweep merges the manager's proposed options into a bare item already open from the tick",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      const out = e.argv.includes('tick')
        ? JSON.stringify(STUCK_TICK)
        : e.argv.includes('decisions')
          ? JSON.stringify(DECISIONS_WITH_PROPOSAL)
          : ''
      return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
    })
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'interview' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    // the stuck run is open from the tick alone, with no options of its own yet
    const before = JSON.stringify(await ui.drawn())
    expect(before).toContain('questions (1)')
    expect(before).not.toContain('retry it')

    await ui.press({ key: 'iv-sweep' })
    await clock.settle()
    const swept = JSON.stringify(await ui.drawn())
    expect(swept).toContain('retry it')
    expect(swept).toContain('escalate to the person')

    await ui.press({ key: 'iv-opt-iv:s1@5-0' }) // 'retry it'
    await clock.settle()
    expect(JSON.stringify(await ui.drawn())).toContain('answered (1)')
    await ui.unmount()
  },
)

// two runs parked on the same bead, from two different stations: mergeSame folds them into one open item
const SAME_BEAD_TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [
    {
      id: 'ra',
      bead: 'ama-1',
      rig: 'api',
      node: 'triage',
      sub: 'waiting',
      last: {
        node: 'triage',
        attempt: 1,
        outcome: 'blocked',
        summary: 'Two specs disagree.\nQuestion: Merge policy?\nOptions: pause merges | keep auto-merge',
        at: 1,
      },
    },
    {
      id: 'rb',
      bead: 'ama-1',
      rig: 'api',
      node: 'deploy',
      sub: 'waiting',
      last: {
        node: 'deploy',
        attempt: 1,
        outcome: 'blocked',
        summary: 'Still waiting.\nQuestion: Merge policy?\nOptions: pause merges | keep auto-merge',
        at: 5,
      },
    },
  ],
}

test(
  'two open items on the same bead become one row; answering it mails both stations and answers both',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const ran: string[][] = []
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      ran.push([...e.argv])
      return {
        value: {
          exitCode: 0,
          stdout: e.argv.includes('tick') ? JSON.stringify(SAME_BEAD_TICK) : '',
          stderr: '',
        } as never,
      }
    })
    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'interview' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    // two parked reports on one bead, folded into a single open row
    expect(JSON.stringify(await ui.drawn())).toContain('questions (1)')

    await ui.press({ key: 'iv-opt-iv:ra@1-0' }) // 'pause merges', the oldest (ra) report's key
    await clock.settle()
    const mails = ran.filter(a => a.includes('mail'))
    expect(mails).toHaveLength(2)
    expect(mails.map(a => a.slice(-3)[0])).toEqual(['ra', 'rb']) // one mail to each station
    expect(
      mails.every(a => a.slice(-1)[0] === 'Answering "Merge policy?": The person chose: pause merges.'),
    ).toBe(true)
    const after = JSON.stringify(await ui.drawn())
    expect(after).toContain('questions (0)') // the merged row is gone
    expect(after).toContain('answered (2)') // both members are recorded as answered
    await ui.unmount()
  },
)
