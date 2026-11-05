import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshCodexToken, runTokenSwap, trustedPaged } from './cli'
import { codexLimit } from './worker'

const jl = (...e: object[]) => e.map(x => JSON.stringify(x)).join('\n')
const msg = (apostrophe: string) => `You${apostrophe}ve hit your usage limit. Try again later.`

test('codexLimit reads the usage limit of the last turn.failed or error line, with either apostrophe', () => {
  for (const a of ['’', "'"]) {
    expect(codexLimit(jl({ type: 'turn.failed', error: { message: msg(a) } }), 5)).toEqual({
      at: 5,
      kind: 'usage',
      resetsAt: 0,
    })
    expect(codexLimit(jl({ type: 'thread.started' }, { type: 'error', message: msg(a) }), 7)?.at).toBe(7)
  }
})

test('codexLimit is null for another failure, a success, a later success, a cut first line and a Claude tail', () => {
  const gateway = 'upstream connect error or disconnect/reset before headers'
  expect(codexLimit(jl({ type: 'turn.failed', error: { message: gateway } }))).toBeNull()
  expect(codexLimit(jl({ type: 'turn.completed', usage: {} }))).toBeNull()
  expect(
    codexLimit(jl({ type: 'error', message: msg("'") }, { type: 'turn.completed', usage: {} })),
  ).toBeNull()
  expect(codexLimit('hit your usage limit"}}\n' + jl({ type: 'turn.completed' }))).toBeNull()
  expect(codexLimit('hit your usage limit"}}')).toBeNull()
  expect(codexLimit('')).toBeNull()
  expect(codexLimit(jl({ type: 'assistant', error: 'rate_limit' }))).toBeNull()
})

const failed = (message: string) => jl({ type: 'turn.failed', error: { message } })

test('codexLimit reads a 401 or a token refresh failure that ended the turn as kind auth', () => {
  for (const m of [
    'unexpected status 401 Unauthorized: {"detail":"x"}, url: https://chatgpt.com/backend-api/codex/responses',
    // manager.rs (rust-v0.160.1): the placeholder refresh hits an authority that refuses it (a gateway 403)
    'Failed to refresh token: 403 Forbidden: {"detail":"denied"}',
    'Failed to refresh token: 500 Internal Server Error: boom',
    'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
  ]) {
    expect(codexLimit(failed(m), 5)).toEqual({ at: 5, kind: 'auth', resetsAt: 0 })
  }
})

test('codexLimit is null for a 401 on a retry line, a later success and other statuses', () => {
  const m = 'unexpected status 401 Unauthorized: {}, url: https://chatgpt.com/backend-api/codex/responses'
  expect(codexLimit(jl({ type: 'error', message: m }))).toBeNull()
  expect(codexLimit(failed(m) + '\n' + jl({ type: 'turn.completed', usage: {} }))).toBeNull()
  expect(codexLimit(failed('unexpected status 403 Forbidden: denied'))).toBeNull()
  expect(codexLimit(failed('unexpected status 500 Internal Server Error: id 401'))).toBeNull()
  expect(codexLimit(failed('unexpected status 4010'))).toBeNull()
  expect(codexLimit(jl({ type: 'error', message: 'Failed to refresh token: 403 Forbidden: x' }))).toBeNull()
  expect(codexLimit(failed('Failed to refresh tokens'))).toBeNull()
  expect(codexLimit('unexpected status 401 Unauthorized"}}')).toBeNull()
})

function swapFixture() {
  const home = mkdtempSync(join(tmpdir(), 'swap-'))
  const bin = join(home, 'swap.sh')
  const log = join(home, 'ran')
  writeFileSync(
    bin,
    `#!/bin/sh\necho x >> ${log}\necho 'label a@acme.test is live; agent-vault picks it up'\n`,
    {
      mode: 0o755,
    },
  )
  const keep = { c: process.env.FACTORY_AX_CODEX_TOKEN_SWAP, k: process.env.FACTORY_AX_TOKEN_SWAP }
  const restore = () => {
    for (const [k, v] of [
      ['FACTORY_AX_CODEX_TOKEN_SWAP', keep.c],
      ['FACTORY_AX_TOKEN_SWAP', keep.k],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  }
  return { home, bin, log, restore }
}

test('a Codex token swap uses its own command and state file, mails the label, and leaves Claude alone', () => {
  const f = swapFixture()
  const mail: string[] = []
  const from: string[] = []
  const send = (e: { text?: string; from?: string }) =>
    void (mail.push(e.text ?? ''), from.push(e.from ?? ''))
  try {
    process.env.FACTORY_AX_CODEX_TOKEN_SWAP = f.bin
    process.env.FACTORY_AX_TOKEN_SWAP = 'false'
    const hit = { at: 1_000, resetsAt: 0 }
    expect(runTokenSwap(hit, 5_000, 'ax', send as never, 'implement', 'codex', f.home)).toBe(5_000 + 300_000)
    expect(mail).toHaveLength(1)
    expect(from).toEqual(['factory']) // a notice, not the station asking: isAsking must stay false
    expect(mail[0]).toContain('Codex')
    expect(mail[0]).toContain('a@acme.test')
    expect(existsSync(join(f.home, 'token-swap-ax-codex.json'))).toBe(true)
    expect(existsSync(join(f.home, 'token-swap-ax.json'))).toBe(false)
    runTokenSwap(hit, 6_000, 'ax', send as never, 'implement', 'codex', f.home) // the same hit: no second run
    expect(readFileSync(f.log, 'utf8')).toBe('x\n')
    // Claude keeps its command: 'false' fails, so it waits for the reset
    expect(runTokenSwap(hit, 5_000, 'ax', send as never, 'implement', 'claude', f.home)).toBe(
      1_000 + 3_600_000,
    )
    expect(existsSync(join(f.home, 'token-swap-ax.json'))).toBe(true)
    // no Codex command: it waits for the reset
    delete process.env.FACTORY_AX_CODEX_TOKEN_SWAP
    expect(
      runTokenSwap({ at: 9, resetsAt: 0 }, 5_000, 'ax', send as never, 'implement', 'codex', f.home),
    ).toBe(9 + 3_600_000)
  } finally {
    f.restore()
  }
})

test('the Codex token refresh runs its command once its state file is 12 h old, and not before', () => {
  const f = swapFixture()
  const H = 3_600_000
  try {
    delete process.env.FACTORY_AX_CODEX_TOKEN_SWAP
    refreshCodexToken(100 * H, 'ax', f.home)
    expect(existsSync(f.log)).toBe(false)
    process.env.FACTORY_AX_CODEX_TOKEN_SWAP = f.bin
    refreshCodexToken(100 * H, 'ax', f.home) // no state yet
    refreshCodexToken(111 * H, 'ax', f.home) // 11 h
    expect(readFileSync(f.log, 'utf8')).toBe('x\n')
    refreshCodexToken(112 * H, 'ax', f.home) // 12 h
    expect(readFileSync(f.log, 'utf8')).toBe('x\nx\n')
  } finally {
    f.restore()
  }
})

test('a swap command runs at most once per 5 minutes (Codex: 1 hour) for each runner and harness, whatever the hit times', () => {
  const f = swapFixture()
  const mail: string[] = []
  const send = (e: { text?: string }) => void mail.push(e.text ?? '')
  const W = 3_600_000 // Codex
  try {
    process.env.FACTORY_AX_CODEX_TOKEN_SWAP = f.bin
    process.env.FACTORY_AX_TOKEN_SWAP = f.bin
    const run = (at: number, now: number, h: 'claude' | 'codex' = 'codex') =>
      runTokenSwap({ at, resetsAt: 0 }, now, 'ax', send as never, 'implement', h, f.home)
    run(1_000, 5_000)
    expect(run(2_000, 6_000)).toBe(5_000 + W) // a newer hit inside the gap: no run, wait for the gap
    expect(run(3_000, 7_000)).toBe(5_000 + W)
    expect(readFileSync(f.log, 'utf8')).toBe('x\n')
    expect(mail.filter(m => m.includes('Swapped'))).toHaveLength(1)
    run(4_000, 5_000 + W) // the window ends
    expect(readFileSync(f.log, 'utf8')).toBe('x\nx\n')
    run(1_000, 6_000, 'claude') // the other harness has its own window
    expect(readFileSync(f.log, 'utf8')).toBe('x\nx\nx\n')
  } finally {
    f.restore()
  }
})

test('a Codex refresh command that exits 3 (token fresh) counts as done, other failures retry in 1 h', () => {
  const f = swapFixture()
  const H = 3_600_000
  try {
    for (const [code, at] of [
      [3, 100 * H],
      [1, 100 * H - 12 * H + H],
    ] as const) {
      writeFileSync(f.bin, `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 })
      process.env.FACTORY_AX_CODEX_TOKEN_SWAP = f.bin
      rmSync(join(f.home, 'token-swap-ax-codex.json'), { force: true })
      refreshCodexToken(100 * H, 'ax', f.home)
      expect(JSON.parse(readFileSync(join(f.home, 'token-swap-ax-codex.json'), 'utf8')).at).toBe(at)
    }
  } finally {
    f.restore()
  }
})

test('the Codex token refresh sets the swap window', () => {
  const f = swapFixture()
  try {
    process.env.FACTORY_AX_CODEX_TOKEN_SWAP = f.bin
    refreshCodexToken(100, 'ax', f.home)
    expect(JSON.parse(readFileSync(join(f.home, 'token-swap-ax-codex.json'), 'utf8')).ran).toBe(100)
  } finally {
    f.restore()
  }
})

const SKEW = 5 * 60_000
const RESET_MAX = 8 * 24 * 3_600_000
const NOW = 1_000_000_000_000

test('a token-swap state that is not trusted counts as no state: the swap runs and the file is rewritten', () => {
  const A = NOW - 500 // a trusted state would hold the swap back: this hit is not newer
  const bad: [string, string][] = [
    ['far at', JSON.stringify({ at: NOW + SKEW + 1, until: NOW })],
    ['far until', JSON.stringify({ at: A, until: NOW + RESET_MAX + 1 })],
    ['far ran', JSON.stringify({ at: 1, until: NOW, ran: NOW + SKEW + 1 })],
    ['huge at', '{"at":1e308,"until":1}'],
    ['huge until', `{"at":${A},"until":1e308}`],
    ['huge ran', '{"at":1,"until":1,"ran":1e308}'],
    ['neg inf until', `{"at":${A},"until":-1e999}`],
    ['string at', '{"at":"x","until":1}'],
    ['null at', `{"at":null,"until":${NOW}}`],
    ['string until', `{"at":${A},"until":"1"}`],
    ['null until', `{"at":${A},"until":null}`],
    ['string ran', '{"at":1,"until":1,"ran":"9999999999999"}'],
    ['null ran', `{"at":${A},"until":1,"ran":null}`],
    ['not json', 'not json'],
    ['array', '[]'],
    ['number', '5'],
    ['null', 'null'],
  ]
  for (const harness of ['claude', 'codex'] as const) {
    for (const [name, text] of bad) {
      const f = swapFixture()
      try {
        process.env.FACTORY_AX_CODEX_TOKEN_SWAP = f.bin
        process.env.FACTORY_AX_TOKEN_SWAP = f.bin
        const file = join(f.home, `token-swap-ax${harness === 'codex' ? '-codex' : ''}.json`)
        writeFileSync(file, text)
        const hit = { at: NOW - 1000, resetsAt: 0 }
        expect(runTokenSwap(hit, NOW, 'ax', (() => {}) as never, 'implement', harness, f.home), name).toBe(
          NOW + 300_000,
        )
        expect(readFileSync(f.log, 'utf8'), name).toBe('x\n')
        expect(JSON.parse(readFileSync(file, 'utf8')).ran, name).toBe(NOW)
      } finally {
        f.restore()
      }
    }
  }
})

test('a token-swap state on the bound stays trusted', () => {
  for (const state of [
    { at: NOW + SKEW, until: NOW + RESET_MAX, ran: NOW - 1 },
    { at: NOW + SKEW, until: NOW + RESET_MAX },
  ]) {
    const f = swapFixture()
    try {
      process.env.FACTORY_AX_TOKEN_SWAP = f.bin
      writeFileSync(join(f.home, 'token-swap-ax.json'), JSON.stringify(state))
      const hit = { at: NOW - 1000, resetsAt: 0 }
      runTokenSwap(hit, NOW, 'ax', (() => {}) as never, 'implement', 'claude', f.home)
      expect(existsSync(f.log)).toBe(false)
    } finally {
      f.restore()
    }
  }
  const f = swapFixture()
  try {
    process.env.FACTORY_AX_TOKEN_SWAP = f.bin
    writeFileSync(join(f.home, 'token-swap-ax.json'), JSON.stringify({ at: 1, until: NOW + 7, ran: NOW - 1 }))
    const hit = { at: 2, resetsAt: 0 }
    expect(runTokenSwap(hit, NOW, 'ax', (() => {}) as never, 'implement', 'claude', f.home)).toBe(
      Math.max(NOW + 7, NOW - 1 + 300_000),
    )
  } finally {
    f.restore()
  }
})

test('the Codex token refresh ignores an untrusted state file', () => {
  const H = 3_600_000
  for (const text of [JSON.stringify({ at: NOW + SKEW + 1, until: 1 }), 'not json']) {
    const f = swapFixture()
    try {
      process.env.FACTORY_AX_CODEX_TOKEN_SWAP = f.bin
      writeFileSync(join(f.home, 'token-swap-ax-codex.json'), text)
      refreshCodexToken(NOW, 'ax', f.home)
      expect(readFileSync(f.log, 'utf8')).toBe('x\n')
    } finally {
      f.restore()
    }
  }
  const f = swapFixture()
  try {
    process.env.FACTORY_AX_CODEX_TOKEN_SWAP = f.bin
    writeFileSync(join(f.home, 'token-swap-ax-codex.json'), JSON.stringify({ at: NOW - H, until: 1 }))
    refreshCodexToken(NOW, 'ax', f.home)
    expect(existsSync(f.log)).toBe(false)
  } finally {
    f.restore()
  }
})

test('trustedPaged reads a limit-paged file only inside the reset bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paged-'))
  try {
    const file = join(dir, 'p.json')
    expect(trustedPaged(file, NOW)).toBe(0)
    const rows: [string, number][] = [
      ['not json', 0],
      ['"x"', 0],
      ['null', 0],
      ['"5"', 0],
      ['-1e999', 0],
      ['[]', 0],
      [String(NOW + RESET_MAX + 1), 0],
      ['1e308', 0],
      [String(NOW + RESET_MAX), NOW + RESET_MAX],
      [String(NOW - 1), NOW - 1],
    ]
    for (const [text, want] of rows) {
      writeFileSync(file, text)
      expect(trustedPaged(file, NOW), text).toBe(want)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
