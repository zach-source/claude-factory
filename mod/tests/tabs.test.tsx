import { expect, mock, test } from 'claude-code/testing'

// what `factory tick` printed: the rigs and their runs as the console gets them
const TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle', maxRuns: 5, goal: 'ship it' }],
  runs: [{ id: 'r1', rig: 'api', node: 'implement', sub: 'working', goal: 'g' }],
}

async function mountBoard($: any, on: any) {
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('process.run', ($: any, e: any) => ({
    value: { exitCode: 0, stdout: e.argv.includes('tick') ? JSON.stringify(TICK) : '', stderr: '' } as never,
  }))
  await $.command.run({ command: 'factory', args: 'status' } as never) // any command ticks after it
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
}

test('the tab bar is Board..Interview on contiguous hotkeys 1-6, with exactly those 6 tabs and no Run tab', async ($, on) => {
  await mountBoard($, on)
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
    expect(drawn).not.toContain('"key":"tab-new"')
    expect(drawn).not.toContain('"key":"tab-run"')
    for (const [label, key] of [
      ['Board', '1'],
      ['Backlog', '2'],
      ['Mail', '3'],
      ['Rigs', '4'],
      ['PRs', '5'],
      ['Interview', '6'],
    ])
      expect(drawn).toContain(`"label":"${label}","hotkey":"${key}"`)
    // exactly 6 tab buttons: Run folded into Board
    expect((drawn.match(/"key":"tab-/g) ?? []).length).toBe(6)
    expect(drawn).toContain('1-6 views')
    expect(drawn).not.toContain('1-7 views')
    await ui.unmount()
  }
})

test("the rigs tab has no 'new run here' button, and still has 'backlog'", async ($, on) => {
  await mountBoard($, on)
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
    expect(drawn).not.toContain('new run here')
    expect(drawn).not.toContain('"key":"rigs-new-api"')
    expect(drawn).toContain('"key":"rigs-backlog-api"')
    await ui.unmount()
  }
})
