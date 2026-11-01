import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ciReport } from './ci'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const PR = 'https://github.com/acme/widget/pull/7'
type R = { code: number; out: string; err: string }
const ok = (o: unknown): R => ({ code: 0, out: typeof o === 'string' ? o : JSON.stringify(o), err: '' })
const check = (name: string, o: Record<string, unknown> = {}) => ({
  id: 11,
  name,
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/acme/widget/actions/runs/1/job/11',
  app: { slug: 'github-actions' },
  ...o,
})
function fake(table: [string, R][], calls: string[] = []) {
  return (argv: string[]): R => {
    const j = argv.join(' ')
    calls.push(j)
    const hit = table.filter(([w]) => j.startsWith(w)).sort((x, y) => y[0].length - x[0].length)[0]
    return hit ? hit[1] : { code: 1, out: '', err: `unmocked: ${j}` }
  }
}
const prView = (sha = A, url = PR) => ['pr view', ok({ headRefOid: sha, url })] as [string, R]
const runs = (sha: string, rs: object[]) =>
  [`api repos/acme/widget/commits/${sha}/check-runs`, ok({ total_count: rs.length, check_runs: rs })] as [
    string,
    R,
  ]
const job = [
  'api repos/acme/widget/actions/jobs/11',
  ok({
    steps: [
      { number: 1, name: 'setup', conclusion: 'success' },
      { number: 2, name: 'bun test', conclusion: 'failure' },
    ],
  }),
] as [string, R]
const logs = (text: string) => ['api repos/acme/widget/actions/jobs/11/logs', ok(text)] as [string, R]
const failing = [check('test', { conclusion: 'failure' })]

test('failed: header, job, first failed step, url and the last 80 log lines; exit 1', () => {
  const log = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n')
  const r = ciReport(
    ['7'],
    fake([prView(), runs(A, [...failing, check('lint', { id: 12 })]), job, logs(log)]),
  )
  expect(r.exit).toBe(1)
  expect(r.text).toContain(`acme/widget#7 ${A}: failed (1 of 2 checks failed)`)
  expect(r.text).toContain('step 2 "bun test"')
  expect(r.text).toContain('https://github.com/acme/widget/actions/runs/1/job/11')
  expect(r.text).toContain('line99')
  expect(r.text).toContain('line20')
  expect(r.text).not.toContain('line19\n')
})

test('green: status line, exit 0, no jobs or logs call', () => {
  const calls: string[] = []
  const rs = [check('a'), check('b', { conclusion: 'skipped' }), check('c', { conclusion: 'neutral' })]
  const r = ciReport([PR], fake([prView(), runs(A, rs)], calls))
  expect(r).toEqual({ text: `acme/widget#7 ${A}: green (3 checks)`, exit: 0 })
  expect(calls.some(c => c.includes('/actions/jobs/'))).toBe(false)
})

test('stale: a failed check on an older SHA does not count; only the head SHA is read', () => {
  const calls: string[] = []
  const r = ciReport(['7'], fake([prView(B), runs(A, failing), runs(B, [check('test')])], calls))
  expect(r.exit).toBe(0)
  expect(calls.some(c => c.includes(`commits/${B}/`))).toBe(true)
  expect(calls.some(c => c.includes(`commits/${A}/`))).toBe(false)
  expect(calls.some(c => c.includes('--branch'))).toBe(false)
})

test('pending in_progress: names the unfinished check, exit 2', () => {
  const slow = check('slow', { status: 'in_progress', conclusion: null })
  const r = ciReport(['7'], fake([prView(), runs(A, [slow])]))
  expect(r.exit).toBe(2)
  expect(r.text).toContain('pending')
  expect(r.text).toContain('slow')
})

test('pending zero checks: no checks yet, exit 2', () => {
  const r = ciReport(['7'], fake([prView(), runs(A, [])]))
  expect(r.exit).toBe(2)
  expect(r.text).toContain('no checks yet')
})

test('failed plus pending: failed wins, header counts the pending one', () => {
  const slow = check('slow', { id: 12, status: 'queued', conclusion: null })
  const r = ciReport(['7'], fake([prView(), runs(A, [...failing, slow]), job, logs('x')]))
  expect(r.exit).toBe(1)
  expect(r.text).toContain('1 pending')
})

test('argument grammar: bad input gives usage, exit 3 and zero gh calls', () => {
  const bad = [
    [],
    ['7', '8'],
    ['0'],
    ['-R'],
    ['--json'],
    ['#12'],
    ['12abc'],
    ['main'],
    ['https://gitlab.com/a/b/pull/1'],
    ['https://github.com/a/b/pull/1/files'],
    ['http://github.com/a/b/pull/1'],
  ]
  for (const a of bad) {
    const calls: string[] = []
    const r = ciReport(a, fake([prView(), runs(A, [])], calls))
    expect([a, r.exit, calls.length]).toEqual([a, 3, 0])
    expect(r.text).toContain('usage')
  }
})

test('gh output is checked: a bad url or a bad sha stops after one call', () => {
  const replies = [prView(A, 'https://evil.test/acme/widget/pull/7'), prView('zz'), prView(A.toUpperCase())]
  for (const reply of replies) {
    const calls: string[] = []
    const r = ciReport(['7'], fake([reply, runs(A, [])], calls))
    expect([r.exit, calls.length]).toEqual([3, 1])
  }
})

test('log fails: the block says why, the next job still runs, exit 1', () => {
  const r = ciReport(
    ['7'],
    fake([
      prView(),
      runs(A, [...failing, check('t2', { id: 12, conclusion: 'timed_out' })]),
      job,
      [
        'api repos/acme/widget/actions/jobs/11/logs',
        { code: 4, out: '', err: 'denied\u0007 by egress\nsecond' },
      ],
      ['api repos/acme/widget/actions/jobs/12', { code: 1, out: '', err: 'nope' }],
    ]),
  )
  expect(r.exit).toBe(1)
  expect(r.text).toContain('log: not available (gh exit 4: denied by egress)')
  expect(r.text).toContain('log: not available (gh exit 1: nope)')
  expect(r.text).toContain('t2')
})

test('other app: name and details url only, no jobs or logs call', () => {
  const calls: string[] = []
  const ext = check('ext', {
    conclusion: 'failure',
    app: { slug: 'other' },
    details_url: 'https://ci.test/x',
  })
  const r = ciReport(['7'], fake([prView(), runs(A, [ext])], calls))
  expect(r.exit).toBe(1)
  expect(r.text).toContain('ext')
  expect(r.text).toContain('https://ci.test/x')
  expect(calls.some(c => c.includes('/actions/jobs/'))).toBe(false)
})

test('an unknown conclusion counts as failed', () => {
  const r = ciReport(['7'], fake([prView(), runs(A, [check('t', { conclusion: 'zqnew' })]), job, logs('x')]))
  expect(r.exit).toBe(1)
})

test('log lines lose ANSI, control characters and CR, and are cut to 400 chars', () => {
  const text = `\x1b[31mred\x1b[0m\x07 ok\r\n${'x'.repeat(1000)}\n`
  const r = ciReport(['7'], fake([prView(), runs(A, failing), job, logs(text)]))
  expect(r.text).toContain('red ok')
  expect(r.text).not.toMatch(/[\x07\x1b\r]/)
  expect(r.text).not.toContain('x'.repeat(401))
  expect(r.text).toContain('x'.repeat(400))
})

test('the CLI exits 0 green, 1 failed, 2 pending, 3 on a gh error', () => {
  const dir = join(tmpdir(), `ci-cli-${process.pid}`)
  const bin = join(dir, 'bin')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  const mode = join(dir, 'mode')
  const one = (status: string, conclusion: string | null) =>
    JSON.stringify({
      total_count: 1,
      check_runs: [{ id: 1, name: 't', status, conclusion, app: { slug: 'github-actions' } }],
    })
  const jobs = JSON.stringify({ steps: [{ number: 1, name: 's', conclusion: 'failure' }] })
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      `m=$(cat ${mode})`,
      '[ "$m" = bad ] && exit 1',
      'case "$1 $2" in',
      `  "pr view") printf '%s' '{"headRefOid":"${A}","url":"${PR}"}';;`,
      `  "api repos/acme/widget/commits/${A}/check-runs?per_page=100") case "$m" in`,
      `    green) printf '%s' '${one('completed', 'success')}';;`,
      `    pending) printf '%s' '${one('queued', null)}';;`,
      `    *) printf '%s' '${one('completed', 'failure')}';;`,
      '  esac;;',
      `  "api repos/acme/widget/actions/jobs/1") printf '%s' '${jobs}';;`,
      '  "api repos/acme/widget/actions/jobs/1/logs") echo tail-line;;',
      '  *) exit 1;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'gh'), 0o755)
  const run = (m: string) => {
    writeFileSync(mode, m)
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FACTORY_HOME: join(dir, 'home'),
      FACTORY_SELF_UPDATE: '0',
    }
    delete env.FACTORY_OUTBOX
    delete env.FACTORY_FROM
    return Bun.spawnSync(['bun', join(import.meta.dir, 'cli.ts'), 'ci', '7'], { env, cwd: dir })
  }
  try {
    expect(run('green').exitCode).toBe(0)
    const failed = run('failed')
    expect(failed.exitCode).toBe(1)
    expect(failed.stdout.toString()).toContain('tail-line')
    expect(run('pending').exitCode).toBe(2)
    expect(run('bad').exitCode).toBe(3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
