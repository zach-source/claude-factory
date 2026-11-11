import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelCall, ModelResult } from '../once'
import { CLI, conversationFile, guardHook, queue, runApproved, send, show } from './chat'
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

const ctxOf = (
  chatModel: Port['chatModel'],
  env: Env = {},
  chatRun: Port['chatRun'] = async () => ({ code: 0, out: '' }),
): Ctx => ({
  home,
  env,
  port: { chatModel, chatRun } as Port,
  board: () => ({}),
  cli: async () => ({ code: 0, out: '', err: '' }),
})

const lines = (id: string) =>
  readFileSync(join(home, 'conversations', `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

const shown = (id: string) => show(home, id)

test('wua3v chat excludes project sources on every turn', async () => {
  const m = fakeModel()
  const env = { PATH: '/bin', X: '1' }
  const ctx = ctxOf(m.chatModel, env)
  for (const text of ['first', 'resume']) {
    expect((await send(ctx, { id: 'sources', text, front: 'cli' })).code).toBe(0)
    const c = m.calls.at(-1)!
    expect(c).toMatchObject({
      settingSources: 'user',
      tools: 'Bash,Read,Grep,Glob,Write',
      cwd: home,
      persist: true,
      input: text,
      env: { FACTORY_HOME: home, FACTORY_MAIN_CHAT: '1' },
      settings: {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `'${CLI}' chat-guard` }] }],
        },
      },
    })
    expect(c.baseEnv).toBe(env)
  }
  expect(m.calls[0]!.resume).toBeUndefined()
  expect(m.calls[1]!.resume).toBe('s-1')
})

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

const hook = (command: unknown) => guardHook(JSON.stringify({ tool_input: { command } }))

test('guardHook allows, asks, denies and fails closed', async () => {
  expect(await hook('/repo/bin/factory status')).toEqual({ code: 0, err: '' })
  const ask = '/repo/bin/factory decide lifecycle-abc ship "looks good"'
  const v = check(ask, 'manager')
  if (v.decision !== 'ask') throw new Error('the fixture must ask')
  expect(await hook(ask)).toEqual({
    code: 2,
    err: v.question + '\nthe person must approve this command; a chat turn cannot run it: tell the person\n',
  })
  const deny = '/repo/bin/factory mail r1 plan "$(id)"'
  const d = check(deny, 'manager')
  if (d.decision !== 'deny') throw new Error('the fixture must deny')
  expect(await hook(deny)).toEqual({ code: 2, err: d.reason + '\n' })
  for (const bad of ['{}', 'x', JSON.stringify({ tool_input: { command: 5 } })])
    expect(await guardHook(bad)).toEqual({ code: 2, err: 'the hook input has no Bash command\n' })
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
const raw = (id: string) => readFileSync(conversationFile(home, id), 'utf8')
const REFUSED = 'factory: the approval is refused: '
const marker = (id = 'c') => join(home, 'conversations', id + '.approved')
const fakeRun = (next: Port['chatRun'] = async () => ({ code: 3, out: 'result' }), order: string[] = []) => {
  const calls: Parameters<Port['chatRun']>[0][] = []
  const chatRun: Port['chatRun'] = async c => {
    calls.push(c)
    order.push('run')
    return next(c)
  }
  return { calls, chatRun }
}

test('approve: the core runs the exact command before the model, once', async () => {
  seed('c', [mgr('s-1', askRow('t2', ASK))])
  const order: string[] = []
  const r = fakeRun(undefined, order)
  const m = fakeModel(async c => {
    order.push('model')
    expect(c.settings).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `'${CLI}' chat-guard` }] }],
      },
    })
    expect((await hook(ASK)).code).toBe(2)
    return ok()
  })
  const ctx = ctxOf(m.chatModel, { PATH: '/bin', FACTORY_MAIN_CHAT: '1', FACTORY_ALLOW: 'x' }, r.chatRun)
  const sent = await send(ctx, { id: 'c', text: 'yes', front: 'web', approve: 't2', command: ASK })
  expect(sent.code).toBe(0)
  expect(order).toEqual(['run', 'model'])
  expect(r.calls).toEqual([
    { command: ASK, cwd: home, env: { PATH: '/bin', FACTORY_HOME: home }, timeoutMs: 300000 },
  ])
  expect(m.calls[0]!.env).toMatchObject({ FACTORY_MAIN_CHAT: '1' })
  expect(m.calls[0]!.input).toContain(ASK)
  expect(m.calls[0]!.input).toContain('exit 3')
  expect(m.calls[0]!.input).toContain('result')
  expect(lines('c').at(-2)).toMatchObject({ text: 'yes', approve: 't2' })
  expect(shown('c').turns.at(-1)!.ran).toEqual({ id: 't2', command: ASK, code: 3, out: 'result' })
  expect(existsSync(join(marker(), 't2'))).toBe(true)
  const again = await send(ctx, { id: 'c', text: 'yes', front: 'web', approve: 't2', command: ASK })
  expect(again.err).toContain(REFUSED + 'the last manager turn has no ask t2')
  expect(r.calls).toHaveLength(1)
  await send(ctx, { id: 'c', text: 'next', front: 'web' })
  expect(m.calls.at(-1)!.input).toBe('next')
  expect(r.calls).toHaveLength(1)
})

test('approve: equal questions do not select another command', async () => {
  const L = '/repo/bin/factory decide lifecycle-abc ship "' + 'a'.repeat(400) + '"'
  const M = L.slice(0, -2) + 'b"'
  expect(askOf(L)).toBe(askOf(M))
  seed('c', [
    mgr('s-1', {
      commands: [
        { id: 't2', command: L },
        { id: 't3', command: M },
      ],
      asks: [
        { id: 't2', question: askOf(L) },
        { id: 't3', question: askOf(M) },
      ],
    }),
  ])
  const r = fakeRun()
  await send(ctxOf(fakeModel().chatModel, {}, r.chatRun), {
    id: 'c',
    text: 'yes',
    front: 'web',
    approve: 't3',
    command: M,
  })
  expect(r.calls.map(c => c.command)).toEqual([M])
})

test('approve: a command that changed after show, or no shown command, is refused', async () => {
  const L = '/repo/bin/factory decide lifecycle-abc ship "' + 'a'.repeat(400) + '"'
  const M = L.slice(0, -2) + 'b"'
  expect(askOf(L)).toBe(askOf(M))
  for (const shownText of [L, undefined]) {
    seed('c', [mgr('s-1', askRow('t2', L))])
    const seen = shownText
    // a model turn replaces the stored command, with the same id and question
    seed('c', [
      mgr('s-1', { commands: [{ id: 't2', command: M }], asks: [{ id: 't2', question: askOf(L) }] }),
    ])
    const before = raw('c')
    const m = fakeModel()
    const r = fakeRun()
    const sent = await send(ctxOf(m.chatModel, {}, r.chatRun), {
      id: 'c',
      text: 'yes',
      front: 'web',
      approve: 't2',
      command: seen,
    })
    expect(sent.err).toContain(REFUSED + 'the command differs from the one shown')
    expect([m.calls.length, r.calls.length]).toEqual([0, 0])
    expect(raw('c')).toBe(before)
    expect(existsSync(marker())).toBe(false)
  }
})

test('approve: denied and allowed commands refuse approval', async () => {
  for (const [command, reason] of [
    [DENY, 'the command is denied'],
    ['factory status', 'the command needs no approval'],
  ]) {
    seed('c', [mgr('s-1', { commands: [{ id: 't3', command }], asks: [{ id: 't3', question: 'q' }] })])
    const before = raw('c')
    const m = fakeModel()
    const r = fakeRun()
    const sent = await send(ctxOf(m.chatModel, {}, r.chatRun), {
      id: 'c',
      text: 'yes',
      front: 'web',
      approve: 't3',
      command: command,
    })
    expect(sent.err).toContain(REFUSED + reason)
    expect([m.calls.length, r.calls.length]).toEqual([0, 0])
    expect(raw('c')).toBe(before)
    expect(existsSync(marker())).toBe(false)
  }
  const d = check(DENY, 'manager')
  if (d.decision !== 'deny') throw new Error('the fixture must deny')
  expect(await hook(DENY)).toEqual({ code: 2, err: d.reason + '\n' })
})

test('approve: bad ids are refused with no side effect', async () => {
  const cases: [string, string[], string][] = [
    ...['../x', 'a/b', '', 'a'.repeat(129), '.x'].map(
      id => [id, [mgr('s-1', askRow(id, ASK))], 'bad id'] as [string, string[], string],
    ),
    ['unknown', [mgr('s-1', askRow('t2', ASK))], 'no ask unknown'],
    ['t1', [mgr('s-1', askRow('t1', ASK)), mgr('s-1', askRow('t2', ASK))], 'no ask t1'],
    ['t1', [mgr('s-1', { commands: [{ id: 't1', command: 'factory status' }], asks: [] })], 'no ask t1'],
    [
      't2',
      [mgr('s-1', { commands: [{ id: 't2', command: ASK }], asks: [{ id: 't2', question: 'forged' }] })],
      'question does not match',
    ],
    ['t2', [JSON.stringify({ who: 'person', text: 'x', front: 'cli', at: 1 })], 'no manager turn'],
  ]
  for (const [approve, rows, reason] of cases) {
    seed('c', rows)
    const before = raw('c')
    const m = fakeModel()
    const r = fakeRun()
    const sent = await send(ctxOf(m.chatModel, {}, r.chatRun), {
      id: 'c',
      text: 'yes',
      front: 'web',
      approve,
      command: ASK,
    })
    expect(sent.code).toBe(1)
    expect(sent.err).toContain(REFUSED)
    expect(sent.err).toContain(reason)
    expect([m.calls.length, r.calls.length]).toEqual([0, 0])
    expect(raw('c')).toBe(before)
    expect(existsSync(marker())).toBe(false)
  }
  rmSync(join(home, 'conversations'), { recursive: true, force: true })
  const m = fakeModel()
  const r = fakeRun()
  expect(
    (
      await send(ctxOf(m.chatModel, {}, r.chatRun), {
        id: 'n',
        text: 'yes',
        front: 'web',
        approve: 't2',
        command: ASK,
      })
    ).code,
  ).toBe(1)
  expect([m.calls.length, r.calls.length]).toEqual([0, 0])
  expect(existsSync(join(home, 'conversations'))).toBe(false)
})

test('approve: malformed stored entries are refused', async () => {
  for (const extra of [
    { asks: 'x', commands: [{ id: 't2', command: ASK }] },
    { asks: [{ id: 't2', question: 5 }], commands: [{ id: 't2', command: ASK }] },
    { asks: [{ id: 't2', question: askOf(ASK) }], commands: [{ id: 't2', command: 5 }] },
  ]) {
    seed('c', [mgr('s-1', extra)])
    const before = raw('c')
    const m = fakeModel()
    const r = fakeRun()
    const sent = await send(ctxOf(m.chatModel, {}, r.chatRun), {
      id: 'c',
      text: 'yes',
      front: 'web',
      approve: 't2',
      command: ASK,
    })
    expect([sent.code, sent.err.startsWith(REFUSED)]).toEqual([1, true])
    expect([m.calls.length, r.calls.length]).toEqual([0, 0])
    expect(raw('c')).toBe(before)
    expect(existsSync(marker())).toBe(false)
  }
})

test('approve: a used marker and a failed marker directory refuse before the person turn', async () => {
  for (const id of ['c', 'd']) seed(id, [mgr('s-1', askRow('t2', ASK))])
  mkdirSync(marker())
  writeFileSync(join(marker(), 't2'), '')
  writeFileSync(marker('d'), '')
  for (const [id, reason] of [
    ['c', 'ask t2 already ran'],
    ['d', 'cannot record the use'],
  ]) {
    const before = raw(id!)
    const m = fakeModel()
    const r = fakeRun()
    const sent = await send(ctxOf(m.chatModel, {}, r.chatRun), {
      id: id!,
      text: 'yes',
      front: 'web',
      approve: 't2',
      command: ASK,
    })
    expect(sent.err).toContain(REFUSED + reason)
    expect([m.calls.length, r.calls.length]).toEqual([0, 0])
    expect(raw(id!)).toBe(before)
  }
})

test('approve: run and model errors retain the result and marker', async () => {
  for (const fail of ['run', 'model']) {
    seed(fail, [mgr('s-1', askRow('t2', ASK))])
    const r = fakeRun(async () => {
      if (fail === 'run') throw new Error('boom')
      return { code: 0, out: 'done' }
    })
    const m = fakeModel(() => {
      if (fail === 'model') throw new Error('model error')
      return ok()
    })
    const ctx = ctxOf(m.chatModel, {}, r.chatRun)
    await send(ctx, { id: fail, text: 'yes', front: 'web', approve: 't2', command: ASK })
    const ran = shown(fail).turns.at(-1)!.ran
    expect(ran?.code).toBe(fail === 'run' ? 127 : 0)
    expect(ran?.out).toContain(fail === 'run' ? 'boom' : 'done')
    expect(m.calls).toHaveLength(1)
    expect(existsSync(join(marker(fail), 't2'))).toBe(true)
    expect(
      (await send(ctx, { id: fail, text: 'again', front: 'web', approve: 't2', command: ASK })).code,
    ).toBe(1)
    expect(r.calls).toHaveLength(1)
  }
})

test('runApproved returns the exit code and both output streams', async () => {
  const r = await runApproved({
    command: 'echo out; echo err >&2; echo "[$FACTORY_MAIN_CHAT]"; exit 3',
    cwd: home,
    env: { PATH: process.env.PATH },
    timeoutMs: 2000,
  })
  expect(r.code).toBe(3)
  for (const text of ['out', 'err', '[]']) expect(r.out).toContain(text)
})

test('runApproved reports a signal exit as code 128', async () => {
  const r = await runApproved({
    command: 'kill -TERM $$',
    cwd: home,
    env: { PATH: process.env.PATH },
    timeoutMs: 2000,
  })
  expect(r.code).toBe(128)
})

test('runApproved keeps the last 4000 characters', async () => {
  const r = await runApproved({
    command: "printf 'a%.0s' $(seq 2000); printf 'b%.0s' $(seq 4000)",
    cwd: home,
    env: { PATH: process.env.PATH },
    timeoutMs: 2000,
  })
  expect(r.out).toBe('b'.repeat(4000))
})

test('runApproved rejects a bad cwd without a later timer error', async () => {
  await expect(
    runApproved({
      command: 'echo x',
      cwd: join(home, 'absent'),
      env: { PATH: process.env.PATH },
      timeoutMs: 100,
    }),
  ).rejects.toThrow()
  await Bun.sleep(500)
})

for (const command of ['sleep 5', 'sleep 5; echo x'])
  test(
    'runApproved kills the process group: ' + command,
    async () => {
      const start = Date.now()
      const r = await runApproved({ command, cwd: home, env: { PATH: process.env.PATH }, timeoutMs: 200 })
      expect(r).toEqual({ code: 124, out: '' })
      expect(Date.now() - start).toBeLessThan(2000)
    },
    10000,
  )

test('a half line at the end of the file does not hide the real manager turn', async () => {
  mkdirSync(join(home, 'conversations'), { recursive: true })
  writeFileSync(join(home, 'conversations', 'c.jsonl'), '{"who":"manager"')
  const m = fakeModel()
  await send(ctxOf(m.chatModel), { id: 'c', text: 'x', front: 'cli' })
  const t = shown('c').turns
  expect(t.at(-1)).toMatchObject({ who: 'manager', text: 'answer' })
  expect(t.length).toBe(2)
})
