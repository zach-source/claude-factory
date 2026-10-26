import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// bin/codex-token with fake ccswitch, op and curl on PATH
const SCRIPT = join(import.meta.dir, '..', 'bin', 'codex-token')
const jwt = (exp: number) =>
  ['{"alg":"none"}', JSON.stringify({ exp })].map(p => Buffer.from(p).toString('base64url')).join('.') +
  '.sig'
const now = () => Math.floor(Date.now() / 1000)

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'codex-token-'))
  const bin = join(tmp, 'bin')
  mkdirSync(bin)
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`)
    chmodSync(join(bin, name), 0o755)
  }
  // ccswitch token get --codex <email>: prints ccs-<email>.json; fails when ccs-<email>.fail exists
  fake('ccswitch', `[ ! -e "${tmp}/ccs-$4.fail" ] || exit 1\ncat "${tmp}/ccs-$4.json"\n`)
  // op: item edit logs its args (and fails, echoing them, when op.fail exists); item get prints item.json
  fake(
    'op',
    `if [ "$2" = edit ]; then printf '%s\\n' "$*" >> "${tmp}/op.log"; [ ! -e "${tmp}/op.fail" ] || { echo "$*" >&2; exit 1; }; exit 0; fi\ncat "${tmp}/item.json"\n`,
  )
  // curl -H @-: the headers come on stdin; the body is usage-<token>.json, and a .401 marker fails like curl -f
  fake(
    'curl',
    `h=$(cat); t=$(printf '%s' "$h" | sed -n 's/^authorization: Bearer //p')\n[ ! -e "${tmp}/usage-$t.401" ] || exit 22\ncat "${tmp}/usage-$t.json"\n`,
  )
  const session = (email: string, token: string, account = 'acct-' + email) =>
    writeFileSync(
      join(tmp, `ccs-${email}.json`),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: token, account_id: account, refresh_token: '' },
      }),
    )
  const usage = (token: string, primary: number, secondary: number) =>
    writeFileSync(
      join(tmp, `usage-${token}.json`),
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: primary },
          secondary_window: { used_percent: secondary },
        },
      }),
    )
  writeFileSync(
    join(tmp, 'item.json'),
    JSON.stringify({ fields: [{ label: 'active', value: 'a@acme.test' }] }),
  )
  const run = (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawnSync(['bash', SCRIPT, ...args], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CODEX_TOKEN_ITEM: 'item',
        CODEX_TOKEN_VAULT: 'vault',
        CODEX_TOKEN_LIVE_FIELD: 'live',
        CODEX_TOKEN_ACCOUNT_FIELD: 'account',
        CODEX_TOKEN_ACTIVE_FIELD: 'active',
        CODEX_TOKEN_LABELS: 'a@acme.test b@acme.test',
        ...env,
      },
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const log = () => (existsSync(join(tmp, 'op.log')) ? readFileSync(join(tmp, 'op.log'), 'utf8') : '')
  const mark = (name: string) => writeFileSync(join(tmp, name), '')
  return { tmp, session, usage, run, log, mark, done: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('use writes the access token, the account id and the label, and prints no token', () => {
  const f = fixture()
  try {
    const tok = jwt(now() + 86400)
    f.session('a@acme.test', tok)
    const r = f.run(['use', 'a@acme.test'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('label a@acme.test is live')
    expect(f.log().trim().split(' ')).toEqual([
      'item',
      'edit',
      'item',
      '--vault',
      'vault',
      `live[concealed]=${tok}`,
      'account[concealed]=acct-a@acme.test',
      'active[concealed]=a@acme.test',
    ])
    expect(r.out + r.err).not.toContain(tok)
  } finally {
    f.done()
  }
})

test('use never writes a refresh token or an auth.json blob', () => {
  const f = fixture()
  try {
    const tok = jwt(now() + 86400)
    f.session('a@acme.test', tok)
    writeFileSync(
      join(f.tmp, 'ccs-a@acme.test.json'),
      JSON.stringify({
        tokens: { access_token: tok, account_id: 'x', refresh_token: 'refresh-e2e' },
        auth_mode: 'chatgpt',
      }),
    )
    expect(f.run(['use', 'a@acme.test']).code).toBe(0)
    expect(f.log()).not.toContain('refresh')
    expect(f.log()).not.toContain('auth_mode')
  } finally {
    f.done()
  }
})

test('use refuses an empty value, an expiring token and a missing session', () => {
  const f = fixture()
  try {
    f.session('a@acme.test', '')
    expect(f.run(['use', 'a@acme.test']).code).toBe(1)
    f.session('a@acme.test', jwt(now() + 600))
    const soon = f.run(['use', 'a@acme.test'])
    expect(soon.code).toBe(1)
    expect(soon.err).toContain('expires within an hour')
    f.session('a@acme.test', 'not-a-jwt')
    expect(f.run(['use', 'a@acme.test']).code).toBe(1)
    f.mark('ccs-b@acme.test.fail')
    expect(f.run(['use', 'b@acme.test']).code).toBe(1)
    expect(f.log()).toBe('')
  } finally {
    f.done()
  }
})

test('use hides the token when op fails and echoes it', () => {
  const f = fixture()
  try {
    const tok = jwt(now() + 86400)
    f.session('a@acme.test', tok)
    f.mark('op.fail')
    const r = f.run(['use', 'a@acme.test'])
    expect(r.code).toBe(1)
    expect(r.out + r.err).not.toContain(tok)
  } finally {
    f.done()
  }
})

test('best skips a label at 100 percent and one that gets a 401, and takes the lowest use', () => {
  const f = fixture()
  try {
    const ta = jwt(now() + 86400)
    const tb = jwt(now() + 86401)
    const tc = jwt(now() + 86402)
    f.session('a@acme.test', ta)
    f.session('b@acme.test', tb)
    f.session('c@acme.test', tc)
    f.usage(ta, 10, 100)
    f.usage(tb, 30, 20)
    f.usage(tc, 5, 5)
    f.mark(`usage-${tc}.401`)
    const r = f.run(['best'], { CODEX_TOKEN_LABELS: 'a@acme.test b@acme.test c@acme.test' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('label b@acme.test is live')
    expect(f.log()).toContain(`live[concealed]=${tb}`)
    expect(r.out + r.err).not.toContain(tb)
    f.usage(tb, 100, 1)
    const none = f.run(['best'], { CODEX_TOKEN_LABELS: 'a@acme.test b@acme.test c@acme.test' })
    expect(none.code).toBe(1)
    expect(none.out + none.err).not.toContain(ta)
  } finally {
    f.done()
  }
})

test('best keeps the label order on equal use', () => {
  const f = fixture()
  try {
    const ta = jwt(now() + 86400)
    const tb = jwt(now() + 86401)
    f.session('a@acme.test', ta)
    f.session('b@acme.test', tb)
    f.usage(ta, 20, 20)
    f.usage(tb, 20, 20)
    expect(f.run(['best']).out).toContain('label a@acme.test is live')
  } finally {
    f.done()
  }
})

test('with no argument it shows each label, its use and the live mark, without a token', () => {
  const f = fixture()
  try {
    const ta = jwt(now() + 86400)
    const tb = jwt(now() + 86401)
    f.session('a@acme.test', ta)
    f.session('b@acme.test', tb)
    f.usage(ta, 12, 40)
    f.mark(`usage-${tb}.401`)
    const r = f.run([])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/a@acme.test\s+40\s+\*/)
    expect(r.out).toMatch(/b@acme.test\s+\?/)
    expect(r.out + r.err).not.toContain(ta)
  } finally {
    f.done()
  }
})

test('each unset variable fails with its name', () => {
  const f = fixture()
  try {
    for (const v of [
      'CODEX_TOKEN_ITEM',
      'CODEX_TOKEN_VAULT',
      'CODEX_TOKEN_LIVE_FIELD',
      'CODEX_TOKEN_ACCOUNT_FIELD',
      'CODEX_TOKEN_ACTIVE_FIELD',
      'CODEX_TOKEN_LABELS',
    ]) {
      const r = f.run([], { [v]: '' })
      expect(r.code).toBe(1)
      expect(r.err).toContain(`${v} is not set`)
    }
  } finally {
    f.done()
  }
})
