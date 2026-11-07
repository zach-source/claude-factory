import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { stubPrompt } from './step-stub'

// AC5: the mod reads src/steps/<name>.md and fails closed. A step file that is missing, empty or does not
// fill leaves its agent unregistered and shows one status line. The other agents still register.
const SLOW = { timeoutMs: 30_000 }
const CLI = '/repo/mod/../bin/factory'

type Steps = Record<string, string | undefined>
const GOOD: Steps = {
  patrol: 'STUB patrol {{cli}} {{factories}}\n',
  pm: 'STUB pm {{cli}}\n',
  briefer: 'STUB briefer\n',
  reviewer: 'STUB reviewer\n',
}

function rig(on: On, steps: Steps) {
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }) as never)
  on('fs.read', ($, e) => {
    const path = (e as { path: string }).path
    const text = steps[/\/src\/steps\/(\w+)\.md$/.exec(path)?.[1] ?? '']
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
    return { value: text } as never
  })
}

async function register(on: On, $: Parameters<NonNullable<Parameters<typeof test>[2]>>[0], steps: Steps) {
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  rig(on, steps)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  const status: string[] = []
  on('ui.status', (_, e) => (status.push(JSON.stringify(e)), { value: undefined }) as never)
  on('command.register', () => ({ value: { command: 'factory' } }) as never)
  const registered: { name: string; prompt: string }[] = []
  on('agent.register', ($, e) => {
    registered.push(e as unknown as { name: string; prompt: string })
    return { value: { agent: `factory:${(e as unknown as { name: string }).name}` } } as never
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
  return {
    names: registered.map(r => r.name).sort(),
    registered,
    status: status.filter(s => s.includes('could not')),
  }
}

test('every step file present: all four agents register with the filled step text', SLOW, async ($, on) => {
  const r = await register(on, $, GOOD)
  expect(r.names).toEqual(['briefer', 'patrol', 'pm', 'reviewer'])
  for (const a of r.registered) expect(a.prompt).toBe(stubPrompt(a.name, CLI))
  expect(r.status).toEqual([])
})

test('a missing patrol.md leaves out the patrol only, with one status line', SLOW, async ($, on) => {
  const r = await register(on, $, { ...GOOD, patrol: undefined })
  expect(r.names).toEqual(['briefer', 'pm', 'reviewer'])
  expect(r.status).toHaveLength(1)
  expect(r.status[0]).toContain('factory: could not load the patrol prompt')
})

test('an empty or blank step file is handled like a missing one', SLOW, async ($, on) => {
  const r = await register(on, $, { ...GOOD, pm: '', reviewer: '\n' })
  expect(r.names).toEqual(['briefer', 'patrol'])
  expect(r.status).toHaveLength(2)
  expect(r.status.join('\n')).toContain('could not load the pm prompt')
  expect(r.status.join('\n')).toContain('could not load the reviewer prompt')
})

test(
  'a step file with a placeholder that has no value, or with none for a var, is not registered',
  SLOW,
  async ($, on) => {
    const r = await register(on, $, { ...GOOD, briefer: 'STUB {{unknown}}\n', pm: 'STUB pm without cli\n' })
    expect(r.names).toEqual(['patrol', 'reviewer'])
    expect(r.status.join('\n')).toContain('could not load the briefer prompt')
    expect(r.status.join('\n')).toContain('could not load the pm prompt')
  },
)

// the fallback path: a manager with no Agent tool submits the patrol step text to the main chat
test(
  'a missing patrol.md on the fallback path submits no prompt and frees the patrol',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on)
    const steps: Steps = { ...GOOD, patrol: undefined }
    rig(on, steps)
    let n = 0
    on('process.run', ($, e) => {
      if (e.argv.includes('tick')) {
        n += 1
        // the tick gives a mail one time only: the later patrol must still carry it
        const out = JSON.stringify({
          manager: n === 1 ? [{ run: 'r1', from: 'implement', text: 'blocked: which DB?', at: n }] : [],
          rigs: [],
          runs: [{ id: 'r1', rig: 'api', node: 'implement', sub: 'waiting', goal: 'g' }],
        })
        return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
      }
      if (e.argv.includes('home'))
        return { value: { exitCode: 0, stdout: '/home/acme', stderr: '' } as never }
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    })
    on('fs.write', () => ({ value: undefined }) as never)
    for (const event of ['ui.open', 'ui.toast'] as const) on(event, () => ({ value: undefined }) as never)
    const status: string[] = []
    on('ui.status', (_, e) => (status.push(JSON.stringify(e)), { value: undefined }) as never)
    on('tool.list', () => ({ value: [{ name: 'Bash', description: '', mcp: false }] }) as never)
    const submits: { text: string }[] = []
    on('prompt.submit', ($, e) => {
      submits.push(e as never)
      return { text: e.text } as never
    })
    on('turn.complete', ($, e) => ({ text: e.answer }) as never)

    await $.command.run({ command: 'factory', args: 'status' } as never)
    await clock.settle()
    expect(submits).toHaveLength(0)
    expect(status.join('\n')).toContain('could not load the patrol prompt')

    // the file comes back: the next due patrol submits, so the failed one did not leave the patrol marked busy
    steps.patrol = GOOD.patrol
    await clock.advance(11 * 60_000)
    expect(submits.length).toBeGreaterThanOrEqual(1)
    expect(submits[0]!.text).toStartWith(stubPrompt('patrol', CLI))
    expect(submits[0]!.text).toContain('blocked: which DB?')
  },
)
