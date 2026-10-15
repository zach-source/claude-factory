import { expect, mock, test } from 'claude-code/testing'

// a live, stuck run: its detail has everything runDetail must draw (goal, follows line, an edge,
// a gate-free Steer row with retry since it's stuck, tasks, a journal entry, inbox and a pane)
const TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [
    {
      id: 'r1',
      rig: 'api',
      bead: 'api-7',
      node: 'implement',
      sub: 'stuck',
      since: 10,
      goal: 'ship the thing',
      pane: 'p1',
    },
  ],
}

const DETAIL = {
  id: 'r1',
  rig: 'api',
  bead: 'api-7',
  node: 'implement',
  sub: 'stuck',
  since: 10,
  goal: 'ship the thing',
  pane: 'p1',
  seq: 1,
  run: {
    id: 'r1',
    goal: 'ship the thing',
    bead: 'api-7',
    factory: 'lifecycle',
    branch: 'factory/r1',
    worktree: '/w/r1',
    repo: '/w/api',
  },
  log: [{ node: 'plan', attempt: 1, outcome: 'ready', summary: 'planned it', at: 1 }],
  inbox: [],
  start: 'plan',
  stations: [{ id: 'implement', gate: false, next: [{ outcome: 'ready', to: 'verify' }] }],
  tasks: [{ id: 'api-7.1', title: 'do the thing', status: 'open' }],
  isWorking: true,
}

function mountFake($: any, on: any, ran: string[][], answers: Record<string, unknown> = {}) {
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('process.run', ($: any, e: any) => {
    ran.push([...e.argv])
    if (e.argv.includes('tick'))
      return { value: { exitCode: 0, stdout: JSON.stringify(answers.tick ?? TICK), stderr: '' } as never }
    if (e.argv.includes('show'))
      return { value: { exitCode: 0, stdout: JSON.stringify(answers.show ?? DETAIL), stderr: '' } as never }
    if (e.argv.includes('pane') && e.argv.includes('read'))
      return { value: { exitCode: 0, stdout: (answers.peek as string) ?? 'last pane line', stderr: '' } as never }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  return clock
}

async function mountUi($: any, bodyColumns = 100) {
  return $.ui.mount({
    plugin: 'factory',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'factory',
    props: { bodyColumns, placement: 'dock' } as never,
    viewport: { columns: bodyColumns, rows: 60 },
  })
}

test('open expands a card in place with the full run detail; close collapses it back (A2/A3)', async ($, on) => {
  const ran: string[][] = []
  const clock = mountFake($, on, ran)
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
  const ui = await mountUi($)

  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"key":"open-r1"')
  expect(drawn).not.toContain('"key":"close-r1"')

  await ui.press({ key: 'open-r1' })
  await clock.settle()
  // A2: pressing open fetched both the run's detail and its worker's pane
  expect(ran.some(a => a.includes('show') && a.includes('r1'))).toBe(true)
  expect(ran.some(a => a.includes('pane') && a.includes('read'))).toBe(true)

  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('ship the thing') // the full goal
  expect(drawn).toContain('branch')
  expect(drawn).toContain('factory/r1')
  expect(drawn).toContain('ready → verify') // the "from <station>:" edge
  expect(drawn).toContain('Steer')
  expect(drawn).toContain('Tasks')
  expect(drawn).toContain('api-7.1')
  expect(drawn).toContain('Journal')
  expect(drawn).toContain('planned it')
  expect(drawn).toContain('Worker')
  expect(drawn).toContain('last pane line')
  expect(drawn).toContain('"key":"close-r1"')
  expect(drawn).not.toContain('"key":"open-r1"')

  // A3: close collapses the card and only one card is open at a time
  await ui.press({ key: 'close-r1' })
  await clock.settle()
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"key":"open-r1"')
  expect(drawn).not.toContain('"key":"close-r1"')
  expect(drawn).not.toContain('Steer')
  await ui.unmount()
})

test('the opened card runs goto, fork, retry, abort and mail with the run id and station (A2 Steer)', async ($, on) => {
  const ran: string[][] = []
  const clock = mountFake($, on, ran)
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
  const ui = await mountUi($)

  await ui.press({ key: 'open-r1' })
  await clock.settle()

  await ui.input({ key: 'mail-r1', text: 'please look at the error' })
  await clock.settle()
  const mail = ran.find(a => a.includes('mail'))
  expect(mail?.slice(-3)).toEqual(['r1', 'implement', 'please look at the error'])

  await ui.press({ key: 'goto-r1' })
  await clock.settle()
  const goto = ran.find(a => a.includes('goto'))
  expect(goto?.slice(-2)).toEqual(['r1', 'implement'])

  await ui.press({ key: 'fork-r1' })
  await clock.settle()
  const fork = ran.find(a => a.includes('fork'))
  expect(fork?.slice(-2)).toEqual(['r1', 'implement'])

  await ui.press({ key: 'retry-r1' })
  await clock.settle()
  const retry = ran.find(a => a.includes('retry'))
  expect(retry?.slice(-2)).toEqual(['retry', 'r1'])

  await ui.press({ key: 'jumpto-r1' })
  await clock.settle()

  await ui.press({ key: 'kill-r1' })
  await clock.settle()
  const abort = ran.find(a => a.includes('abort'))
  expect(abort?.slice(-2)).toEqual(['abort', 'r1'])
  await ui.unmount()
})

test('`/factory run <id>` still opens the board with that run expanded (A6)', async ($, on) => {
  const ran: string[][] = []
  const clock = mountFake($, on, ran)
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'run r1' } as never)
  await clock.settle()
  expect(ran.some(a => a.includes('show') && a.includes('r1'))).toBe(true)
  const ui = await mountUi($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('"key":"tab-run"')
  expect(drawn).toContain('"key":"close-r1"')
  expect(drawn).toContain('ship the thing')
  await ui.unmount()
})

const DONE_TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [{ id: 'r2', rig: 'api', node: 'done', last: { node: 'release', attempt: 1, outcome: 'shipped', summary: 'it shipped', at: 5 } }],
}
const DONE_DETAIL = {
  id: 'r2',
  rig: 'api',
  node: 'done',
  seq: 1,
  run: { id: 'r2', goal: 'ship another thing', factory: 'lifecycle', branch: 'factory/r2', worktree: '/w/r2', repo: '/w/api' },
  log: [{ node: 'release', attempt: 1, outcome: 'shipped', summary: 'it shipped', at: 5 }],
  inbox: [],
  start: 'plan',
  stations: [{ id: 'release', gate: false, next: [] }],
  tasks: null,
  isWorking: false,
}

test('a selected finished run stays open above the Finished rule even while the finished list is hidden (A5)', async ($, on) => {
  const ran: string[][] = []
  const clock = mountFake($, on, ran, { tick: DONE_TICK, show: DONE_DETAIL, peek: '' })
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'run r2' } as never)
  await clock.settle()
  const ui = await mountUi($)
  const drawn = JSON.stringify(await ui.drawn())
  // the finished list itself is still collapsed (isFinishedShown defaults to false)...
  expect(drawn).toContain('Finished')
  expect(drawn).not.toContain('"key":"view-r2"')
  // ...yet the selected finished run is drawn open
  expect(drawn).toContain('"key":"close-r2"')
  expect(drawn).toContain('ship another thing')
  await ui.unmount()
})

test('a selected run with no detail yet shows loading, not a crash (A5)', async ($, on) => {
  const ran: string[][] = []
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('process.run', ($: any, e: any) => {
    ran.push([...e.argv])
    if (e.argv.includes('tick')) return { value: { exitCode: 0, stdout: JSON.stringify(TICK), stderr: '' } as never }
    // `show` never answers: the detail stays null, as right after pressing open
    if (e.argv.includes('show')) return { value: { exitCode: 1, stdout: '', stderr: 'not ready' } as never }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'run r1' } as never)
  await clock.settle()
  const ui = await mountUi($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('loading…')
  expect(drawn).toContain('"key":"close-r1"')
  await ui.unmount()
})

test('the opened card fits inside its border at 40 columns (A7)', async ($, on) => {
  const ran: string[][] = []
  const clock = mountFake($, on, ran)
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
  const ui = await mountUi($, 40)
  await ui.press({ key: 'open-r1' })
  await clock.settle()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Steer')
  expect(drawn).toContain('Worker')
  await ui.unmount()
})
