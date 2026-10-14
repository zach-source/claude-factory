import { expect, mock, test } from 'claude-code/testing'

// what `factory prs` printed: the per-run PR records the console gets them, AC1's shape
const PR = (over: Partial<Record<string, unknown>> = {}) => ({
  url: 'https://github.com/acme/widget/pull/551',
  repo: 'acme/widget',
  number: 551,
  title: 'Add the thing',
  role: 'code',
  station: 'implement',
  state: 'MERGED',
  isDraft: false,
  reviewDecision: '',
  mergeStateStatus: '',
  checks: { pass: 0, fail: 0, pending: 0 },
  updatedAt: '2026-10-12T08:00:00.000Z',
  ...over,
})

const PRS = [
  {
    run: 'lifecycle-mv4y4yyjy4',
    rig: 'fabriek',
    bead: 'fab-bb1.1.7',
    node: 'implement',
    ended: false,
    at: 1,
    prs: [
      PR(),
      PR({
        url: 'https://github.com/acme/widget/pull/550',
        number: 550,
        title: 'An older sibling PR',
        role: 'mentioned',
        state: 'OPEN',
        isDraft: true,
      }),
    ],
  },
  {
    run: 'lifecycle-mv581ntbax',
    rig: 'infra-blocks',
    bead: 'infra-blocks-5nzp',
    node: 'done',
    ended: true,
    at: 2,
    prs: [
      PR({
        url: 'https://github.com/acme/widget-deploy/pull/2923',
        repo: 'acme/widget-deploy',
        number: 2923,
        title: 'Bypass application targets',
        role: 'code',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'REVIEW_REQUIRED',
        mergeStateStatus: 'CLEAN',
      }),
    ],
  },
]

// a second rig with more ended runs than the tab's 25-row cap, to prove the "+N earlier runs" line
const MANY_RIG = Array.from({ length: 30 }, (_, i) => ({
  run: `lifecycle-many${i}`,
  rig: 'many',
  bead: `many-${i}`,
  node: 'done',
  ended: true,
  at: 100 - i,
  prs: [PR({ url: `https://github.com/acme/widget/pull/${600 + i}`, number: 600 + i })],
}))

test('the PRs tab groups by rig then run, shows each PR with its state, role and checks, and "also named:" for mentions', async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  const BOARD = {
    manager: [],
    rigs: [],
    runs: [{ id: 'lifecycle-mv4y4yyjy4', rig: 'fabriek', node: 'implement', sub: 'working', goal: 'g' }],
  }
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('tick') ? JSON.stringify(BOARD) : e.argv.includes('prs') ? JSON.stringify(PRS) : '',
      stderr: '',
    } as never,
  }))
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  // the prs view throttles its gh-backed refresh to once a minute (register.tsx's rt.prsAt, module
  // state that can carry a later value over from an earlier test in this file); advance well past it
  await clock.advance(10_000_000)
  await $.command.run({ command: 'factory', args: 'prs' } as never)
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'factory',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'factory',
    props: { bodyColumns: 100, placement: 'dock' } as never,
    viewport: { columns: 100, rows: 60 },
  })
  const drawn = JSON.stringify(await ui.drawn())
  // run header: id, bead, and the live run's node button (the ended run shows "run ended" instead)
  expect(drawn).toContain('lifecycle-mv4y4yyjy4')
  expect(drawn).toContain('fab-bb1.1.7')
  expect(drawn).toContain('implement')
  expect(drawn).toContain('lifecycle-mv581ntbax')
  expect(drawn).toContain('infra-blocks-5nzp')
  expect(drawn).toContain('run ended')
  // own PRs: repo#number, state word, role, title
  expect(drawn).toContain('acme/widget')
  expect(drawn).toContain('551')
  expect(drawn).toContain('merged')
  expect(drawn).toContain('code')
  expect(drawn).toContain('Add the thing')
  expect(drawn).toContain('2923')
  expect(drawn).toContain('needs approval')
  // the mentioned PR (#550, draft) is on its own dim line, not among the "own" rows
  expect(drawn).toContain('also named:')
  expect(drawn).toContain('550')
  await ui.unmount()
})

test('the PRs tab lists live runs first, then at most 25 ended runs newest-first, then "+N earlier runs"', async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  const BOARD = { manager: [], rigs: [], runs: [] }
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('tick') ? JSON.stringify(BOARD) : e.argv.includes('prs') ? JSON.stringify(MANY_RIG) : '',
      stderr: '',
    } as never,
  }))
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await clock.advance(10_000_000)
  await $.command.run({ command: 'factory', args: 'prs' } as never)
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'factory',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'factory',
    props: { bodyColumns: 100, placement: 'dock' } as never,
    viewport: { columns: 100, rows: 60 },
  })
  const drawn = JSON.stringify(await ui.drawn())
  // 30 ended runs, cap 25: 5 hidden (JSX splits the interpolated count into its own string child)
  expect(drawn).toContain('"+","5"," earlier runs"')
  // the newest-first run (at:100, i=0) is shown; an older one past the cap (i=29, at:71) is not
  expect(drawn).toContain('lifecycle-many0')
  expect(drawn).not.toContain('lifecycle-many29')
  await ui.unmount()
})
