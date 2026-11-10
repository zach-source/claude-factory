import { expect, mock, test } from 'claude-code/testing'
import { stepStub } from './step-stub'

const SLOW = { timeoutMs: 30_000 }
const DECIDE = '/repo/bin/factory decide lifecycle-abc ship "looks good"'
const UUID = /export FACTORY_ALLOW=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n/

// a session with a real `factory home` answer and an in-memory fs (claude-factory-6g6ud)
async function session(
  $: any,
  on: any,
  answer: string,
  opts: {
    home?: string
    failWrite?: boolean
    onBash?: (command: string, files: Map<string, string>) => void
  } = {},
) {
  const clock = mock.clock(on)
  const home = opts.home ?? '/home/acme'
  const files = new Map<string, string>()
  const commands: string[] = []
  let asks = 0
  on('fs.stat', () => ({ value: { realPath: '/repo/mod' } }))
  on('ui.open', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_: any, e: any) => {
    if (e.argv.includes('tick'))
      return {
        value: { exitCode: 0, stdout: JSON.stringify({ manager: [], rigs: [], runs: [] }), stderr: '' },
      }
    if (e.argv.includes('home')) return { value: { exitCode: 0, stdout: home, stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('fs.read', (_: any, e: any) => {
    const stub = stepStub(e.path)
    if (stub !== undefined) return { value: stub }
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: files.get(e.path)! }
  })
  on('fs.write', (_: any, e: any) => {
    if (opts.failWrite && String(e.path).includes('/allow/')) throw new Error('EROFS')
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asks++
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('tool.call', { tool: 'Bash' }, (_: any, e: any) => {
    commands.push(e.command)
    opts.onBash?.(e.command, files)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  await $.command.run({ command: 'factory', args: 'status' })
  await clock.settle()
  return { files, commands, clock, asks: () => asks }
}

test(
  'the main-chat prefix always carries the marker; an ungated command carries no token (AC1)',
  SLOW,
  async ($, on) => {
    const s = await session($, on, 'Allow')
    await $.tool.call({ tool: 'Bash', command: '/repo/bin/factory status' })
    expect(s.commands.at(-1)).toContain('export FACTORY_MAIN_CHAT=1\n')
    expect(s.commands.at(-1)).not.toContain('FACTORY_ALLOW')
  },
)

test(
  'Allow writes one token file while the command runs, then revokes it; two Allows give two tokens (AC2)',
  SLOW,
  async ($, on) => {
    const live: string[] = []
    const now = Date.now()
    const s = await session($, on, 'Allow', {
      onBash: (command, files) => {
        const t = UUID.exec(command)?.[1]
        if (t) live.push(files.get(`/home/acme/allow/${t}.json`) ?? '')
      },
    })
    const r = await $.tool.call({ tool: 'Bash', command: DECIDE })
    expect(r.deny).toBeUndefined()
    const token = UUID.exec(s.commands.at(-1)!)![1]!
    const body = JSON.parse(live[0]!)
    expect(body.kinds).toEqual(['decide'])
    expect(body.exp).toBeGreaterThanOrEqual(now + 600_000 - 5_000)
    expect(body.exp).toBeLessThanOrEqual(Date.now() + 600_000)
    expect(s.files.get(`/home/acme/allow/${token}.json`)).toBe('')
    await $.tool.call({ tool: 'Bash', command: DECIDE })
    expect(UUID.exec(s.commands.at(-1)!)![1]).not.toBe(token)
  },
)

test('Deny writes no token and runs nothing (AC2)', SLOW, async ($, on) => {
  const s = await session($, on, 'Deny')
  const r = await $.tool.call({ tool: 'Bash', command: DECIDE })
  expect(r.deny).toContain('did not confirm')
  expect(s.commands.length).toBe(0)
  expect([...s.files.keys()].some(k => k.includes('/allow/'))).toBe(false)
})

test('a failed token write denies the command (AC2)', SLOW, async ($, on) => {
  const s = await session($, on, 'Allow', { failWrite: true })
  const r = await $.tool.call({ tool: 'Bash', command: DECIDE })
  expect(r.deny).toBeDefined()
  expect(s.commands.length).toBe(0)
})

test('an empty home gives no token (AC2)', SLOW, async ($, on) => {
  const s = await session($, on, 'Allow', { home: '' })
  await $.tool.call({ tool: 'Bash', command: DECIDE })
  expect(s.commands.at(-1)).toContain('export FACTORY_MAIN_CHAT=1\n')
  expect(s.commands.at(-1)).not.toContain('FACTORY_ALLOW')
})

test("a patrol subagent's prefix has FACTORY_PATROL and not the marker (AC1)", SLOW, async ($, on) => {
  const s = await session($, on, 'Allow')
  await $.tool.call({ tool: 'Bash', command: '/repo/bin/factory status', agentId: 'sub-1' } as never)
  expect(s.commands.at(-1)).toContain('export FACTORY_PATROL=1')
  expect(s.commands.at(-1)).not.toContain('FACTORY_MAIN_CHAT')
})

// claude-factory-d289.26: the AX manager task's shell bd gets the rig store env (only when FACTORY_IN_AX is 1 in the shell)
test(
  'every model command carries the bd shim that asks repos bd-env, for the main chat and a subagent',
  SLOW,
  async ($, on) => {
    const s = await session($, on, 'Allow')
    const shim = `if [ "$FACTORY_IN_AX" = 1 ]; then bd() { (eval "$('/repo/mod/../bin/factory' repos bd-env 2>/dev/null)"; command bd "$@"); }; fi\n`
    await $.tool.call({ tool: 'Bash', command: 'bd ready' })
    expect(s.commands.at(-1)).toContain(shim)
    expect(s.commands.at(-1)!.endsWith('bd ready')).toBe(true)
    await $.tool.call({ tool: 'Bash', command: 'bd ready', agentId: 'sub-1' } as never)
    expect(s.commands.at(-1)).toContain(shim)
  },
)

// claude-factory-d289.25: Allow for this turn
const TURN = 'Allow for this turn'
const ANSWER = '/repo/bin/factory decisions answer rig bead-1 "not now"'
const tokenOf = (s: { commands: string[] }) => UUID.exec(s.commands.at(-1)!)?.[1]

test(
  'Allow for this turn writes a turn token, keeps it, and reuses it with no dialog',
  SLOW,
  async ($, on) => {
    const s = await session($, on, TURN)
    const now = Date.now()
    await $.tool.call({ tool: 'Bash', command: ANSWER })
    const token = tokenOf(s)!
    const body = JSON.parse(s.files.get(`/home/acme/allow/${token}.json`)!)
    expect(body.kinds).toEqual(['answer'])
    expect(body.turn).toBe(true)
    expect(body.exp).toBeLessThanOrEqual(Date.now() + 1_800_000)
    expect(body.exp).toBeGreaterThanOrEqual(now + 1_800_000 - 5_000)
    await $.tool.call({ tool: 'Bash', command: ANSWER })
    expect(tokenOf(s)).toBe(token)
    expect(s.asks()).toBe(1)
    // a different kind still asks
    await $.tool.call({ tool: 'Bash', command: DECIDE })
    expect(s.asks()).toBe(2)
    expect(tokenOf(s)).not.toBe(token)
  },
)

test(
  'the turn ends the Allow for this turn: the file is empty and the next gated call asks',
  SLOW,
  async ($, on) => {
    const s = await session($, on, TURN)
    await $.tool.call({ tool: 'Bash', command: ANSWER })
    const token = tokenOf(s)!
    await $.turn.complete({ answer: 'done', reason: 'end_turn', durationMs: 1 } as never)
    expect(s.files.get(`/home/acme/allow/${token}.json`)).toBe('')
    await $.tool.call({ tool: 'Bash', command: ANSWER })
    expect(tokenOf(s)).not.toBe(token)
    // a new person prompt ends it too
    const second = tokenOf(s)!
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'user' } } as never)
    expect(s.files.get(`/home/acme/allow/${second}.json`)).toBe('')
  },
)

test('exp ends the Allow for this turn', SLOW, async ($, on) => {
  const s = await session($, on, TURN)
  await $.tool.call({ tool: 'Bash', command: ANSWER })
  const token = tokenOf(s)!
  await s.clock.advance(29 * 60_000)
  await $.tool.call({ tool: 'Bash', command: ANSWER })
  expect(tokenOf(s)).toBe(token)
  await s.clock.advance(2 * 60_000)
  await $.tool.call({ tool: 'Bash', command: ANSWER })
  expect(s.files.get(`/home/acme/allow/${token}.json`)).toBe('')
  expect(tokenOf(s)).not.toBe(token)
})

test('a subagent stays denied with the turn Allow held', SLOW, async ($, on) => {
  const s = await session($, on, TURN)
  await $.tool.call({ tool: 'Bash', command: ANSWER })
  const n = s.commands.length
  const r = await $.tool.call({ tool: 'Bash', command: ANSWER, agentId: 'sub-1' } as never)
  expect(r.deny).toBeDefined()
  expect(s.commands.length).toBe(n)
})
