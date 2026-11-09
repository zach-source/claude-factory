// claude-factory-hpmc.3: runs.screen through the real core port, fake herdr and fake ax binaries, a saved run each.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ops-screen-'))
const home = join(dir, 'home')
const fakes = join(dir, 'fakes')
const log = join(dir, 'calls.log')
const pidFile = join(dir, 'pid')
const out = join(dir, 'out')
const script = join(dir, 'serve.ts')
const REASON = {
  noRun: 'no run',
  noWorker: 'run has no worker',
  badAddress: 'worker address is not valid',
  unavailable: 'worker screen could not be read',
  tooLarge: 'worker screen is too large',
  timeout: 'worker screen timed out',
  failed: 'worker screen process failed',
}

// a fake for both binaries: FAKE_MODE picks what it does
const FAKE = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
echo $$ > "$FAKE_PID"
case "$FAKE_MODE" in
  text) cat "$FAKE_OUT" ;;
  fail) echo secret-token-zq >&2; echo secret-token-zq; exit 1 ;;
  crash) echo secret-token-zq >&2; kill -9 $$ ;;
  gone) echo '{"error":{"code":"pane_not_found","message":"secret-token-zq"}}' >&2; exit 1 ;;
  silent) exec sleep 30 ;;
  stream) while true; do printf x; sleep 0.05; done ;;
  big) head -c 200000 /dev/zero | tr '\\0' a ;;
  bigerr) head -c 200000 /dev/zero | tr '\\0' a >&2 ;;
esac
`

function writeRun(id: string, pane: unknown) {
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({
      id,
      factory: join(d, 'factory.ts'),
      repo: dir,
      goal: 'g',
      ws: 'ws1',
      worktree: dir,
      branch: 'b',
    }),
  )
  const context = pane === undefined ? { seq: 1 } : { seq: 1, pane }
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: { value: 'verify', context } }))
}

beforeAll(() => {
  mkdirSync(fakes, { recursive: true })
  for (const n of ['herdr', 'ax']) {
    writeFileSync(join(fakes, n), FAKE)
    chmodSync(join(fakes, n), 0o755)
  }
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'rigs.json'), '[]')
  writeFileSync(
    script,
    [
      `import { corePort } from ${JSON.stringify(join(import.meta.dir, '..', 'cli.ts'))}`,
      `import { clientHandler } from ${JSON.stringify(join(import.meta.dir, '..', 'server-api.ts'))}`,
      `const run = async () => { throw new Error('the runner must not run') }`,
      `const h = clientHandler({ home: process.env.FACTORY_HOME!, run, port: corePort, board: () => null })`,
      `for (const p of process.argv.slice(2)) {`,
      `  const t0 = performance.now()`,
      `  const r = await h(new Request('http://x' + p), '1.2.3.4')`,
      `  console.log(JSON.stringify({ status: r.status, body: await r.text(), ms: performance.now() - t0 }))`,
      `}`,
      `process.exit(0)`,
    ].join('\n'),
  )
  writeRun('h1', 'w1:p1')
  writeRun('a1', 'ax://f-run-1')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Got = { status: number; body: string; ms: number }
async function get(paths: string[], env: Record<string, string> = {}): Promise<Got[]> {
  const e: Record<string, string | undefined> = { ...process.env }
  for (const k of ['FACTORY_OUTBOX', 'FACTORY_FROM', 'FACTORY_RUN', 'FACTORY_IN_AX', 'FACTORY_AX_CONTEXT'])
    delete e[k]
  const p = Bun.spawn([process.execPath, script, ...paths], {
    env: {
      ...e,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_NO_KICK: '1',
      FACTORY_HERDR: join(fakes, 'herdr'),
      FACTORY_AX: join(fakes, 'ax'),
      FAKE_LOG: log,
      FAKE_PID: pidFile,
      FAKE_OUT: out,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [o, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  expect(err).toBe('')
  return o
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
}
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
const reset = () => {
  rmSync(log, { force: true })
  rmSync(pidFile, { force: true })
}
const reason = (g: Got) => (JSON.parse(g.body) as { refused: string }).refused
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const text = { FAKE_MODE: 'text' }

test('runs.screen herdr fixture: the current screen on each call, the exact argv', async () => {
  reset()
  writeFileSync(out, 'first screen\n$ ')
  const [a] = await get(['/v1/runs/h1/screen'], text)
  writeFileSync(out, 'second screen')
  const [b] = await get(['/v1/runs/h1/screen'], text)
  expect([a!.status, a!.body]).toEqual([200, 'first screen\n$ '])
  expect([b!.status, b!.body]).toEqual([200, 'second screen'])
  expect(calls()).toEqual(['pane read w1:p1 --lines 60', 'pane read w1:p1 --lines 60'])
  writeFileSync(out, '')
  const [c] = await get(['/v1/runs/h1/screen'], text)
  expect([c!.status, c!.body]).toEqual([200, ''])
})

test('a screen read changes no run state', async () => {
  const before = readFileSync(join(home, 'runs', 'h1', 'state.json'), 'utf8')
  writeFileSync(out, 'x')
  await get(['/v1/runs/h1/screen'], text)
  expect(readFileSync(join(home, 'runs', 'h1', 'state.json'), 'utf8')).toBe(before)
  for (const f of ['inbox.jsonl', 'outbox.jsonl']) expect(existsSync(join(home, 'runs', 'h1', f))).toBe(false)
})

test('an AX run reads through ax ssh and never calls herdr', async () => {
  reset()
  writeFileSync(out, 'ax screen')
  const [a] = await get(['/v1/runs/a1/screen'], {
    ...text,
    FACTORY_AX_CONTEXT: 'acme',
    FACTORY_AX_CAPABILITIES: '',
  })
  expect([a!.status, a!.body]).toEqual([200, 'ax screen'])
  expect(calls()).toEqual(['--context acme -a factory ssh f-run-1 -- factory worker screen'])
})

test('runs.screen refusal reasons: no downstream call for a bad run or address', async () => {
  reset()
  const bad: [string, unknown, string][] = [
    ['unknown', 'skip', REASON.noRun],
    ['n0', undefined, REASON.noWorker],
    ['n1', null, REASON.noWorker],
    ['n2', '', REASON.noWorker],
    ['t0', 5, REASON.badAddress],
    ['t1', ['w1:p1'], REASON.badAddress],
    ['t2', { a: 1 }, REASON.badAddress],
    ['s0', 'http://x', REASON.badAddress],
    ['s1', 'ssh://x', REASON.badAddress],
    ['w0', 'w1 p1', REASON.badAddress],
    ['w1', ' w1:p1', REASON.badAddress],
    ['c0', 'w1:p1\u0000x', REASON.badAddress],
    ['c1', 'w1:p1\n', REASON.badAddress],
    ['x0', 'w1;rm', REASON.badAddress],
    ['x1', '$(id)', REASON.badAddress],
    ['x2', 'a`id`', REASON.badAddress],
    ['f0', '--lines', REASON.badAddress],
    ['f1', '-x', REASON.badAddress],
    ['a0', 'ax://', REASON.badAddress],
    ['a1u', 'ax://F-run', REASON.badAddress],
    ['a1m', 'ax://fRun', REASON.badAddress],
    ['a2', 'ax://a-', REASON.badAddress],
    ['a3', 'ax://-a', REASON.badAddress],
    ['a4', 'ax://a/b', REASON.badAddress],
    ['a5', 'ax://a b', REASON.badAddress],
    ['a6', `ax://${'a'.repeat(64)}`, REASON.badAddress],
    ['h6', 'a'.repeat(129), REASON.badAddress],
  ]
  for (const [id, pane] of bad) if (pane !== 'skip') writeRun(id, pane)
  const got = await get(
    bad.map(([id]) => `/v1/runs/${id}/screen`),
    text,
  )
  got.forEach((g, i) => {
    expect([bad[i]![0], g.status, g.body === '' ? 'empty' : reason(g).includes(bad[i]![2])]).toEqual([
      bad[i]![0],
      422,
      true,
    ])
  })
  expect(calls()).toEqual([])
  // valid controls
  writeRun('v0', 'p1')
  writeRun('v1', 'ax://f-run-1')
  writeRun('v2', `ax://${'a'.repeat(63)}`)
  writeFileSync(out, 'ok')
  const ok = await get(['/v1/runs/v0/screen', '/v1/runs/v1/screen', '/v1/runs/v2/screen'], text)
  expect(ok.map(g => [g.status, g.body])).toEqual([
    [200, 'ok'],
    [200, 'ok'],
    [200, 'ok'],
  ])
})

test('runs.screen refusal reasons: process failures name a reason, not stderr or screen text', async () => {
  const [h, a, m] = await get(['/v1/runs/h1/screen', '/v1/runs/a1/screen', '/v1/runs/h1/screen'], {
    FAKE_MODE: 'fail',
  })
  for (const g of [h!, a!]) {
    expect(g.status).toBe(422)
    expect(reason(g)).toContain(REASON.unavailable)
    expect(g.body).not.toContain('secret-token-zq')
  }
  expect(m!.status).toBe(422)
  const [missing] = await get(['/v1/runs/h1/screen'], { FACTORY_HERDR: join(fakes, 'no-such-herdr') })
  const [missingAx] = await get(['/v1/runs/a1/screen'], { FACTORY_AX: join(fakes, 'no-such-ax') })
  for (const g of [missing!, missingAx!]) {
    expect(g.status).toBe(422)
    expect(reason(g)).toContain(REASON.failed)
    expect(g.body).not.toContain('could not be read')
  }
  expect(reason(missing!)).not.toBe(reason(h!))
  expect(reason(missingAx!)).not.toBe(reason(a!))
  const paths = ['/v1/runs/h1/screen', '/v1/runs/a1/screen']
  for (const g of await get(paths, { FAKE_MODE: 'crash' })) {
    expect(g.status).toBe(422)
    expect(reason(g)).toContain(REASON.failed)
    expect(g.body).not.toContain('secret-token-zq')
  }
  for (const g of await get(paths, { FAKE_MODE: 'gone' })) {
    expect(g.status).toBe(422)
    expect(reason(g)).toContain(REASON.unavailable)
    expect(g.body).not.toContain('secret-token-zq')
    expect(g.body).not.toContain('pane_not_found')
  }
})

test('runs.screen byte cap: the newest 65536 bytes, and an overflow of either buffer fails', async () => {
  writeFileSync(out, 'a'.repeat(70_000) + 'MARKER')
  const [a] = await get(['/v1/runs/h1/screen', '/v1/runs/a1/screen'], text)
  expect(Buffer.byteLength(a!.body)).toBe(65536)
  expect(a!.body.endsWith('aaMARKER')).toBe(true)
  const [b] = await get(['/v1/runs/a1/screen'], text)
  expect(Buffer.byteLength(b!.body)).toBe(65536)
  writeFileSync(out, '€'.repeat(30000) + 'MARKER')
  const [c] = await get(['/v1/runs/h1/screen'], text)
  expect(c!.body.includes('�')).toBe(false)
  expect(Buffer.byteLength(c!.body)).toBeLessThanOrEqual(65536)
  expect(c!.body.endsWith('€MARKER')).toBe(true)
  for (const mode of ['big', 'bigerr']) {
    const [g, x] = await get(['/v1/runs/h1/screen', '/v1/runs/a1/screen'], { FAKE_MODE: mode })
    for (const r of [g!, x!]) {
      expect(r.status).toBe(422)
      expect(reason(r)).toContain(REASON.tooLarge)
    }
  }
})

test('runs.screen deadline: a silent or an endless process stops within 10 s, both backends', async () => {
  reset()
  const rows = await Promise.all(
    (['silent', 'stream'] as const).flatMap(mode =>
      ['h1', 'a1'].map(async id => {
        const pid = join(dir, `pid-${mode}-${id}`)
        const [g] = await get([`/v1/runs/${id}/screen`], {
          FAKE_MODE: mode,
          FAKE_PID: pid,
          FAKE_LOG: join(dir, `log-${mode}-${id}`),
        })
        return { g: g!, pid, log: join(dir, `log-${mode}-${id}`) }
      }),
    ),
  )
  await Bun.sleep(300)
  for (const r of rows) {
    expect(r.g.status).toBe(422)
    expect(r.g.body).not.toContain('x'.repeat(5))
    expect(reason(r.g)).toContain(REASON.timeout)
    expect(r.g.ms).toBeLessThan(10_000)
    expect(readFileSync(r.log, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(alive(Number(readFileSync(r.pid, 'utf8')))).toBe(false)
  }
  // a fast control still returns its text
  writeFileSync(out, 'fast')
  const [f] = await get(['/v1/runs/h1/screen'], text)
  expect([f!.status, f!.body]).toEqual([200, 'fast'])
}, 30_000)
