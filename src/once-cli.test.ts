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
import { parseStream, patrolOnce, runModel, runModelAsync, type ModelCall } from './once'
import { STEP_SPECS } from './steps'

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

const factory = (args: string[], stdin = '', extra: Record<string, string> = {}) => {
  const {
    FACTORY_OUTBOX,
    FACTORY_FROM,
    FACTORY_RUN,
    FACTORY_PATROL,
    FACTORY_POLICY_BROKER,
    FACTORY_STEP_ISOLATE,
    ...laptop
  } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_CLAUDE: join(dir, 'stub.sh'),
      FACTORY_SELF_UPDATE: '0',
      FACTORY_NO_KICK: '1',
      ...extra,
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
  expect(lines('agent-steps.jsonl')).toMatchObject([{ step: 'patrol', outcome: 'ok', token_slot: 'live' }])
})

const MAIL = { run: 'r1', from: 'build', text: 'which branch do I merge into?', at: 5 }

test('a patrol that a usage limit refused keeps its mail', () => {
  write('manager-tick.json', { runs: [], manager: [], rigs: [] })
  write('patrol-state.json', { unsent: [MAIL], seen: [], patrolAt: 0 })
  writeFileSync(
    join(dir, 'reply.jsonl'),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      result: 'slow down',
    }) + '\n',
  )
  expect(factory(['patrol', '--once']).err).toBe('')
  expect(read('patrol-state.json').unsent).toEqual([MAIL])
  const row = lines('agent-steps.jsonl')[0]
  expect(row.outcome).toBe('limit')
  expect(row.summary).toContain('no swap:')
})

test('a patrol that ran over its limit commits its mail and logs a timeout', async () => {
  const stub = join(dir, 'slow.sh')
  writeFileSync(stub, '#!/bin/sh\nsleep 30\n')
  chmodSync(stub, 0o755)
  write('manager-tick.json', { runs: [], manager: [], rigs: [] })
  write('patrol-state.json', { unsent: [MAIL], seen: [], patrolAt: 0 })
  const old = process.env.FACTORY_CLAUDE
  process.env.FACTORY_CLAUDE = stub
  try {
    const io = {
      home,
      cli: CLI,
      factories: '/x/factories/',
      settings: {},
      planFacts: async () => '',
      gateFacts: async () => '',
      reviewFacts: () => '',
    }
    const specs = { ...STEP_SPECS, patrol: { ...STEP_SPECS.patrol, timeoutMs: 300 } }
    await patrolOnce(io, { specs })
  } finally {
    if (old === undefined) delete process.env.FACTORY_CLAUDE
    else process.env.FACTORY_CLAUDE = old
  }
  expect(read('patrol-state.json').unsent).toEqual([])
  expect(lines('agent-steps.jsonl')[0].outcome).toBe('timeout')
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

test('patrol --once --fallback runs the patrol on codex with FACTORY_PATROL and a bd shim', () => {
  write('manager-tick.json', { runs: [], manager: [], rigs: [] })
  write('patrol-state.json', { unsent: [MAIL], seen: [], patrolAt: 0 })
  const codex = join(dir, 'codex.sh')
  writeFileSync(
    codex,
    `#!/bin/sh\ncat > '${dir}/stdin.txt'\nprintf '%s\\n' "$@" > '${dir}/args.txt'\nenv > '${dir}/env.txt'\necho answered r1\n`,
  )
  chmodSync(codex, 0o755)
  const r = factory(['patrol', '--once', '--fallback'], '', {
    FACTORY_CODEX: codex,
    OPENAI_API_KEY: 'sk-live-x',
  })
  expect(r.err).toBe('')
  expect(r.out).toContain('answered r1')
  const args = readFileSync(join(dir, 'args.txt'), 'utf8')
  expect(args).toContain('workspace-write')
  expect(args).not.toContain('patrol-guard')
  const env = readFileSync(join(dir, 'env.txt'), 'utf8')
  expect(env).toContain('FACTORY_PATROL=1')
  expect(env).toContain(`PATH=${join(home, 'patrol-bin')}:`)
  expect(env).not.toContain('sk-live-x')
  expect(readFileSync(join(home, 'patrol-bin', 'bd'), 'utf8')).toContain('patrol-bd')
  expect(read('patrol-state.json').unsent).toEqual([])
})

test('patrol-bd refuses a write and the shim runs a read', () => {
  const bad = factory(['patrol-bd', 'update', 'x-1', '--set-metadata', 'a=b'])
  expect(bad.code).toBe(1)
  expect(bad.err).toContain('subagent')
  const fake = join(dir, 'fakebd.sh')
  writeFileSync(fake, `#!/bin/sh\necho real-bd "$@"\n`)
  chmodSync(fake, 0o755)
  const ok = factory(['patrol-bd', 'show', 'x-1'], '', { FACTORY_REAL_BD: fake })
  expect(ok.out).toContain('real-bd show x-1')
})

test('patrol-guard denies the subagent verbs and allows reads', () => {
  const guard = (command: string) => factory(['patrol-guard'], JSON.stringify({ tool_input: { command } }))
  for (const [bad, reason] of [
    [
      'bd ready --claim --label factory',
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author. Write a bd command in literal words with bd as its first word: no $, backtick, glob, brace, # or <. Put other comment text in a file: bd comments add <id> -f <file>',
    ],
    [
      'bd label add x y',
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author. Write a bd command in literal words with bd as its first word: no $, backtick, glob, brace, # or <. Put other comment text in a file: bd comments add <id> -f <file>',
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
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author. Write a bd command in literal words with bd as its first word: no $, backtick, glob, brace, # or <. Put other comment text in a file: bd comments add <id> -f <file>',
    ],
    [
      'bd comments add x y -a p',
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author. Write a bd command in literal words with bd as its first word: no $, backtick, glob, brace, # or <. Put other comment text in a file: bd comments add <id> -f <file>',
    ],
    [
      'BEADS_ACTOR=p bd comment x y',
      'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author. Write a bd command in literal words with bd as its first word: no $, backtick, glob, brace, # or <. Put other comment text in a file: bd comments add <id> -f <file>',
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

test('wua3v model argv preserves source restriction', async () => {
  reply('ok')
  const old = { claude: process.env.FACTORY_CLAUDE, codex: process.env.FACTORY_CODEX }
  process.env.FACTORY_CLAUDE = join(dir, 'stub.sh')
  process.env.FACTORY_CODEX = join(dir, 'stub.sh')
  const settings = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] },
  }
  const base = {
    system: 's',
    input: 'i',
    model: 'm',
    tools: 'Bash',
    maxTurns: 3,
    timeoutMs: 20_000,
    settings,
  }
  const restricted: ModelCall = { ...base, settingSources: 'user' }
  const args = () => readFileSync(join(dir, 'args.txt'), 'utf8').trimEnd().split('\n')
  try {
    for (const run of [runModel, runModelAsync]) {
      for (const mode of [{}, { persist: true }, { persist: true, resume: 's-1' }]) {
        expect((await run({ ...restricted, ...mode })).isOk).toBe(true)
        const a = args()
        expect(a.filter(v => v === '--setting-sources')).toHaveLength(1)
        expect(a[a.indexOf('--setting-sources') + 1]).toBe('user')
        expect(JSON.parse(a[a.indexOf('--settings') + 1]!)).toEqual(settings)
      }
      await run(base)
      expect(args()).not.toContain('--setting-sources')
      await run({ ...restricted, codex: 'gpt-5' })
      expect(args()).not.toContain('--setting-sources')
    }
    const reject = join(dir, 'reject.sh')
    writeFileSync(
      reject,
      `#!/bin/sh\nprintf 'spawn\\n' >> '${dir}/spawns.txt'\nprintf 'unknown option: --setting-sources' >&2\nexit 1\n`,
    )
    chmodSync(reject, 0o755)
    process.env.FACTORY_CLAUDE = reject
    for (const run of [runModel, runModelAsync]) {
      const r = await run(restricted)
      expect(r.isOk).toBe(false)
      expect(r.error).toContain('unknown option: --setting-sources')
    }
    expect(readFileSync(join(dir, 'spawns.txt'), 'utf8')).toBe('spawn\nspawn\n')
  } finally {
    if (old.claude === undefined) delete process.env.FACTORY_CLAUDE
    else process.env.FACTORY_CLAUDE = old.claude
    if (old.codex === undefined) delete process.env.FACTORY_CODEX
    else process.env.FACTORY_CODEX = old.codex
  }
})

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
    expect(r.timedOut).toBe(true)
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
