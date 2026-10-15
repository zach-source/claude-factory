import { expect, mock, test } from 'claude-code/testing'
import { blockers, progress, tiers, toggled } from '../hooks/view'

const BEADS = [
  { id: 'a-1', title: 'big work', priority: 1, type: 'epic' },
  { id: 'a-2', title: 'crash', priority: 0, type: 'bug' },
  { id: 'a-1.1', title: 'first step', priority: 3, type: 'task', parent: 'a-1' },
  { id: 'a-1.2', title: 'a bug in the plan', priority: 2, type: 'bug', parent: 'a-1' },
  { id: 'a-3', title: 'unsorted', type: 'chore' },
  { id: 'a-4', title: 'orphan child', priority: 2, type: 'task', parent: 'gone' },
]

test('tiers order by priority, nest children under their parent and keep orphans at their own tier', () => {
  const t = tiers(BEADS)
  expect(t.tiers.map(g => g.tier)).toEqual(['P0', 'P1', 'P2', 'no priority'])
  expect(t.tiers[1]!.rows.map(r => [r.bead.id, r.depth])).toEqual([
    ['a-1', 0],
    ['a-1.1', 1],
    ['a-1.2', 1],
  ])
  expect(t.tiers[2]!.rows.map(r => r.bead.id)).toEqual(['a-4'])
})

test('children are drawn only under an open parent, with a connector, the last one closing the branch', () => {
  const rows = (open: string[]) =>
    tiers(BEADS, 'all', Infinity, new Set(open)).tiers.flatMap(g =>
      g.rows.map(r => [r.bead.id, r.connector, r.kids, r.isOpen]),
    )
  expect(rows([]).filter(r => r[0] === 'a-1')).toEqual([['a-1', '', 2, false]])
  expect(rows([]).map(r => r[0])).not.toContain('a-1.1')
  expect(rows(['a-1']).filter(r => String(r[0]).startsWith('a-1'))).toEqual([
    ['a-1', '', 2, true],
    ['a-1.1', '  ├─ ', 0, false],
    ['a-1.2', '  └─ ', 0, false],
  ])
})

test('a collapsed family is one row against the limit, and the families left out are counted', () => {
  const t = tiers(BEADS, 'all', 1, new Set())
  expect([t.drawn, t.more]).toEqual([1, 3])
})

test('progress, blockers and toggling read plainly', () => {
  expect(progress({ id: 'a', title: 't', children: { done: 2, total: 4 } })).toBe('[2/4]')
  expect(progress({ id: 'a', title: 't' })).toBe('')
  expect(blockers({ id: 'a', title: 't', blockedBy: ['a-9'] })).toBe('⛔ a-9')
  expect(blockers({ id: 'a', title: 't', blockedBy: ['a-9', 'a-8', 'a-7'] })).toBe('⛔ a-9 +2')
  expect(blockers({ id: 'a', title: 't', blockedBy: [] })).toBe('')
  expect(toggled(undefined, 'a')).toEqual(['a'])
  expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
})

test('a type filter keeps its beads, an epic with its children, and a child alone at its own tier', () => {
  expect(tiers(BEADS, 'epic').tiers.flatMap(g => g.rows.map(r => r.bead.id))).toEqual([
    'a-1',
    'a-1.1',
    'a-1.2',
  ])
  const bugs = tiers(BEADS, 'bug')
  expect(bugs.total).toBe(2)
  expect(bugs.tiers.map(g => [g.tier, g.rows.map(r => [r.bead.id, r.depth])])).toEqual([
    ['P0', [['a-2', 0]]],
    ['P2', [['a-1.2', 0]]],
  ])
})

test('the row limit counts a parent with its children and never splits them', () => {
  expect(tiers(BEADS, 'all', 1).drawn).toBe(1)
  expect(tiers(BEADS, 'all', 2).drawn).toBe(4)
})

test('the backlog tab draws the picked type with a child nested under its parent', async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  const out = (argv: readonly string[]) =>
    argv.includes('tick')
      ? { manager: [], rigs: [], runs: [] }
      : argv.includes('backlog')
        ? [
            {
              name: 'api',
              repo: '/w/api',
              factory: 'lifecycle',
              busy: 1,
              maxRuns: 2,
              goal: 'ship it',
              queued: [],
              unqueued: BEADS.map(b => (b.id === 'a-1' ? { ...b, children: { done: 1, total: 3 } } : b)),
            },
          ]
        : ''
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: JSON.stringify(out(e.argv)), stderr: '' } as never,
  }))
  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'backlog' } as never)
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'factory',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'factory',
    props: { bodyColumns: 100, placement: 'dock' } as never,
    viewport: { columns: 100, rows: 60 },
  })
  expect(JSON.stringify(await ui.drawn())).toContain('crash')
  await ui.press({ key: 'backlog-type-epic' })
  await clock.settle()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('big work')
  expect(drawn).not.toContain('crash')
  // one rule a rig, no goal; the parent says how far its children are and starts collapsed
  expect(drawn).toContain('busy 1/2')
  expect(drawn).toContain('0 queued')
  expect(drawn).toContain('[1/3]')
  expect(drawn).not.toContain('ship it')
  expect(drawn).not.toContain('first step')
  await ui.press({ key: 'toggle-a-1' })
  await clock.settle()
  const opened = JSON.stringify(await ui.drawn())
  expect(opened).toContain('first step')
  expect(opened).toContain('  ├─ a-1.1')
  expect(opened).toContain('  └─ a-1.2')
  await ui.unmount()
})
