import { expect, mock, test } from 'claude-code/testing'

// a run parked on the person, its worker's question and options in its blocked report
const TICK = {
  manager: [],
  rigs: [{ name: 'api', repo: '/w/api', factory: 'lifecycle' }],
  runs: [
    {
      id: 'r1',
      rig: 'api',
      node: 'triage',
      sub: 'waiting',
      goal: 'g',
      last: {
        node: 'triage',
        attempt: 1,
        outcome: 'blocked',
        summary: 'Two specs disagree.\nQuestion: Which spec wins?\nOptions: the ADR | the bead',
        at: 1,
      },
    },
  ],
}

test('the interview tab asks a parked run its question and mails the chosen answer to its station', async ($, on) => {
  const clock = mock.clock(on)
  const ran: string[][] = []
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.status', 'ui.toast'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('process.run', ($, e) => {
    ran.push([...e.argv])
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
  await $.command.run({ command: 'factory', args: 'interview' } as never)
  const ui = await $.ui.mount({
    plugin: 'factory',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'factory',
    props: { bodyColumns: 100, placement: 'dock' } as never,
    viewport: { columns: 100, rows: 60 },
  })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Which spec wins?')
  expect(drawn).toContain('questions (1)')
  await ui.press({ key: 'iv-opt-iv:r1@1-0' })
  await clock.settle()
  const mail = ran.find(a => a.includes('mail'))
  expect(mail?.slice(-3)).toEqual([
    'r1',
    'triage',
    'Answering "Which spec wins?": The person chose: the ADR.',
  ])
  expect(JSON.stringify(await ui.drawn())).toContain('answered (1)')
  await ui.unmount()
})
