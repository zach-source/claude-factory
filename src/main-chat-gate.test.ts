import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(import.meta.dir, '..', 'bin', 'factory')
const U = '123e4567-e89b-12d3-a456-426614174000'
const REFUSED = "without the person's Allow (FACTORY_MAIN_CHAT is set)"
const MARKERS = [
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'FACTORY_PATROL',
  'FACTORY_SERVER',
  'FACTORY_OUTBOX',
  'FACTORY_MAIN_CHAT',
  'FACTORY_ALLOW',
  'BEADS_ACTOR',
]

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mcg-'))
  const home = join(dir, 'home')
  mkdirSync(join(home, 'allow'), { recursive: true })
  writeFileSync(join(home, 'rigs.json'), '{}')
  symlinkSync(BIN, join(dir, 'd'))
  const run = (args: string[], env: Record<string, string> = {}) => {
    const base = { ...process.env } as Record<string, string | undefined>
    for (const k of MARKERS) delete base[k]
    const p = Bun.spawnSync([join(dir, 'd'), ...args], {
      env: { ...base, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env } as Record<string, string>,
    })
    return p.stderr.toString()
  }
  return { home, run }
}

function serverSetup() {
  const { home } = setup()
  const env = { ...process.env } as Record<string, string>
  for (const k of Object.keys(env))
    if (MARKERS.includes(k) || k.startsWith('FACTORY_SERVER_') || k.startsWith('FACTORY_LEASE_'))
      delete env[k]
  return { home, env: { ...env, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' } }
}

async function child(args: string[], env: Record<string, string>, preload?: string) {
  const p = Bun.spawn(
    preload
      ? [process.execPath, '--preload', preload, join(import.meta.dir, 'cli.ts'), ...args]
      : [BIN, ...args],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => p.kill('SIGKILL'), 5000)
  try {
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    expect(p.signalCode).toBeNull()
    return { code, err }
  } finally {
    clearTimeout(timer)
    p.kill()
    await p.exited
  }
}

const SERVER_REFUSED = 'FACTORY_MAIN_CHAT is set; start the server from your own shell'

test('05sap AC1 AC2: all server forms refuse before startup, backup, or forwarding', async () => {
  let requests = 0
  const recorder = Bun.serve({
    port: 0,
    fetch: () => {
      requests++
      return new Response('unexpected')
    },
  })
  try {
    for (const marker of ['1', '0', 'false']) {
      for (const args of [
        [],
        ['backup'],
        ['--port', '0'],
        ['--unknown'],
        [
          '--port',
          '0',
          '--client-port',
          '12345',
          '--tls-cert',
          '/no/cert',
          '--tls-key',
          '/no/key',
          '--person-ca',
          '/no/ca',
        ],
      ]) {
        const { home, env } = serverSetup()
        const spy = join(home, 'spy.ts')
        const calls = join(home, 'calls')
        writeFileSync(
          spy,
          `import { mock } from 'bun:test'
import { appendFileSync } from 'node:fs'
const server = await import(${JSON.stringify(join(import.meta.dir, 'server.ts'))})
const called = () => { appendFileSync(${JSON.stringify(calls)}, 'call\\n'); throw new Error('server effect') }
mock.module(${JSON.stringify(join(import.meta.dir, 'server.ts'))}, () => ({ ...server, main: called, serverBackupCfg: called }))
`,
        )
        const token = join(home, 'allow', `${U}.json`)
        const content = JSON.stringify({ kinds: ['decide'], exp: Date.now() + 60_000 })
        writeFileSync(token, content)
        const r = await child(
          ['server', ...args],
          {
            ...env,
            FACTORY_MAIN_CHAT: marker,
            FACTORY_ALLOW: U,
            ...(args.length ? {} : { FACTORY_SERVER: recorder.url.toString() }),
          },
          spy,
        )
        expect(r.code).not.toBe(0)
        expect(r.err).toContain(SERVER_REFUSED)
        expect(existsSync(calls)).toBe(false)
        expect(existsSync(join(home, 'server-lease.json'))).toBe(false)
        expect(existsSync(join(home, 'manager.lease'))).toBe(false)
        expect(readFileSync(token, 'utf8')).toBe(content)
      }
    }
    expect(requests).toBe(0)
  } finally {
    recorder.stop(true)
  }
})

test('05sap AC2: real CLI refuses before either reserved port can bind', async () => {
  const { home, env } = serverSetup()
  const health = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  const client = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  try {
    const r = await child(
      [
        'server',
        '--port',
        String(health.port),
        '--client-port',
        String(client.port),
        '--tls-cert',
        '/no/cert',
        '--tls-key',
        '/no/key',
        '--person-ca',
        '/no/ca',
      ],
      { ...env, ...M },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain(SERVER_REFUSED)
    expect(r.err).not.toMatch(/cannot read|EADDRINUSE/)
    expect(existsSync(join(home, 'server-lease.json'))).toBe(false)
  } finally {
    health.stop(true)
    client.stop(true)
  }
})

test('05sap AC3: absent and empty markers permit an isolated shell server', async () => {
  for (const extra of [{}, { FACTORY_MAIN_CHAT: '' }]) {
    const { env } = serverSetup()
    const p = Bun.spawn([BIN, 'server', '--port', '0'], {
      env: { ...env, ...extra },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => p.kill('SIGKILL'), 5000)
    try {
      const reader = p.stdout.getReader()
      const first = await reader.read()
      const port = /on :(\d+)/.exec(new TextDecoder().decode(first.value))?.[1]
      expect(port).toBeDefined()
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200)
      reader.releaseLock()
    } finally {
      clearTimeout(timer)
      p.kill()
      await p.exited
    }
  }
})

test('05sap AC3: worker and patrol callers still refuse the server', async () => {
  for (const marker of ['FACTORY_FROM', 'FACTORY_PATROL']) {
    const { env } = serverSetup()
    const r = await child(['server', '--port', '0'], { ...env, [marker]: '1' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('cannot run factory server')
  }
})
const M = { FACTORY_MAIN_CHAT: '1' }

test('0s5e a goal file cannot supply consent for explicit start --owned', () => {
  const { home, run } = setup()
  mkdirSync(join(home, 'text'))
  const path = join(home, 'text', 'goal.md')
  writeFileSync(path, '--owned')
  const args = ['start', 'lifecycle', 'acme', '--goal-file', path]
  expect(run([...args, '--owned'], M)).toContain(REFUSED)
  expect(run(args, M)).not.toContain(REFUSED)
  writeFileSync(
    join(home, 'allow', `${U}.json`),
    JSON.stringify({ kinds: ['owned'], exp: Date.now() + 60_000 }),
  )
  expect(run([...args, '--owned'], { ...M, FACTORY_ALLOW: U })).not.toContain(REFUSED)
  expect(existsSync(join(home, 'runs'))).toBe(false)
})

test('a symlink to the CLI is refused under the marker; a token permits one call (AC5)', () => {
  const { home, run } = setup()
  expect(run(['decide', 'r1', 'ship'], M)).toContain(REFUSED)
  expect(run(['status'], M)).not.toContain(REFUSED)
  expect(run(['decide', 'r1', 'ship'])).not.toContain(REFUSED)
  const exp = Date.now() + 60_000
  writeFileSync(join(home, 'allow', `${U}.json`), JSON.stringify({ kinds: ['decide'], exp }))
  expect(run(['decide', 'r1', 'ship'], { ...M, FACTORY_ALLOW: U })).not.toContain(REFUSED)
  expect(run(['decide', 'r1', 'ship'], { ...M, FACTORY_ALLOW: U })).toContain(REFUSED)
})

test('the refusal comes before the server forward (AC6)', () => {
  const { run } = setup()
  const err = run(['decide', 'r1', 'ship'], { ...M, FACTORY_SERVER: 'http://127.0.0.1:9' })
  expect(err).toContain(REFUSED)
})
