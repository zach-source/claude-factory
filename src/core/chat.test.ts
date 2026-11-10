import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelCall, ModelResult } from '../once'
import { CLI, conversationFile, guardHook, queue, send, show } from './chat'
import type { Ctx, Env, Port } from './catalog'
import { check } from './guards'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'chat-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const ok = (over: Partial<ModelResult> = {}): ModelResult => ({
  isOk: true,
  text: 'answer',
  reason: 'success',
  durationMs: 1,
  commands: [],
  calls: [],
  session: 's-1',
  ...over,
})

/** a fake model: it records each call and resolves it with `next(call)` */
const fakeModel = (next: (c: ModelCall, n: number) => Promise<ModelResult> | ModelResult = () => ok()) => {
  const calls: ModelCall[] = []
  const chatModel = async (c: ModelCall) => {
    calls.push(c)
    return next(c, calls.length)
  }
  return { calls, chatModel }
}

const ctxOf = (chatModel: Port['chatModel'], env: Env = {}): Ctx => ({
  home,
  env,
  port: { chatModel } as Port,
  board: () => ({}),
  cli: async () => ({ code: 0, out: '', err: '' }),
})

const lines = (id: string) =>
  readFileSync(join(home, 'conversations', `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

const shown = (id: string) => show(home, id)

test('keeps the session across two turns', async () => {
  const m = fakeModel()
  const ctx = ctxOf(m.chatModel)
  const r1 = await send(ctx, { id: 'c1', text: 'one', front: 'cli' })
  expect(r1.code).toBe(0)
  await send(ctx, { id: 'c1', text: 'two', front: 'web' })
  expect(m.calls[0]!.resume).toBeUndefined()
  expect(m.calls[0]!.persist).toBe(true)
  expect(m.calls[0]!.cwd).toBe(home)
  expect(m.calls[1]!.resume).toBe('s-1')
  const s = shown('c1')
  expect(s.session).toBe('s-1')
  expect(s.turns.map(t => [t.who, t.text, t.front])).toEqual([
    ['person', 'one', 'cli'],
    ['manager', 'answer', 'cli'],
    ['person', 'two', 'web'],
    ['manager', 'answer', 'web'],
  ])
})

const seed = (id: string, rows: string[]) => {
  mkdirSync(join(home, 'conversations'), { recursive: true })
  writeFileSync(join(home, 'conversations', `${id}.jsonl`), rows.join('\n') + '\n')
}
const mgr = (session?: string, extra = {}) =>
  JSON.stringify({
    who: 'manager',
    text: 't',
    front: 'cli',
    at: 1,
    ...(session ? { session } : {}),
    ...extra,
  })

test('the session rule skips values that are not safe argv', async () => {
  // (a) only a flag-like session
  seed('a', [mgr('--x')])
  const a = fakeModel()
  await send(ctxOf(a.chatModel), { id: 'a', text: 'x', front: 'cli' })
  expect(a.calls[0]!.resume).toBeUndefined()
  // (b) a later bad session does not hide the good one
  seed('b', [mgr('s-1'), mgr('a b')])
  const b = fakeModel()
  await send(ctxOf(b.chatModel), { id: 'b', text: 'x', front: 'cli' })
  expect(b.calls[0]!.resume).toBe('s-1')
  // (c) a failed turn with no session
  seed('c', [mgr('s-2'), mgr(undefined, { error: 'e', reason: 'spawn-failed' })])
  const c = fakeModel()
  await send(ctxOf(c.chatModel), { id: 'c', text: 'x', front: 'cli' })
  expect(c.calls[0]!.resume).toBe('s-2')
})

test('show skips bad lines; no file gives an empty conversation; a bad id throws', () => {
  seed('d', ['null', '5', '{}', 'not json', mgr('s-1'), JSON.stringify({ who: 'person', text: 'p' })])
  const s = shown('d')
  expect(s.turns.map(t => t.who)).toEqual(['manager', 'person'])
  expect(s.session).toBe('s-1')
  expect(shown('nope')).toEqual({ id: 'nope', session: null, turns: [] })
  expect(existsSync(join(home, 'conversations'))).toBe(true) // seeded above
  const fresh = mkdtempSync(join(tmpdir(), 'chat-fresh-'))
  try {
    expect(show(fresh, 'x').turns).toEqual([])
    expect(existsSync(join(fresh, 'conversations'))).toBe(false)
  } finally {
    rmSync(fresh, { recursive: true, force: true })
  }
  expect(() => show(home, '../x')).toThrow()
  expect(() => show(home, '.x')).toThrow()
  expect(() => conversationFile(home, 'a/b')).toThrow()
})

test('two front ends see both turns in order', async () => {
  const gates: (() => void)[] = []
  const m = fakeModel(
    (_c, n) =>
      new Promise<ModelResult>(res => {
        gates[n - 1] = () => res(ok({ session: `s-${n}` }))
      }),
  )
  const ctx = ctxOf(m.chatModel)
  const p1 = send(ctx, { id: 'q', text: 'a', front: 'web' })
  const p2 = send(ctx, { id: 'q', text: 'b', front: 'cli' })
  await Bun.sleep(30)
  expect(m.calls.length).toBe(1)
  gates[0]!()
  await p1
  await Bun.sleep(30)
  expect(m.calls.length).toBe(2)
  expect(m.calls[1]!.resume).toBe('s-1')
  gates[1]!()
  await p2
  expect(shown('q').turns.map(t => [t.who, t.front])).toEqual([
    ['person', 'web'],
    ['manager', 'web'],
    ['person', 'cli'],
    ['manager', 'cli'],
  ])
  expect(queue.has(conversationFile(home, 'q'))).toBe(false)
})

test('a failed model call gives code 1 and the next turn still runs', async () => {
  const m = fakeModel((_c, n) => {
    if (n === 1) throw new Error('boom')
    return ok()
  })
  const ctx = ctxOf(m.chatModel)
  const p1 = send(ctx, { id: 'f', text: 'a', front: 'cli' })
  const p2 = send(ctx, { id: 'f', text: 'b', front: 'cli' })
  const r1 = await p1
  expect(r1.code).toBe(1)
  expect(r1.err).toContain('factory: the manager turn failed: ')
  expect(r1.err).toContain('boom')
  expect((await p2).code).toBe(0)
  const t = lines('f')
  expect(t[1].reason).toBe('spawn-failed')
  expect(t[1].error).toContain('boom')
  expect(t.length).toBe(4)
})

test('a model result that is not ok is recorded and fails the turn', async () => {
  const m = fakeModel(() =>
    ok({ isOk: false, text: '', error: 'limit', reason: 'error_max_turns', session: undefined }),
  )
  const r = await send(ctxOf(m.chatModel), { id: 'g', text: 'a', front: 'cli' })
  expect(r).toMatchObject({ code: 1, err: 'factory: the manager turn failed: limit\n' })
  expect(lines('g')[1]).toMatchObject({ error: 'limit', reason: 'error_max_turns' })
})

test('different conversations do not wait for each other', async () => {
  let release: () => void = () => {}
  const m = fakeModel((_c, n) =>
    n === 1 ? new Promise<ModelResult>(res => (release = () => res(ok()))) : Promise.resolve(ok()),
  )
  const ctx = ctxOf(m.chatModel)
  const p1 = send(ctx, { id: 'x1', text: 'a', front: 'cli' })
  await Bun.sleep(20)
  await send(ctx, { id: 'x2', text: 'b', front: 'cli' })
  expect(m.calls.length).toBe(2)
  release()
  await p1
})

test('the turn runs with the chat guard', async () => {
  const m = fakeModel()
  const env = { PATH: '/bin', X: '1' }
  await send(ctxOf(m.chatModel, env), { id: 'h', text: 'a', front: 'cli' })
  const c = m.calls[0]!
  expect(c.tools).toBe('Bash,Read,Grep,Glob,Write')
  expect(c.settings).toEqual({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `'${CLI}' chat-guard` }] }],
    },
  })
  expect(c.baseEnv).toBe(env)
  expect(c.env).toEqual({ FACTORY_HOME: home, FACTORY_MAIN_CHAT: '1' })
  expect(c.input).toBe('a')
})

const hook = (command: unknown, args: string[] = [], h = home) =>
  guardHook(JSON.stringify({ tool_input: { command } }), h, args)

test('guardHook allows, asks, denies and fails closed', () => {
  expect(hook('/repo/bin/factory status')).toEqual({ code: 0, err: '' })
  const ask = '/repo/bin/factory decide lifecycle-abc ship "looks good"'
  const v = check(ask, 'manager')
  if (v.decision !== 'ask') throw new Error('the fixture must ask')
  expect(hook(ask)).toEqual({
    code: 2,
    err: v.question + '\nthe person must approve this command; a chat turn cannot run it: tell the person\n',
  })
  const deny = '/repo/bin/factory mail r1 plan "$(id)"'
  const d = check(deny, 'manager')
  if (d.decision !== 'deny') throw new Error('the fixture must deny')
  expect(hook(deny)).toEqual({ code: 2, err: d.reason + '\n' })
  for (const bad of ['{}', 'x', JSON.stringify({ tool_input: { command: 5 } })])
    expect(guardHook(bad)).toEqual({ code: 2, err: 'the hook input has no Bash command\n' })
})

test('asks lists the commands that need approval', async () => {
  const ask = '/repo/bin/factory decide lifecycle-abc ship "looks good"'
  const calls = [
    { id: 't1', command: 'factory status' },
    { id: 't2', command: ask },
  ]
  const m = fakeModel(() => ok({ calls }))
  await send(ctxOf(m.chatModel), { id: 'k', text: 'a', front: 'cli' })
  const v = check(ask, 'manager')
  if (v.decision !== 'ask') throw new Error('the fixture must ask')
  const t = lines('k')[1]
  expect(t.commands).toEqual(calls)
  expect(t.asks).toEqual([{ id: 't2', question: v.question }])
})

test('a worker or a patrol cannot send', async () => {
  for (const [env, err] of [
    [{ FACTORY_RUN: 'r' }, 'factory: a worker cannot run factory chat ('],
    [{ FACTORY_FROM: 'r' }, 'factory: a worker cannot run factory chat ('],
    [{ FACTORY_DEF_NAME: 'r' }, 'factory: a worker cannot run factory chat ('],
    [{ BEADS_ACTOR: 'factory/x' }, 'factory: a worker cannot run factory chat ('],
    [{ FACTORY_PATROL: '1' }, 'factory: a patrol cannot run factory chat: '],
  ] as const) {
    const m = fakeModel()
    const r = await send(ctxOf(m.chatModel, env), { id: 'w', text: 'a', front: 'cli' })
    expect([r.code, r.err.startsWith(err)]).toEqual([1, true])
    expect(m.calls.length).toBe(0)
    expect(existsSync(join(home, 'conversations', 'w.jsonl'))).toBe(false)
  }
})

test('a turn with usage adds a chat row to manager-usage.jsonl', async () => {
  const usage = {
    model: 'm',
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
  }
  const m = fakeModel(() => ok({ usage }))
  await send(ctxOf(m.chatModel), { id: 'u', text: 'a', front: 'cli' })
  const rows = readFileSync(join(home, 'manager-usage.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    name: 'chat',
    model: 'm',
    input: 1,
    cacheWrite: 4,
    cacheRead: 3,
    output: 2,
  })
})

const N = 'a'.repeat(32)
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const ASK = '/repo/bin/factory decide lifecycle-abc ship "looks good"'
const DENY = '/repo/bin/factory mail r1 plan "$(id)"'
const askOf = (c: string) => {
  const v = check(c, 'manager')
  if (v.decision !== 'ask') throw new Error('the fixture must ask')
  return v.question
}
const askRow = (id: string, c: string) => ({
  commands: [{ id, command: c }],
  asks: [{ id, question: askOf(c) }],
})
const hookArgs = (c: ModelCall): string[] => {
  const cmd = (c.settings as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }).hooks
    .PreToolUse[0]!.hooks[0]!.command
  return cmd.split('chat-guard')[1]!.split(' ').filter(Boolean)
}
const approveFile = (id: string) => join(home, 'conversations', `${id}.approve`)
const raw = (id: string) => readFileSync(join(home, 'conversations', `${id}.jsonl`), 'utf8')
const ASK_MSG = (c: string) =>
  askOf(c) + '\nthe person must approve this command; a chat turn cannot run it: tell the person\n'
const REFUSED = 'factory: the approval is refused: '

test('approve: the hook runs the approved command one time', async () => {
  seed('c', [mgr('s-1', askRow('t2', ASK))])
  const seen: ReturnType<typeof hook>[] = []
  const m = fakeModel(c => {
    const a = hookArgs(c)
    seen.push(hook(ASK, a), hook(ASK, a))
    return ok()
  })
  const r = await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve: 't2' })
  expect(r.code).toBe(0)
  expect(seen).toEqual([
    { code: 0, err: '' },
    { code: 2, err: ASK_MSG(ASK) },
  ])
  const p = lines('c').find(t => t.who === 'person')
  expect(p).toMatchObject({ text: 'yes', approve: 't2' })
  expect(m.calls[0]!.input.startsWith('yes')).toBe(true)
  expect(m.calls[0]!.input.endsWith(ASK)).toBe(true)
  expect(m.calls[0]!.input).toContain('The person approved one run of this exact command in this turn:')
})

test('approve: a rewritten approval file does not allow a second run', async () => {
  seed('c', [mgr('s-1', askRow('t2', ASK))])
  const seen: number[] = []
  const m = fakeModel(c => {
    const a = hookArgs(c)
    const saved = readFileSync(approveFile('c'), 'utf8')
    seen.push(hook(ASK, a).code)
    writeFileSync(approveFile('c'), saved) // the model has the Write tool
    seen.push(hook(ASK, a).code)
    return ok()
  })
  await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve: 't2' })
  expect(seen).toEqual([0, 2])
  expect(readdirSync(join(home, 'conversations')).filter(f => f.endsWith('.used'))).toEqual([])
})

test('approve: two hooks at once run the command one time', async () => {
  seed('c', [mgr('s-1', askRow('t2', ASK))])
  let codes: number[] = []
  const m = fakeModel(async c => {
    const a = hookArgs(c)
    codes = (await Promise.all([1, 2, 3].map(async () => hook(ASK, a)))).map(r => r.code)
    return ok()
  })
  await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve: 't2' })
  expect(codes.filter(x => x === 0)).toHaveLength(1)
})

test('approve: only the exact text runs', async () => {
  const L = '/repo/bin/factory decide lifecycle-abc ship "' + 'a'.repeat(400) + '"'
  const M = L.slice(0, -2) + 'b"'
  expect(askOf(L)).toBe(askOf(M))
  seed('c', [mgr('s-1', askRow('t2', L))])
  const seen: number[] = []
  const m = fakeModel(c => {
    const a = hookArgs(c)
    seen.push(hook(M, a).code, hook(L + ' ', a).code, hook(L, a).code, hook(L, a).code)
    return ok()
  })
  await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve: 't2' })
  expect(seen).toEqual([2, 2, 0, 2])
})

test('approve: a deny stays denied', async () => {
  seed('c', [mgr('s-1', { commands: [{ id: 't3', command: DENY }], asks: [{ id: 't3', question: 'q' }] })])
  const before = raw('c')
  const m = fakeModel()
  const r = await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve: 't3' })
  expect(r.code).toBe(1)
  expect(r.err).toContain(REFUSED)
  expect(m.calls.length).toBe(0)
  expect(raw('c')).toBe(before)
  expect(existsSync(approveFile('c'))).toBe(false)
  // the hook itself
  writeFileSync(approveFile('c'), sha(DENY))
  const d = check(DENY, 'manager')
  if (d.decision !== 'deny') throw new Error('the fixture must deny')
  expect(hook(DENY, ['c', sha(DENY), N])).toEqual({ code: 2, err: d.reason + '\n' })
  expect(existsSync(approveFile('c'))).toBe(true)
})

test('approve: bad ids are refused with no side effect', async () => {
  const cases: [string, string[]][] = [
    ['unknown', [mgr('s-1', askRow('t2', ASK))]],
    ['t1', [mgr('s-1', askRow('t1', ASK)), mgr('s-1', askRow('t2', ASK))]],
    ['t1', [mgr('s-1', { commands: [{ id: 't1', command: 'factory status' }], asks: [] })]],
    [
      't2',
      [mgr('s-1', { commands: [{ id: 't2', command: ASK }], asks: [{ id: 't2', question: 'forged' }] })],
    ],
    ['t2', [JSON.stringify({ who: 'person', text: 'x', front: 'cli', at: 1 })]],
  ]
  for (const [approve, rows] of cases) {
    seed('c', rows)
    const before = raw('c')
    const m = fakeModel()
    const r = await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve })
    expect([r.code, r.err.startsWith(REFUSED)]).toEqual([1, true])
    expect(m.calls.length).toBe(0)
    expect(raw('c')).toBe(before)
    expect(existsSync(approveFile('c'))).toBe(false)
  }
  rmSync(join(home, 'conversations'), { recursive: true, force: true })
  const m = fakeModel()
  const r = await send(ctxOf(m.chatModel), { id: 'n', text: 'yes', front: 'web', approve: 't2' })
  expect(r.code).toBe(1)
  expect(existsSync(join(home, 'conversations'))).toBe(false)
})

test('approve: malformed stored entries are refused', async () => {
  for (const extra of [
    { asks: 'x', commands: [{ id: 't2', command: ASK }] },
    { asks: [{ id: 't2', question: 5 }], commands: [{ id: 't2', command: ASK }] },
    { asks: [{ id: 't2', question: askOf(ASK) }], commands: [{ id: 't2', command: 5 }] },
  ]) {
    seed('c', [mgr('s-1', extra)])
    const m = fakeModel()
    const r = await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve: 't2' })
    expect([r.code, r.err.startsWith(REFUSED)]).toEqual([1, true])
    expect(m.calls.length).toBe(0)
  }
})

test('approve: the approval lasts one turn and the core cleans up', async () => {
  seed('c', [mgr('s-1', askRow('t2', ASK))])
  const m = fakeModel()
  const ctx = ctxOf(m.chatModel)
  await send(ctx, { id: 'c', text: 'yes', front: 'web', approve: 't2' })
  expect(existsSync(approveFile('c'))).toBe(false)
  await send(ctx, { id: 'c', text: 'again', front: 'web' })
  expect(hookArgs(m.calls[1]!)).toEqual([])
  expect(m.calls[1]!.input).toBe('again')
  expect(hook(ASK, hookArgs(m.calls[1]!)).code).toBe(2)
  // the model call throws
  seed('d', [mgr('s-1', askRow('t2', ASK))])
  const t = fakeModel(() => {
    throw new Error('boom')
  })
  await send(ctxOf(t.chatModel), { id: 'd', text: 'yes', front: 'web', approve: 't2' })
  expect(existsSync(approveFile('d'))).toBe(false)
})

test('approve: the hook argument grammar fails closed', () => {
  const h = sha(ASK)
  for (const args of [
    ['c'],
    ['c', h],
    ['c', h, 'x'],
    ['c', h, N, N],
    ['c', h.toUpperCase()],
    ['c', h.slice(1)],
    ['../x', h, N],
  ])
    for (const c of ['/repo/bin/factory status', ASK])
      expect(hook(c, args)).toEqual({ code: 2, err: 'bad chat-guard arguments\n' })
  expect(guardHook('{}', home, ['c'])).toEqual({ code: 2, err: 'bad chat-guard arguments\n' })
})

test('approve: the hook does not throw on a bad approval file', () => {
  const args = ['c', sha(ASK), N]
  mkdirSync(join(home, 'conversations'), { recursive: true })
  expect(hook(ASK, args).code).toBe(2) // missing
  writeFileSync(approveFile('c'), sha('other'))
  expect(hook(ASK, args).code).toBe(2) // another hash
  rmSync(approveFile('c'))
  mkdirSync(approveFile('c'))
  expect(hook(ASK, args).code).toBe(2) // a folder
})

test('approve: a write failure records no person turn', async () => {
  seed('c', [mgr('s-1', askRow('t2', ASK))])
  const before = raw('c')
  mkdirSync(approveFile('c'))
  writeFileSync(join(approveFile('c'), 'x'), 'x')
  const m = fakeModel()
  const r = await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve: 't2' })
  expect(r.code).toBe(1)
  expect(m.calls.length).toBe(0)
  expect(raw('c')).toBe(before)
})

test('approve: a cleanup failure does not hide the manager turn', async () => {
  seed('c', [mgr('s-1', askRow('t2', ASK))])
  const m = fakeModel(() => {
    rmSync(approveFile('c'), { force: true })
    mkdirSync(approveFile('c'))
    writeFileSync(join(approveFile('c'), 'x'), 'x')
    return ok()
  })
  const r = await send(ctxOf(m.chatModel), { id: 'c', text: 'yes', front: 'web', approve: 't2' })
  expect(r.code).toBe(0)
  expect(lines('c').at(-1)).toMatchObject({ who: 'manager', text: 'answer' })
})

test('a half line at the end of the file does not hide the real manager turn', async () => {
  mkdirSync(join(home, 'conversations'), { recursive: true })
  writeFileSync(join(home, 'conversations', 'c.jsonl'), '{"who":"manager"')
  const m = fakeModel()
  await send(ctxOf(m.chatModel), { id: 'c', text: 'x', front: 'cli' })
  const t = shown('c').turns
  expect(t.at(-1)).toMatchObject({ who: 'manager', text: 'answer' })
  expect(t.length).toBe(2)
})
