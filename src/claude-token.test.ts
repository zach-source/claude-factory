import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bestSlot,
  bestUse,
  listSlots,
  MISSING_HELP,
  parseUsage,
  probe,
  slotRows,
  tokenConfig,
  useSlot,
  type Fetch,
  type Slot,
} from './claude-token'

// bin/claude-token with fake op and curl on PATH, and a jq wrapper that logs its argv
const SCRIPT = join(import.meta.dir, '..', 'bin', 'claude-token')

test('bestSlot selects only allowed slots without a change to its input', () => {
  const slot = (n: number, status: Slot['status'], use7d?: number): Slot => ({
    n,
    status,
    use7d,
    hasToken: true,
    live: false,
  })
  const cases: [Slot[], number | undefined][] = [
    [[], undefined],
    [[slot(1, 'refused', 0.1), slot(2, 'ok', 0.9)], 2],
    [[slot(2, 'ok', 0.2), slot(1, 'ok', 0.2)], 1],
    [[slot(1, 'ok'), slot(2, 'ok', 0)], 2],
    [[slot(2, 'ok', 0), slot(1, 'ok')], 2],
    [[slot(1, 'error', 0), slot(2, 'empty', 0)], undefined],
    [[slot(2, 'ok'), slot(1, 'ok')], 1],
    [[slot(1, 'ok', 0.8), slot(2, 'ok', 0.1)], 2],
  ]
  for (const [slots, expected] of cases) {
    const before = structuredClone(slots)
    expect(bestSlot(slots)).toBe(expected)
    expect(slots).toEqual(before)
  }
})

test('parseUsage reads headers and refuses unknown status', () => {
  for (const [value, status] of [
    ['allowed', 'ok'],
    ['allowed_warning', 'ok'],
    ['rejected', 'refused'],
    ['blocked', 'error'],
    ['', 'error'],
  ]) {
    expect(String(parseUsage(new Headers({ 'Anthropic-Ratelimit-Unified-Status': value! })).status)).toBe(
      status!,
    )
  }
  expect(parseUsage(new Headers()).status).toBe('error')
  for (const value of ['abc', '', '  ']) {
    expect(
      parseUsage(new Headers({ 'anthropic-ratelimit-unified-7d-utilization': value })).use7d,
    ).toBeUndefined()
  }
  expect(parseUsage(new Headers()).use7d).toBeUndefined()
  expect(
    parseUsage(
      new Headers({
        'Anthropic-Ratelimit-Unified-7d-Utilization': '0',
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
      }),
    ),
  ).toEqual({ status: 'error', use7d: 0, use5h: 0.5 })
})

test('tokenConfig requires all store keys and one slot placeholder', () => {
  const stored = {
    'token.read': ' read ',
    'token.write': 'write',
    'token.live-field': 'live',
    'token.slot-field': 'account_%s_token',
    'token.active-field': 'active',
  }
  expect(() => tokenConfig({})).toThrow(
    'token.read, token.write, token.live-field, token.slot-field, token.active-field',
  )
  expect(() => tokenConfig({})).toThrow(MISSING_HELP)
  expect(() => tokenConfig({ ...stored, 'token.read': '  ' })).toThrow('missing: token.read')
  for (const value of ['slot', '%s_%s'])
    expect(() => tokenConfig({ ...stored, 'token.slot-field': value })).toThrow('exactly one time')
  expect(tokenConfig(stored)).toEqual({
    read: ' read ',
    write: 'write',
    liveField: 'live',
    slotField: 'account_%s_token',
    activeField: 'active',
  })
})

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-token-'))
  const bin = join(tmp, 'bin')
  mkdirSync(bin)
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`)
    chmodSync(join(bin, name), 0o755)
  }
  const log = `echo "$0 $*" >> "${tmp}/argv.log"\n`
  fake(
    'op',
    `${log}if [ "$2" = edit ]; then printf '%s\\n' "$*" >> "${tmp}/op.log"; cat > "${tmp}/stdin.log"; [ ! -e "${tmp}/op.fail" ] || exit 1; exit 0; fi\ncat "${tmp}/item.json"\n`,
  )
  fake('jq', `${log}exec "${Bun.which('jq')}" "$@"\n`)
  // curl -H @-: the bearer comes on stdin; the response headers are rl-<token>.txt
  fake(
    'curl',
    `${log}h=$(cat); t=$(printf '%s' "$h" | sed -n 's/^authorization: Bearer //p')\ncat "${tmp}/rl-$t.txt"\n`,
  )
  const rl = (token: string, d: number, h: number, status: string) =>
    writeFileSync(
      join(tmp, `rl-${token}.txt`),
      `HTTP/2 200\r\nanthropic-ratelimit-unified-7d-utilization: ${d}\r\nanthropic-ratelimit-unified-5h-utilization: ${h}\r\nanthropic-ratelimit-unified-status: ${status}\r\n`,
    )
  writeFileSync(
    join(tmp, 'item.json'),
    JSON.stringify({
      title: 'T',
      fields: [
        { label: 'account_1_token', value: 'zqsecret-1' },
        { label: 'account_2_token', value: 'zqsecret-2' },
        { label: 'live', value: 'old' },
        { label: 'active', value: '1' },
        { label: 'other', value: 'keep' },
      ],
    }),
  )
  rl('zqsecret-1', 0.5, 0.1, 'allowed')
  rl('zqsecret-2', 0.2, 0.1, 'allowed')
  const run = (args: string[]) => {
    const p = Bun.spawnSync(['bash', SCRIPT, ...args], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_TOKEN_ITEM: 'item',
        CLAUDE_TOKEN_VAULT: 'vault',
        CLAUDE_TOKEN_LIVE_FIELD: 'live',
        CLAUDE_TOKEN_SLOT_FIELD: 'account_%s_token',
        CLAUDE_TOKEN_ACTIVE_FIELD: 'active',
      },
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const read = (n: string) => (existsSync(join(tmp, n)) ? readFileSync(join(tmp, n), 'utf8') : '')
  const field = (l: string) =>
    JSON.parse(read('stdin.log')).fields.find((x: { label: string }) => x.label === l)
  return { tmp, rl, run, read, field, done: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('use writes the slot token and the slot number on stdin, never in argv', () => {
  const f = fixture()
  try {
    const r = f.run(['use', '2'])
    expect(r.code).toBe(0)
    expect(f.read('op.log').trim()).toBe('item edit item --vault vault')
    expect(f.field('live')).toEqual({ label: 'live', value: 'zqsecret-2', type: 'CONCEALED' })
    expect(f.field('active')).toEqual({ label: 'active', value: '2', type: 'CONCEALED' })
    expect(f.field('other')).toEqual({ label: 'other', value: 'keep' })
    expect(f.read('argv.log')).not.toContain('zqsecret')
    expect(r.out + r.err).not.toContain('zqsecret')
  } finally {
    f.done()
  }
})

test('best probes through stdin and picks the lowest 7d slot that is allowed', () => {
  const f = fixture()
  try {
    f.rl('zqsecret-2', 0.1, 0.1, 'rejected')
    const r = f.run(['best'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('slot 1 is live')
    expect(f.field('live').value).toBe('zqsecret-1')
    expect(f.read('argv.log')).not.toContain('zqsecret')
    expect(r.out + r.err).not.toContain('zqsecret')
  } finally {
    f.done()
  }
})

test('status shows each slot and no token', () => {
  const f = fixture()
  try {
    const r = f.run([])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/2\s+0.2\s+0.1\s+allowed/)
    expect(f.read('argv.log')).not.toContain('zqsecret')
    expect(r.out + r.err).not.toContain('zqsecret')
  } finally {
    f.done()
  }
})

test('use of an empty slot fails with no edit; an op failure leaks no token', () => {
  const f = fixture()
  try {
    expect(f.run(['use', '9']).code).toBe(1)
    expect(f.read('op.log')).toBe('')
    writeFileSync(join(f.tmp, 'op.fail'), '')
    const r = f.run(['use', '2'])
    expect(r.code).not.toBe(0)
    expect(f.read('argv.log')).not.toContain('zqsecret')
    expect(r.out + r.err).not.toContain('zqsecret')
  } finally {
    f.done()
  }
})

function storeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-token-ts-'))
  mkdirSync(join(tmp, 'store'))
  const put = (field: string, value: string) => writeFileSync(join(tmp, 'store', field), value)
  const read = (file: string) => (existsSync(join(tmp, file)) ? readFileSync(join(tmp, file), 'utf8') : '')
  const log = `printf '%s\\n' "$0 $*" >> '${tmp}/argv.log'\n`
  writeFileSync(join(tmp, 'read.sh'), `${log}[ -f '${tmp}/store/'"$1" ] || exit 1\ncat '${tmp}/store/'"$1"\n`)
  writeFileSync(
    join(tmp, 'write.sh'),
    `${log}printf '%s\\n' "$1" >> '${tmp}/writes.log'\n[ ! -e '${tmp}/write.fail' ] || exit 1\n[ "$1" != active ] || [ ! -e '${tmp}/active.fail' ] || exit 1\ncat > '${tmp}/store/'"$1"\n`,
  )
  const cfg = {
    read: `sh '${tmp}/read.sh' "$1"`,
    write: `sh '${tmp}/write.sh' "$1"`,
    liveField: 'live',
    slotField: 'account_%s_token',
    activeField: 'active',
  }
  for (const [field, value] of Object.entries({
    account_1_token: 'zqsecret-1',
    account_2_token: 'zqsecret-2',
    live: 'old',
    active: '1',
    other: 'keep',
  }))
    put(field, value)
  const headers = new Map<string, Headers>()
  const usage = (token: string, status: string, use7d?: string) =>
    headers.set(
      token,
      new Headers({
        'anthropic-ratelimit-unified-status': status,
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        ...(use7d === undefined ? {} : { 'anthropic-ratelimit-unified-7d-utilization': use7d }),
      }),
    )
  usage('zqsecret-1', 'allowed', '0.5')
  usage('zqsecret-2', 'allowed', '0.2')
  const calls: { url: string; init: RequestInit }[] = []
  let throws = false
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ url, init })
    if (throws) throw new Error('zqsecret-network')
    const token = new Headers(init.headers).get('authorization')!.slice(7)
    return new Response(null, { headers: headers.get(token) })
  }
  return {
    tmp,
    cfg,
    put,
    read,
    usage,
    calls,
    fetchFn,
    failFetch: () => {
      throws = true
    },
    done: () => {
      try {
        expect(read('argv.log')).not.toContain('zqsecret')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  }
}

const noSecret = (value: string) => {
  expect(value).not.toContain('zqsecret')
  return value
}
function safeError(fn: () => unknown, text: string) {
  try {
    fn()
  } catch (e) {
    expect(noSecret((e as Error).message)).toContain(text)
    return
  }
  throw new Error('expected an error')
}
async function safeReject(fn: () => Promise<unknown>, text: string) {
  try {
    await fn()
  } catch (e) {
    expect(noSecret((e as Error).message)).toContain(text)
    return
  }
  throw new Error('expected an error')
}

test('module use writes both fields (script: use writes the slot token and the slot number on stdin, never in argv)', () => {
  const f = storeFixture()
  try {
    expect(noSecret(useSlot(f.cfg, 2))).toBe('slot 2 is live; agent-vault picks it up within 5 minutes')
    expect(f.read('store/live')).toBe('zqsecret-2')
    expect(f.read('store/active')).toBe('2')
    expect(f.read('store/other')).toBe('keep')
    expect(f.read('writes.log')).toBe('live\nactive\n')
  } finally {
    f.done()
  }
})

test('module best skips refused slots (script: best probes through stdin and picks the lowest 7d slot that is allowed)', async () => {
  const f = storeFixture()
  try {
    f.usage('zqsecret-2', 'rejected', '0.1')
    expect(noSecret(await bestUse(f.cfg, f.fetchFn))).toContain('slot 1 is live')
    expect(f.read('store/live')).toBe('zqsecret-1')
    expect(f.calls).toHaveLength(2)
    for (const { url, init } of f.calls) {
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      expect(init.method).toBe('POST')
      expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer zqsecret-[12]$/)
      noSecret(JSON.stringify({ ...init, headers: { ...init.headers, authorization: undefined } }))
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    const reads = f
      .read('argv.log')
      .split('\n')
      .filter(line => line.includes('read.sh'))
    expect(reads.map(line => line.split(' ').at(-1))).toEqual([
      'account_1_token',
      'account_2_token',
      'account_3_token',
    ])
  } finally {
    f.done()
  }
})

test('module list shows safe rows (script: status shows each slot and no token)', async () => {
  const f = storeFixture()
  try {
    const result = await listSlots(f.cfg, f.fetchFn)
    const rows = slotRows(result)
    rows.forEach(noSecret)
    expect(rows[0]).toBe('live: slot 1')
    expect(rows[1]).toBe('slot  7d       5h       status')
    expect(rows[3]).toMatch(/^2\s+0.2\s+0.1\s+ok$/)
    expect(result.slots[0]!.live).toBe(true)
    expect(f.read('writes.log')).toBe('')
  } finally {
    f.done()
  }
})

test('module use refuses empty slots (script: use of an empty slot fails with no edit; an op failure leaks no token)', () => {
  const f = storeFixture()
  try {
    for (const n of [0, -1, 1.5, 1000, NaN]) safeError(() => useSlot(f.cfg, n), 'slot must be a number')
    expect(f.read('argv.log')).toBe('')
    safeError(() => useSlot(f.cfg, 9), 'cannot read slot 9')
    f.put('account_3_token', '')
    safeError(() => useSlot(f.cfg, 3), 'no token in slot 3')
    expect(f.read('writes.log')).toBe('')
    writeFileSync(join(f.tmp, 'write.fail'), '')
    safeError(() => useSlot(f.cfg, 2), 'token.write failed for field live (exit 1)')
    expect(f.read('store/live')).toBe('old')
  } finally {
    f.done()
  }
})

test('all refused or failed probes leave the live slot intact; missing usage sorts by slot', async () => {
  for (const failed of [false, true]) {
    const f = storeFixture()
    try {
      f.usage('zqsecret-1', 'rejected', '0.1')
      f.usage('zqsecret-2', 'rejected', '0.2')
      if (failed) f.failFetch()
      await safeReject(() => bestUse(f.cfg, f.fetchFn), 'no slot is allowed')
      expect(f.read('writes.log')).toBe('')
      expect(f.read('store/live')).toBe('old')
    } finally {
      f.done()
    }
  }
  const f = storeFixture()
  try {
    f.usage('zqsecret-1', 'allowed')
    f.usage('zqsecret-2', 'allowed')
    expect(noSecret(await bestUse(f.cfg, f.fetchFn))).toContain('slot 1 is live')
  } finally {
    f.done()
  }
})

test('a missing or empty first slot stops all probes and writes', async () => {
  for (const missing of [false, true]) {
    const f = storeFixture()
    try {
      if (missing) rmSync(join(f.tmp, 'store/account_1_token'))
      else f.put('account_1_token', '')
      await safeReject(() => listSlots(f.cfg, f.fetchFn), 'cannot read slot 1')
      await safeReject(() => bestUse(f.cfg, f.fetchFn), 'cannot read slot 1')
      expect(f.calls).toHaveLength(0)
      expect(f.read('writes.log')).toBe('')
    } finally {
      f.done()
    }
  }
})

test('a store read times out without a write', () => {
  const f = storeFixture()
  try {
    const start = Date.now()
    safeError(() => useSlot({ ...f.cfg, read: 'sleep 15' }, 1), 'cannot read slot 1')
    expect(Date.now() - start).toBeLessThan(12000)
    expect(f.read('writes.log')).toBe('')
  } finally {
    f.done()
  }
}, 20000)

test('an active-field failure reports that the token is live', () => {
  const f = storeFixture()
  try {
    writeFileSync(join(f.tmp, 'active.fail'), '')
    safeError(
      () => useSlot(f.cfg, 2),
      'slot 2 token is live, but token.write failed for field active (exit 1)',
    )
    expect(f.read('store/live')).toBe('zqsecret-2')
    expect(f.read('store/active')).toBe('1')
  } finally {
    f.done()
  }
})

test('probe reads rejection headers and cancels the body', async () => {
  let cancelled = false
  const fake: Fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected' } },
    )
  expect(await probe('zqsecret-1', fake)).toEqual({ status: 'refused', use7d: undefined, use5h: undefined })
  expect(cancelled).toBe(true)
})

test('scan stops at 20; list sanitizes active values and unknown usage', async () => {
  const f = storeFixture()
  try {
    for (let n = 3; n <= 21; n++) f.put(`account_${n}_token`, 'zqsecret-1')
    f.put('active', 'zqsecret-active')
    f.usage('zqsecret-1', 'allowed')
    const r = await listSlots(f.cfg, f.fetchFn)
    expect(r.slots).toHaveLength(20)
    expect(r.live).toBeUndefined()
    expect(r.slots.every(s => !s.live && s.hasToken)).toBe(true)
    expect(f.read('argv.log')).not.toContain('account_21_token')
    const rows = slotRows(r)
    rows.forEach(noSecret)
    expect(rows[0]).toBe('live: slot ?')
    expect(rows[2]).toMatch(/^1\s+\?\s+0.1\s+ok$/)
  } finally {
    f.done()
  }
})

test('store reads strip one line end; use accepts a named slot beyond the scan', async () => {
  const f = storeFixture()
  try {
    f.put('account_999_token', 'zqsecret-999\r\n')
    noSecret(useSlot(f.cfg, 999))
    expect(f.read('store/live')).toBe('zqsecret-999')
    f.put('account_2_token', '')
    f.put('account_3_token', 'zqsecret-3')
    f.put('active', ' 1\n')
    const r = await listSlots(f.cfg, f.fetchFn)
    expect(r.live).toBe('1')
    expect(r.slots).toHaveLength(1)
    expect(f.read('argv.log')).not.toContain('account_3_token')
    slotRows(r).forEach(noSecret)
  } finally {
    f.done()
  }
})

test('store failures discard child output and handle signals', () => {
  const f = storeFixture()
  try {
    safeError(
      () => useSlot({ ...f.cfg, read: 'printf zqsecret; printf zqsecret >&2; exit 1' }, 1),
      'cannot read slot 1',
    )
    safeError(() => useSlot({ ...f.cfg, read: 'kill -TERM $$' }, 1), 'cannot read slot 1')
    safeError(
      () => useSlot({ ...f.cfg, write: 'printf zqsecret; printf zqsecret >&2; exit 2' }, 1),
      'token.write failed for field live (exit 2)',
    )
    safeError(() => useSlot({ ...f.cfg, write: 'kill -TERM $$' }, 1), 'signal SIGTERM')
    expect(f.read('store/live')).toBe('old')
  } finally {
    f.done()
  }
})

test('probes start in parallel and use the fixed request', async () => {
  const f = storeFixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let started = 0
  const fake: Fetch = async (url, init) => {
    started++
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('anthropic-version')).toBe('2023-06-01')
    expect(new Headers(init.headers).get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(init.body).toBe(
      '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"."}]}',
    )
    await gate
    return new Response(null, { headers: { 'anthropic-ratelimit-unified-status': 'allowed' } })
  }
  try {
    const result = listSlots(f.cfg, fake)
    expect(started).toBe(2)
    release()
    slotRows(await result).forEach(noSecret)
  } finally {
    release()
    f.done()
  }
})
