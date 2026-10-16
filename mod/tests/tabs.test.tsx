import { expect, mock, test } from 'claude-code/testing'

// raises the kit's 5000ms default: under high shared-host load the first `$` call in each of
// this file's tests (the plugin's own startup) can outlast 5000ms (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

// what `factory tick` printed: the rigs and their runs as the console gets them
const TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle', maxRuns: 5, goal: 'ship it' }],
  runs: [{ id: 'r1', rig: 'api', node: 'implement', sub: 'working', goal: 'g' }],
}

async function mountBoard($: any, on: any, rigs: unknown[] = TICK.rigs) {
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('process.run', ($: any, e: any) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('tick') ? JSON.stringify({ ...TICK, rigs }) : '',
      stderr: '',
    } as never,
  }))
  await $.command.run({ command: 'factory', args: 'status' } as never) // any command ticks after it
  await clock.settle()
  await $.command.run({ command: 'factory', args: 'board' } as never)
}

test(
  'the tab bar is Board..Interview on contiguous hotkeys 1-6, with exactly those 6 tabs and no Run tab',
  SLOW,
  async ($, on) => {
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
  },
)

test("the rigs tab has no 'new run here' button, and still has 'backlog'", SLOW, async ($, on) => {
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

test(
  'the rigs tab shows a Linear line for an opted-in rig (pulled count or error), and none for a rig with no linear field',
  SLOW,
  async ($, on) => {
    await mountBoard($, on, [
      {
        name: 'ok',
        repo: '/w/ok',
        factory: 'lifecycle',
        linear: ['04114abf-ddb7-4a6f-bb47-814fd2c44373'],
        linearSync: { at: Date.now(), fresh: false, pulled: 3 },
      },
      {
        name: 'err',
        repo: '/w/err',
        factory: 'lifecycle',
        linear: ['04114abf-ddb7-4a6f-bb47-814fd2c44373'],
        linearSync: { at: Date.now(), fresh: false, error: 'boom' },
      },
      { name: 'none', repo: '/w/none', factory: 'lifecycle' },
    ])
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
      expect(drawn).toContain('"key":"rigs-linear-ok"')
      expect(drawn).toContain('pulled 3')
      expect(drawn).toContain('"key":"rigs-linear-err"')
      expect(drawn).toContain('linear: boom')
      expect(drawn).not.toContain('"key":"rigs-linear-none"')
      await ui.unmount()
    }
  },
)
