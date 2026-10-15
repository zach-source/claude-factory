import { expect, mock, test } from 'claude-code/testing'

import { mapView } from '../hooks/register'
import { byState, shortId } from '../hooks/view'

// raises the kit's 5000ms default: under high shared-host load the first `$` call in each of
// this file's tests (the plugin's own startup) can outlast 5000ms (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

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

test('open expands a card in place with the full run detail; close collapses it back (A2/A3)', SLOW, async ($, on) => {
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

test('the opened card runs goto, fork, retry, abort and mail with the run id and station (A2 Steer)', SLOW, async ($, on) => {
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
  expect(ran.some(a => a.join(',') === ['herdr', 'agent', 'focus', 'p1'].join(','))).toBe(true)

  await ui.press({ key: 'kill-r1' })
  await clock.settle()
  const abort = ran.find(a => a.includes('abort'))
  expect(abort?.slice(-2)).toEqual(['abort', 'r1'])
  await ui.unmount()
})

const TWO_LIVE_TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [
    { id: 'r1', rig: 'api', bead: 'api-7', node: 'implement', sub: 'stuck', since: 10, goal: 'ship the thing', pane: 'p1' },
    { id: 'r3', rig: 'api', bead: 'api-9', node: 'verify', sub: 'working', since: 10, goal: 'ship another thing', pane: 'p3' },
  ],
}
const DETAIL3 = {
  ...DETAIL,
  id: 'r3',
  bead: 'api-9',
  node: 'verify',
  sub: 'working',
  pane: 'p3',
  goal: 'ship another thing',
  run: { ...DETAIL.run, id: 'r3', goal: 'ship another thing', bead: 'api-9', branch: 'factory/r3', worktree: '/w/r3' },
  stations: [{ id: 'verify', gate: false, next: [{ outcome: 'green', to: 'release' }] }],
}

test('opening a second card closes the first: only one card is open at a time (A3)', SLOW, async ($, on) => {
  const ran: string[][] = []
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('process.run', ($: any, e: any) => {
    ran.push([...e.argv])
    if (e.argv.includes('tick')) return { value: { exitCode: 0, stdout: JSON.stringify(TWO_LIVE_TICK), stderr: '' } as never }
    if (e.argv.includes('show'))
      return {
        value: { exitCode: 0, stdout: JSON.stringify(e.argv.includes('r3') ? DETAIL3 : DETAIL), stderr: '' } as never,
      }
    if (e.argv.includes('pane') && e.argv.includes('read'))
      return { value: { exitCode: 0, stdout: 'last pane line', stderr: '' } as never }
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
  const ui = await mountUi($)

  await ui.press({ key: 'open-r1' })
  await clock.settle()
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"key":"close-r1"')
  expect(drawn).toContain('"key":"open-r3"')

  await ui.press({ key: 'open-r3' })
  await clock.settle()
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"key":"close-r3"')
  expect(drawn).toContain('"key":"open-r1"')
  expect(drawn).not.toContain('"key":"close-r1"')
  await ui.unmount()
})

test('`/factory run <id>` still opens the board with that run expanded (A6)', SLOW, async ($, on) => {
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

test('a selected finished run stays open above the Finished rule even while the finished list is hidden (A5)', SLOW, async ($, on) => {
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

test('a selected run with no detail yet shows loading, not a crash (A5)', SLOW, async ($, on) => {
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

test('the opened card fits inside its border at 40 columns (A7)', SLOW, async ($, on) => {
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
  // the card's border and padding take 4 columns off the 40-column body (p.width - 4 = 36); the
  // Steer rule's dash fill (no note) renders as its own Text node, "── Steer " (9 chars) plus
  // 36 - 9 = 27 dashes, not the unadjusted 40 - 9 = 31: a mutation dropping the -4 keeps every
  // other assertion in this test green, so check the dash count exactly and structurally
  expect(drawn).toContain(`"children":["${'─'.repeat(27)}"]`)
  expect(drawn).not.toMatch(/─{28,}/)
  await ui.unmount()
})

test("mapView maps a stored pre-fold 'run' to 'board', and passes every current view through unchanged (cr0.7)", async () => {
  // register.tsx's readView() (refresh's fetch gate) and its ui.render switch both call this one
  // helper instead of repeating the 'run' -> 'board' check: a console whose persisted view is
  // still the legacy 'run' (from before the fold) must refresh and render as 'board' either way
  expect(mapView('run')).toBe('board')
  for (const v of ['board', 'backlog', 'mail', 'rigs', 'prs', 'interview']) expect(mapView(v)).toBe(v)
})

// one live run in each state, and two working ones to order by age
const STATES_TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [
    { id: 'wnew', rig: 'api', bead: 'api-1', node: 'implement', sub: 'working', since: 50 },
    {
      id: 'g1',
      rig: 'api',
      bead: 'api-2',
      node: 'review',
      sub: 'gate',
      since: 5,
      gate: { question: 'ship?', outcomes: ['ship', 'hold'] },
    },
    {
      id: 'wold',
      rig: 'api',
      bead: 'api-3',
      node: 'verify',
      sub: 'working',
      since: 20,
      last: { node: 'plan', attempt: 1, outcome: 'ok', summary: 'CI pending', at: 1 },
    },
    {
      id: 's1',
      rig: 'api',
      bead: 'api-4',
      node: 'implement',
      sub: 'stuck',
      since: 10,
      quietMin: 40,
      error: 'pi stalled',
    },
    { id: 'z1', rig: 'api', bead: 'api-5', node: 'verify', sub: 'waiting', since: 30, wakeAt: 3_600_000 },
  ],
}

const lastDecide = (ran: string[][]) => ran.findLast(a => a.includes('decide'))?.slice(-3)

async function mountStates($: any, on: any, columns: number, ran: string[][] = []) {
  const clock = mountFake($, on, ran, { tick: STATES_TICK })
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
  return { clock, ui: await mountUi($, columns) }
}

test('wide, what awaits the person is a full-width band on top, then three columns by state, each oldest first (kanban)', SLOW, async ($, on) => {
  const ran: string[][] = []
  const { clock, ui } = await mountStates($, on, 140, ran)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('? AWAITING YOU')
  for (const t of ['! STUCK (1)', '● WORKING (2)', '◷ WAITING (1)']) expect(drawn).toContain(t)
  // the band above the columns, then the column order, and each run under its own state's column
  const at = (s: string) => drawn.indexOf(s)
  expect(at('"key":"lane-gates"')).toBeLessThan(at('"key":"lanes"'))
  expect(drawn).not.toContain('lane-head-gates')
  expect(at('lane-head-stuck')).toBeLessThan(at('lane-head-working'))
  expect(at('lane-head-working')).toBeLessThan(at('lane-head-waiting'))
  expect(at('tile-id-g1')).toBeLessThan(at('lane-head-stuck'))
  expect(at('tile-id-s1')).toBeGreaterThan(at('lane-head-stuck'))
  expect(at('tile-id-s1')).toBeLessThan(at('lane-head-working'))
  expect(at('tile-id-z1')).toBeGreaterThan(at('lane-head-waiting'))
  // working is oldest first
  expect(at('tile-id-wold')).toBeLessThan(at('tile-id-wnew'))
  // the compact facts: quiet time for stuck, the wake time for waiting, why per state
  expect(drawn).toContain('implement quiet 40m')
  expect(drawn).toContain('verify wakes ')
  expect(drawn).toContain('pi stalled')
  expect(drawn).toContain('CI pending')
  expect(drawn).toContain('"ship?"')
  // each tile says when its run last reported
  expect(drawn).toContain('reported ')
  // the gate still decides from the board
  await ui.press({ key: 'decide-g1-ship' })
  await clock.settle()
  expect(lastDecide(ran)).toEqual(['decide', 'g1', 'ship'])
  await ui.unmount()
})

test('wide, an empty column says none, no band shows with nothing awaiting, and an opened card shows below and shrinks with - (kanban)', SLOW, async ($, on) => {
  const ran: string[][] = []
  const clock = mountFake($, on, ran)
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
  const ui = await mountUi($, 140)
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('AWAITING YOU')
  expect(drawn).toContain('"none"')
  await ui.press({ key: 'open-r1' })
  await clock.settle()
  drawn = JSON.stringify(await ui.drawn())
  // the tile keeps its place without an open button; the full card, with close, follows the columns
  expect(drawn).toContain('"key":"tile-id-r1"')
  expect(drawn).not.toContain('"key":"open-r1"')
  expect(drawn.indexOf('"key":"close-r1"')).toBeGreaterThan(drawn.indexOf('lane-head-waiting'))
  expect(drawn).toContain('Steer')
  // the - at the card's top shrinks it back to its tile
  await ui.press({ key: 'shrink-r1' })
  await clock.settle()
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('"key":"close-r1"')
  expect(drawn).toContain('"key":"open-r1"')
  await ui.unmount()
})

test('narrow, the same groups stack as sections, empty ones omitted, and the open card replaces its tile (kanban)', SLOW, async ($, on) => {
  const ran: string[][] = []
  const { clock, ui } = await mountStates($, on, 90, ran)
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('lane-head-')
  expect(drawn).not.toContain('"none"')
  for (const t of ['? AWAITING YOU', '! STUCK', '● WORKING', '◷ WAITING']) expect(drawn).toContain(t)
  expect(drawn.indexOf('? AWAITING YOU')).toBeLessThan(drawn.indexOf('! STUCK'))
  expect(drawn.indexOf('! STUCK')).toBeLessThan(drawn.indexOf('● WORKING'))
  expect(drawn.indexOf('● WORKING')).toBeLessThan(drawn.indexOf('◷ WAITING'))
  await ui.press({ key: 'decide-g1-hold' })
  await clock.settle()
  expect(lastDecide(ran)).toEqual(['decide', 'g1', 'hold'])
  await ui.press({ key: 'open-s1' })
  await clock.settle()
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('"key":"tile-id-s1"')
  expect(drawn).toContain('"key":"close-s1"')
  await ui.unmount()
})

test('stacked, a state with no live run has no section (kanban)', SLOW, async ($, on) => {
  const ran: string[][] = []
  const clock = mountFake($, on, ran)
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
  const ui = await mountUi($, 90)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('! STUCK')
  expect(drawn).not.toContain('AWAITING YOU')
  expect(drawn).not.toContain('WORKING')
  await ui.unmount()
})

test('shortId keeps the end of the id that tells runs apart; byState splits live runs by stateOf, oldest first', () => {
  expect(shortId('lifecycle-mv4yabcdeyjy4')).toBe('mv4y…yjy4')
  expect(shortId('lifecycle-mv9moci211')).toBe('mv9m…i211')
  expect(shortId('r1')).toBe('r1')
  expect(shortId('lifecycle-r1')).toBe('r1')
  const runs = STATES_TICK.runs.concat([{ id: 'd', node: 'done' } as never])
  const split = byState(runs)
  expect(split.map(g => g.state)).toEqual(['gates', 'stuck', 'working', 'waiting'])
  expect(split.map(g => g.runs.map(r => r.id))).toEqual([['g1'], ['s1'], ['wold', 'wnew'], ['z1']])
})
