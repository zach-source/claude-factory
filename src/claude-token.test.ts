import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// bin/claude-token with fake op and curl on PATH, and a jq wrapper that logs its argv
const SCRIPT = join(import.meta.dir, '..', 'bin', 'claude-token')

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
