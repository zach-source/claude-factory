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
  await $.command.run({ command: 'factory', args: 'status' }) // any command ticks after it
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' })
}

test('the tab bar has no New run tab: Board..Interview on contiguous hotkeys 1-7', async ($, on) => {
  await mountBoard($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface,
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' },
      viewport: { columns: 100, rows: 60 },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).not.toContain('New run')
    expect(drawn).not.toContain('"key":"tab-new"')
    for (const [label, key] of [
      ['Board', '1'],
      ['Run', '2'],
      ['Backlog', '3'],
      ['Mail', '4'],
      ['Rigs', '5'],
      ['PRs', '6'],
      ['Interview', '7'],
    ])
      expect(drawn).toContain(`"label":"${label}","hotkey":"${key}"`)
    expect(drawn).toContain('1-7 views')
    expect(drawn).not.toContain('1-8 views')
    await ui.unmount()
  }
})

test("the rigs tab has no 'new run here' button, and still has 'backlog'", async ($, on) => {
  await mountBoard($, on)
  await $.command.run({ command: 'factory', args: 'rigs' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'factory',
      surface,
      component: 'Pane',
      requestId: 'factory',
      props: { bodyColumns: 100, placement: 'dock' },
      viewport: { columns: 100, rows: 60 },
    })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).not.toContain('new run here')
    expect(drawn).not.toContain('"key":"rigs-new-api"')
    expect(drawn).toContain('"key":"rigs-backlog-api"')
    await ui.unmount()
  }
})
