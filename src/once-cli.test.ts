// Tests for `factory patrol|pm|brief|review --once` and `factory patrol-guard`.
// A stub script takes the place of the model: FACTORY_CLAUDE names it. It saves its arguments and stdin,
// and prints a canned stream-json reply. Each test uses its own temp home.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStream, runModel, runModelAsync } from './once'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
let dir = ''
let home = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'once-cli-'))
  home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const stub = join(dir, 'stub.sh')
  writeFileSync(
    stub,
    `#!/bin/sh\ncat > '${dir}/stdin.txt'\nprintf '%s\\n' "$@" > '${dir}/args.txt'\ncat '${dir}/reply.jsonl'\n`,
  )
  chmodSync(stub, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], stdin = '') => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_PATROL, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_CLAUDE: join(dir, 'stub.sh'),
      FACTORY_SELF_UPDATE: '0',
      FACTORY_NO_KICK: '1',
    },
    stdin: Buffer.from(stdin),
    timeout: 60_000,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const write = (name: string, v: unknown) => writeFileSync(join(home, name), JSON.stringify(v))
const read = (name: string) => JSON.parse(readFileSync(join(home, name), 'utf8'))
const lines = (name: string) =>
  readFileSync(join(home, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

/** a canned reply: the Bash commands the model ran, then its final text */
const reply = (text: string, commands: string[] = []) =>
  writeFileSync(
    join(dir, 'reply.jsonl'),
    [
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5-5',
          content: commands.map(command => ({ type: 'tool_use', name: 'Bash', input: { command } })),
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
        duration_ms: 12,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    ]
      .map(e => JSON.stringify(e))
      .join('\n') + '\n',
  )

test('patrol --once sends the kept mail to the model and logs the outcome', () => {
  write('manager-tick.json', { runs: [], manager: [], rigs: [] })
  write('patrol-state.json', {
    unsent: [{ run: 'r1', from: 'build', text: 'which branch do I merge into?', at: 5 }],
    seen: [],
    patrolAt: 0,
  })
  reply('answered r1', ["factory mail r1 build 'main'", 'ls'])
  const r = factory(['patrol', '--once'])
  expect(r.err).toBe('')
  expect(r.out).toContain('answered r1')
  expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toContain(
    '- r1 / build: which branch do I merge into?',
  )
  const args = readFileSync(join(dir, 'args.txt'), 'utf8')
  expect(args).toContain('Bash,Read,Grep,Glob,Write')
  expect(args).toContain('patrol-guard')
  const log = lines('patrol-log.jsonl')
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({
    reason: 'success',
    tokens: 15,
    actions: ["factory mail r1 build 'main'"],
    report: 'answered r1',
  })
  const state = read('patrol-state.json')
  expect(state.unsent).toEqual([])
  expect(state.patrolAt).toBeGreaterThan(0)
  expect(state.sig).toBeString()
  expect(lines('manager-usage.jsonl')[0]).toMatchObject({
    name: 'patrol',
    model: 'claude-sonnet-5-5',
    input: 10,
    output: 5,
    cacheRead: 3,
    cacheWrite: 2,
  })
})

test('patrol --once with no news and no heartbeat due calls no model', () => {
  write('manager-tick.json', { runs: [], manager: [], rigs: [] })
  write('patrol-state.json', { unsent: [], seen: [], patrolAt: Date.now() })
  const r = factory(['patrol', '--once'])
  expect(r.out.trim()).toBe('nothing due')
  expect(existsSync(join(dir, 'args.txt'))).toBe(false)
})

test('patrol --once keeps the mail when the model cannot start', () => {
  write('manager-tick.json', { runs: [], manager: [], rigs: [] })
  write('patrol-state.json', {
    unsent: [{ run: 'r1', from: 'build', text: 'q', at: 5 }],
    seen: [],
    patrolAt: 0,
  })
  const { FACTORY_CLAUDE: _, ...rest } = process.env
  const p = Bun.spawnSync([CLI, 'patrol', '--once'], {
    env: {
      ...rest,
      FACTORY_HOME: home,
      FACTORY_CLAUDE: join(dir, 'missing-model'),
      FACTORY_SELF_UPDATE: '0',
      FACTORY_NO_KICK: '1',
    },
  })
  expect(p.stdout.toString()).toContain('the patrol failed')
  expect(read('patrol-state.json').unsent).toHaveLength(1)
  expect(lines('patrol-log.jsonl')[0].error).toBeString()
})

test('tick --keep-mail saves the tick output', () => {
  const r = factory(['tick', '--keep-mail'])
  expect(r.code).toBe(0)
  expect(read('manager-tick.json')).toHaveProperty('runs')
  expect(read('patrol-state.json').unsent).toEqual([])
})

test('patrol --once refuses codex', () => {
  const r = factory(['patrol', '--once', '--codex', 'gpt-5'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('codex has no PreToolUse hook')
})

test('patrol-guard denies the subagent verbs and allows reads', () => {
  const guard = (command: string) => factory(['patrol-guard'], JSON.stringify({ tool_input: { command } }))
  for (const [bad, reason] of [
    [
      'bd label add x y',
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author',
    ],
    [
      'factory decide r1 ok',
      'The person did not confirm this gate decision. Ask them which outcome they want. A patrol never decides this: leave it for the person.',
    ],
    [
      'factory skills install x',
      'a subagent never installs or rejects a skill or proposal: only the manager or the person installs',
    ],
    ['bd update x --set-metadata a=b', 'a subagent never writes bead metadata'],
    [
      'bd comment x y --actor p',
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author',
    ],
    [
      'bd comments add x y -a p',
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author',
    ],
    [
      'BEADS_ACTOR=p bd comment x y',
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author',
    ],
  ] as const) {
    const r = guard(bad)
    expect([bad, r.code]).toEqual([bad, 2])
    expect(r.err).toBe(reason + '\n')
  }
  for (const ok of ['factory status', 'bd show x']) expect([ok, guard(ok).code]).toEqual([ok, 0])
  expect(factory(['patrol-guard'], '{}')).toEqual({
    code: 2,
    out: '',
    err: 'the hook input has no Bash command\n',
  })
})

test('pm --once applies the last fenced json answer', () => {
  reply('thinking\n```json\n{"rigs":{},"proposals":[]}\n```', [])
  const r = factory(['pm', '--once'])
  expect(r.err).toBe('')
  expect(r.out).toContain('plan set: 0 items')
  expect(read('plan-answer.json')).toEqual({ rigs: {}, proposals: [] })
  expect(existsSync(join(home, 'plan.json'))).toBe(true)
  expect(readFileSync(join(dir, 'args.txt'), 'utf8')).toMatch(/--tools\n\n/) // an empty tool list
  expect(lines('pm-log.jsonl')[0]).toMatchObject({ items: 0, findings: 0, filed: 0, tokens: 15 })
  expect(lines('manager-usage.jsonl')[0].name).toBe('pm')
})

test('pm --once logs an error for an answer with no fence', () => {
  reply('no fence here')
  const r = factory(['pm', '--once'])
  expect(r.out).toContain('the pm failed')
  expect(lines('pm-log.jsonl')[0].error).toContain('no fenced json block')
  expect(existsSync(join(home, 'plan.json'))).toBe(false)
})

test('brief --once and review --once report nothing due on an empty board', () => {
  write('manager-tick.json', { runs: [], manager: [], reviews: [] })
  expect(factory(['brief', '--once']).out.trim()).toBe('nothing due')
  expect(factory(['review', '--once']).out.trim()).toBe('nothing due')
})

const stream = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n')

test('parseStream keeps tool ids and the session', () => {
  const bash = (id: unknown, command: string) => ({ type: 'tool_use', name: 'Bash', id, input: { command } })
  const out = stream([
    {
      type: 'assistant',
      message: {
        content: [
          bash('toolu_a', 'factory status'),
          bash('toolu_b', 'factory show r1'),
          bash(undefined, 'no id'),
          { type: 'tool_use', name: 'Read', id: 'toolu_c', input: { command: 'x' } },
        ],
      },
    },
    { type: 'result', subtype: 'success', result: 'ok', session_id: 's-9' },
  ])
  const r = parseStream(out, 'm')
  expect(r.calls).toEqual([
    { id: 'toolu_a', command: 'factory status' },
    { id: 'toolu_b', command: 'factory show r1' },
  ])
  expect(r.session).toBe('s-9')
  expect(r.commands).toEqual(['factory status', 'factory show r1', 'no id'])
  const none = parseStream(stream([{ type: 'assistant', message: { content: [bash('t', 'x')] } }]), 'm')
  expect(none.reason).toBe('no-result')
  expect(none.calls).toEqual([{ id: 't', command: 'x' }])
  expect(parseStream('', 'm').calls).toEqual([])
})

test('runModelAsync passes session, resume, cwd and the base env', async () => {
  const stub = join(dir, 'chat-stub.sh')
  writeFileSync(
    stub,
    `#!/bin/sh\npwd > '${dir}/pwd.txt'\nenv > '${dir}/env.txt'\nprintf '%s\\n' "$@" > '${dir}/args.txt'\ncat > /dev/null\ncat '${dir}/reply.jsonl'\n`,
  )
  chmodSync(stub, 0o755)
  writeFileSync(
    join(dir, 'reply.jsonl'),
    stream([{ type: 'result', subtype: 'success', result: 'hi', session_id: 's-1' }]),
  )
  const base = { system: 's', input: 'i', model: 'm', tools: 'Bash', maxTurns: 3, timeoutMs: 20_000 }
  const old = process.env.FACTORY_CLAUDE
  process.env.FACTORY_CLAUDE = stub
  process.env.ONLY_PROC = '1'
  try {
    const r = await runModelAsync({
      ...base,
      persist: true,
      resume: 's-1',
      cwd: home,
      baseEnv: { PATH: process.env.PATH, ONLY_BASE: '1' },
    })
    expect(r.isOk).toBe(true)
    expect(r.session).toBe('s-1')
    const args = readFileSync(join(dir, 'args.txt'), 'utf8').split('\n')
    expect(args).not.toContain('--no-session-persistence')
    expect(args[args.indexOf('--verbose') + 1]).toBe('--resume')
    expect(args[args.indexOf('--verbose') + 2]).toBe('s-1')
    expect(readFileSync(join(dir, 'pwd.txt'), 'utf8').trim()).toBe(realpathSync(home))
    const env = readFileSync(join(dir, 'env.txt'), 'utf8')
    expect(env).toContain('ONLY_BASE=1')
    expect(env).not.toContain('ONLY_PROC')
    // the same argv as the sync runModel without the new fields
    await runModelAsync(base)
    const a = readFileSync(join(dir, 'args.txt'), 'utf8')
    runModel(base)
    expect(readFileSync(join(dir, 'args.txt'), 'utf8')).toBe(a)
    expect(a).toContain('--no-session-persistence')
  } finally {
    delete process.env.ONLY_PROC
    if (old === undefined) delete process.env.FACTORY_CLAUDE
    else process.env.FACTORY_CLAUDE = old
  }
})

test('runModelAsync kills the process group at the timeout', async () => {
  const stub = join(dir, 'slow.sh')
  writeFileSync(stub, '#!/bin/sh\nsleep 30 & sleep 30\n')
  chmodSync(stub, 0o755)
  const old = process.env.FACTORY_CLAUDE
  process.env.FACTORY_CLAUDE = stub
  try {
    const t = Date.now()
    const r = await runModelAsync({
      system: 's',
      input: 'i',
      model: 'm',
      tools: 'Bash',
      maxTurns: 3,
      timeoutMs: 500,
    })
    expect(Date.now() - t).toBeLessThan(3000)
    expect(r.isOk).toBe(false)
    expect(r.reason).toBe('spawn-failed')
  } finally {
    if (old === undefined) delete process.env.FACTORY_CLAUDE
    else process.env.FACTORY_CLAUDE = old
  }
})

test('chat-guard allows reads, asks for a gate and fails closed', () => {
  const guard = (command: string) => factory(['chat-guard'], JSON.stringify({ tool_input: { command } }))
  expect(guard('factory status').code).toBe(0)
  const ask = guard('/repo/bin/factory decide lifecycle-abc ship "looks good"')
  expect(ask.code).toBe(2)
  expect(ask.err).toEndWith(
    'the person must approve this command; a chat turn cannot run it: tell the person\n',
  )
  expect(factory(['chat-guard'], '{}')).toEqual({
    code: 2,
    out: '',
    err: 'the hook input has no Bash command\n',
  })
})

test('chat-guard takes an approval hash and fails closed on bad arguments', () => {
  const ask = '/repo/bin/factory decide lifecycle-abc ship "looks good"'
  const hash = new Bun.CryptoHasher('sha256').update(ask).digest('hex')
  const guard = (args: string[], command: string) =>
    factory(['chat-guard', ...args], JSON.stringify({ tool_input: { command } }))
  mkdirSync(join(home, 'conversations'), { recursive: true })
  writeFileSync(join(home, 'conversations', 'c.approve'), hash)
  expect(guard(['c', hash], ask).code).toBe(0)
  expect(existsSync(join(home, 'conversations', 'c.approve'))).toBe(false)
  expect(guard(['c', hash], ask).code).toBe(2)
  expect(guard(['c'], 'factory status')).toEqual({ code: 2, out: '', err: 'bad chat-guard arguments\n' })
})
