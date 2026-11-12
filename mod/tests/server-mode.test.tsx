import { expect, mock, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { appendManagerUsage, rt } from '../hooks/register'
import { onStepFiles } from './step-stub'

// claude-factory-gogxc.14: with FACTORY_SERVER set, the mod does not tick, asks for no home,
// and posts its log rows through `factory manager log <kind> <json>` (POST /v1/manager/log/:kind).

test('server mode: no tick and no home', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[][] = []
  onStepFiles(on)
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  for (const event of ['ui.open', 'ui.toast', 'ui.status'] as const)
    on(event, () => ({ value: undefined }) as never)
  on('process.run', (_, e) => {
    calls.push(e.argv as string[])
    const stdout = e.argv[0] === 'sh' ? 'https://pod.example:8444' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } as never }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on(
    'agent.list',
    () => ({ value: [{ id: 'p1', type: 'factory:patrol', description: '', status: 'running' }] }) as never,
  )

  await $.command.run({ command: 'factory', args: 'status' } as never)
  await clock.advance(10 * 60_000)
  await clock.settle()

  const cli = calls.filter(c => c[0] !== 'sh')
  expect(cli.some(c => c.includes('tick') || c.includes('home'))).toBe(false)
})

test('server mode: a usage row goes to the log route and no file is written', async () => {
  const calls: string[][] = []
  const files: string[] = []
  const $ = {
    clock: { now: async () => 5 },
    ui: { status: () => {} },
    fs: { write: async (p: string) => void files.push(p), read: async () => '' },
    process: {
      run: async (argv: string[]) => (calls.push(argv), { exitCode: 0, stdout: '', stderr: '' }),
    },
  } as unknown as EngineInterface
  rt.isServer = true
  rt.cli = 'factory'
  try {
    await appendManagerUsage($, 'pm', {
      model: 'm',
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    })
  } finally {
    rt.isServer = false
  }
  expect(files).toEqual([])
  expect(calls).toHaveLength(1)
  expect(calls[0]!.slice(0, 4)).toEqual(['factory', 'manager', 'log', 'usage'])
  expect(JSON.parse(calls[0]![4]!)).toMatchObject({ name: 'pm', model: 'm', input: 1, output: 2 })
})
