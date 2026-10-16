import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// raises the kit's 5000ms default: under high shared-host load the first `$` call in each of
// this file's tests (the plugin's own startup) can outlast 5000ms (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

// what `factory tick` printed: the rigs and their runs as the console gets them
const TICK = {
  manager: [],
  rigs: [
    { name: 'api', repo: '/w/api', factory: 'lifecycle', maxRuns: 5, goal: 'ship it' },
    { name: 'deploys', repo: '/w/deploys', factory: 'lifecycle', maxRuns: 1, sweeps: [] },
    { name: 'docs', repo: '/w/docs', factory: 'lifecycle' },
  ],
  runs: [
    { id: 'r1', rig: 'api', node: 'deploy', sub: 'working', goal: 'g' },
    { id: 'r2', rig: 'api', node: 'implement', sub: 'working', goal: 'g' },
    {
      id: 'r3',
      rig: 'api',
      node: 'approve',
      sub: 'waiting',
      gate: { question: 'q', outcomes: ['ship'] },
    },
    { id: 'r4', rig: 'deploys', node: 'triage', sub: 'stuck', goal: 'g' },
    // over its cap of 1: once drew nothing, the bar's empty part a negative repeat
    { id: 'r7', rig: 'deploys', node: 'implement', sub: 'working', goal: 'g' },
    { id: 'r5', rig: 'api', node: 'done', goal: 'g' },
    { id: 'r6', node: 'plan', sub: 'working', goal: 'g' },
  ],
}

test(
  'the rigs tab draws each rig with its live stations, gates and stuck runs, past its cap too',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
      on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => ({
      value: {
        exitCode: 0,
        stdout: e.argv.includes('tick') ? JSON.stringify(TICK) : '',
        stderr: '',
      } as never,
    }))
    await $.command.run({ command: 'factory', args: 'status' } as never) // any command ticks after it
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'rigs' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'factory',
        surface,
        component: 'Pane',
        requestId: 'factory',
        props: { bodyColumns: 100, placement: 'dock' } as never,
        viewport: { columns: 100, rows: 60 },
      })
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('api')
      expect(drawn).toContain('"deploy"," ","1"')
      expect(drawn).toContain('"stuck: ","r4"')
      await ui.unmount()
    }
  },
)

test('a tick that logs to stderr, as a reaped pane does, still parses', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  const status: unknown[] = []
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
  for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('tick') ? JSON.stringify(TICK) : '',
      stderr: '2026-10-14T17:00:00.000Z reaped pane w1:p2\n',
    } as never,
  }))
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  // one count for the status line, the header and the band: each run in one state, working ones by rig
  expect(JSON.stringify(status)).toContain(
    '4 working (api 2, deploys 1, no rig 1) · 1 awaiting you · 1 stuck',
  )
  expect(JSON.stringify(status)).not.toContain('SyntaxError')
})

test(
  'a failing tick says why in the status line and marks the board stale until one succeeds',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const status: unknown[] = []
    let isFailing = true
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    on('ui.status', (_, e) => (status.push(e), { value: undefined }) as never)
    for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
    on('process.run', ($, e) => {
      if (e.argv.includes('tick') && isFailing)
        return {
          value: {
            exitCode: 1,
            stdout: '',
            stderr: `dolt: ${'x'.repeat(90)} timed out after 120000 ms\n`,
          } as never,
        }
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
    const failed = JSON.stringify(status)
    expect(failed).toContain('factory tick failed: ')
    // past the old 80-character cut: the reason itself survives
    expect(failed).toContain('timed out after 120000 ms')
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    expect(JSON.stringify(await ui.drawn())).toContain('stale since')
    isFailing = false
    await clock.advance(5_000)
    await clock.settle()
    expect(JSON.stringify(await ui.drawn())).not.toContain('stale since')
    await ui.unmount()
  },
)

/** a `process.run` mock answering `factory tick` with `TICK`, `factory home` with `/home/acme`,
 * and anything else with empty stdout; paired with an `fs.read` backed by `files` (keyed by
 * path), so `<home>/plan.json` reads as a real file (claude-factory-dun.6). */
function planMocks(on: On, files: Map<string, string>, tick: unknown = TICK) {
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('tick') ? JSON.stringify(tick) : e.argv.includes('home') ? '/home/acme' : '',
      stderr: '',
    } as never,
  }))
  on('fs.read', ($, e) => {
    const path = (e as { path: string }).path
    if (!files.has(path)) throw new Error(`ENOENT: no such file, open '${path}'`)
    return { value: files.get(path)! } as never
  })
}

test(
  "the rigs tab draws the pm's plan: each rig's next-up items in order and its findings",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    planMocks(on, files)
    const start = 0
    files.set(
      '/home/acme/plan.json',
      JSON.stringify({
        at: start,
        rigs: {
          api: {
            items: [
              { id: 'api-1', title: 'ship the spec', priority: 1, why: 'blocks the rig goal' },
              { id: 'api-2', title: 'follow-up', priority: 2, why: 'unblocks api-1' },
            ],
            findings: [{ kind: 'starved-epic', rig: 'api', key: 'k1', text: 'api-epic: no progress in 30h' }],
          },
        },
        proposals: [],
      }),
    )

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'rigs' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('Next up:')
    expect(drawn).toContain('api-1 (P1) blocks the rig goal')
    expect(drawn).toContain('api-2 (P2) unblocks api-1')
    expect(drawn).toContain('api-epic: no progress in 30h')
    await ui.unmount()
  },
)

test(
  'the rigs tab draws a rig named like an Object.prototype member with no crash, even with a valid plan that never mentions it (claude-factory-dun.18)',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    // A plain `plan.rigs['constructor']` lookup on a JSON-parsed plain object resolves through
    // the prototype chain to `Object.prototype.constructor`, not `undefined`, when the plan
    // itself is otherwise well-shaped and never mentions this rig.
    const tick = {
      ...TICK,
      rigs: [{ name: 'constructor', repo: '/w/ctor', factory: 'lifecycle', maxRuns: 1, goal: 'ship it' }],
      runs: [],
    }
    planMocks(on, files, tick)
    files.set('/home/acme/plan.json', JSON.stringify({ at: 0, rigs: {}, proposals: [] }))

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'rigs' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('constructor')
    expect(drawn).not.toContain('Next up:')
    await ui.unmount()
  },
)

test(
  'the rigs tab draws a rig whose own plan entry is malshaped with no crash: the whole plan reads as absent (claude-factory-dun.18)',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    const tick = {
      ...TICK,
      rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle', maxRuns: 5, goal: 'ship it' }],
      runs: [],
    }
    planMocks(on, files, tick)
    // "api"'s own entry has no items/findings arrays: isValidPlan rejects the whole file.
    files.set('/home/acme/plan.json', JSON.stringify({ at: 0, rigs: { api: {} }, proposals: [] }))

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await $.command.run({ command: 'factory', args: 'rigs' } as never)
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('api')
    expect(drawn).not.toContain('Next up:')
    await ui.unmount()
  },
)

test(
  "the pane header and the band say how fresh the pm's plan is, and call it stale past 2 hours",
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const files = new Map<string, string>()
    planMocks(on, files)
    const start = 0
    files.set(
      '/home/acme/plan.json',
      JSON.stringify({
        at: start,
        rigs: { api: { items: [], findings: [{ kind: 'goal-no-beads', rig: 'api', key: 'k1', text: 'x' }] } },
        proposals: [],
      }),
    )

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(12 * 60_000)
    await clock.settle()

    const pane = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' } as never,
      viewport: { columns: 100, rows: 60 },
    })
    expect(JSON.stringify(await pane.drawn())).toContain('plan 12m ago · 1 finding')

    const band = await $.ui.mount({
      plugin: 'factory',
      surface: 'terminal',
      component: 'AbovePrompt',
      requestId: 'factory',
      props: { bodyColumns: 100, hasSurvey: false } as never,
      viewport: { columns: 100, rows: 3 },
    })
    expect(JSON.stringify(await band.drawn())).toContain('plan 12m ago · 1 finding')

    // 2h12m since plan.at: past PLAN_FRESH_MS, so both now call it stale instead
    await clock.advance(2 * 60 * 60_000)
    await clock.settle()
    expect(JSON.stringify(await pane.drawn())).toContain('plan stale')
    expect(JSON.stringify(await band.drawn())).toContain('plan stale')
    await pane.unmount()
    await band.unmount()
  },
)

test("a rig's backlog button opens the Backlog on that rig, and all rigs clears it", SLOW, async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  const rig = (name: string) => ({
    name,
    repo: `/w/${name}`,
    factory: 'lifecycle',
    busy: 0,
    queued: [],
    unqueued: [{ id: `${name}-1`, title: `work in ${name}`, priority: 2 }],
  })
  const out = (argv: readonly string[]) =>
    argv.includes('tick') ? TICK : argv.includes('backlog') ? ['api', 'deploys', 'docs'].map(rig) : ''
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: JSON.stringify(out(e.argv)), stderr: '' } as never,
  }))
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'rigs' } as never)
  const ui = await $.ui.mount({
    plugin: 'factory',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'factory',
    props: { bodyColumns: 100, placement: 'dock' } as never,
    viewport: { columns: 100, rows: 60 },
  })
  await ui.press({ key: 'rigs-backlog-deploys' })
  await clock.settle()
  const one = JSON.stringify(await ui.drawn())
  expect(one).toContain('work in deploys')
  expect(one).not.toContain('work in api')
  await ui.press({ key: 'backlog-all-rigs' })
  await clock.settle()
  const all = JSON.stringify(await ui.drawn())
  expect(all).toContain('work in deploys')
  expect(all).toContain('work in api')
  await ui.unmount()
})
