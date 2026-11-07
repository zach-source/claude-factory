import { expect, mock, test } from 'claude-code/testing'
import { stepStub } from './step-stub'

// claude-factory-s01d.2: a tick without the lease is read-only. The mod shows it and starts no subagent.
test(
  'a read-only tick spawns no patrol, pm, briefer or reviewer and says who holds the lease',
  { timeoutMs: 30_000 },
  async ($, on) => {
    const clock = mock.clock(on)
    const spawns: unknown[] = []
    const status: string[] = []
    const argvs: string[][] = []
    on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
    on('fs.read', ($, e) => {
      const stub = stepStub((e as { path: string }).path)
      if (stub === undefined) throw new Error('ENOENT')
      return { value: stub } as never
    })
    for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
    on('ui.status', (_, e) => (status.push((e as { text: string }).text), { value: undefined }) as never)
    on('process.run', ($, e) => {
      argvs.push(e.argv)
      if (e.argv.includes('tick')) {
        const out = JSON.stringify({
          readOnly: 'herdr:one (herdr) holds the manager lease, renewed 2s ago',
          manager: [{ run: 'r1', from: 'implement', text: 'blocked', at: 1 }],
          rigs: [],
          runs: [{ id: 'r1', node: 'gate', sub: 'waiting', goal: 'g', gate: { outcomes: ['ok'] } }],
        })
        return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    })
    on('agent.spawn', ($, e) => (spawns.push(e), { model: 'sonnet' }) as never)

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    await clock.advance(5_000)

    expect(spawns).toHaveLength(0)
    expect(argvs.some(a => a.includes('facts'))).toBe(false)
    expect(status.some(s => s.includes('read-only: herdr:one (herdr) holds the manager lease'))).toBe(true)
  },
)
