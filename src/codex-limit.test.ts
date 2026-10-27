import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshCodexToken, runTokenSwap } from './cli'
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
  expect(
    codexLimit(jl({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } })),
  ).toBeNull()
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
