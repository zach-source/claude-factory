import { expect, mock, test } from 'claude-code/testing'

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

test('the rigs tab draws each rig with its live stations, gates and stuck runs, past its cap too', async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('tick') ? JSON.stringify(TICK) : '', stderr: '' } as never,
  }))
  await $.command.run({ command: 'factory', args: 'status' }) // any command ticks after it
  await clock.settle()
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
    expect(drawn).toContain('api')
    expect(drawn).toContain('"deploy"," ","1"')
    expect(drawn).toContain('"stuck: ","r4"')
    await ui.unmount()
  }
})

test('a tick that logs to stderr, as a reaped pane does, still parses', async ($, on) => {
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
  expect(JSON.stringify(status)).toContain('running')
  expect(JSON.stringify(status)).not.toContain('SyntaxError')
})
