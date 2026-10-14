import { expect, mock, test } from 'claude-code/testing'
import { tiers } from '../hooks/view'

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
        ? [{ name: 'api', repo: '/w/api', factory: 'lifecycle', busy: 0, queued: [], unqueued: BEADS }]
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
  expect(drawn).toContain('first step')
  expect(drawn).not.toContain('crash')
  expect(drawn).toContain('"paddingLeft":2')
  await ui.unmount()
})
