// claude-factory-7pxk: `factory metrics` counts a handed-off run as shipped when its PR merged. The PR
// list comes from one cached gh call for each GitHub rig. A fake gh on PATH logs each call.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `merges-cli-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const calls = join(dir, 'gh-calls')
const reply = join(dir, 'gh-reply')
const fail = join(dir, 'gh-fail')

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-C', cwd, ...a])
const repo = (name: string, origin: string) => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  git(p, 'init', '-q')
  git(p, 'remote', 'add', 'origin', origin)
  return p
}

beforeEach(() => {
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$PWD" >> ${calls}\nif [ -e ${fail} ]; then echo boom >&2; exit 1; fi\ncat ${reply}\n`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(calls, '')
  const gh = repo('gh-repo', 'https://github.com/acme/widget.git')
  const lab = repo('lab-repo', 'https://example.org/acme/widget.git')
  const idle = repo('idle-repo', 'https://github.com/acme/idle.git')
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([
      { name: 'gh', repo: gh },
      { name: 'lab', repo: lab },
      { name: 'idle', repo: idle },
    ]),
  )
  const now = Date.now()
  const run = (id: string, rig: string, outcome = 'approve') =>
    JSON.stringify({
      id,
      rig,
      node: 'done',
      createdAt: now - 3_600_000,
      log: [{ node: 'review', attempt: 1, outcome, summary: '', at: now - 1800_000 }],
    })
  writeFileSync(
    join(home, 'metrics.jsonl'),
    [run('a-1', 'gh'), run('b-1', 'lab'), run('c-1', 'idle', 'changes')].join('\n') + '\n',
  )
  writeFileSync(
    reply,
    JSON.stringify([
      {
        url: 'https://github.com/acme/widget/pull/1',
        headRefName: 'factory/a-1',
        mergedAt: new Date().toISOString(),
      },
      { url: 'https://github.com/acme/widget/pull/2', headRefName: 'bad', mergedAt: 'not a date' },
    ]),
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const metricsJson = () => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, 'metrics', '--json'], {
    env: { ...laptop, PATH: `${bin}:${process.env.PATH}`, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' },
  })
  return {
    code: p.exitCode,
    fates: p.exitCode === 0 ? JSON.parse(p.stdout.toString()).all.fates : null,
    err: p.stderr.toString(),
  }
}
const callCount = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).length

test('a merged row makes the run shipped; two calls make one gh call; GitLab and idle rigs make none', () => {
  const first = metricsJson()
  expect(first.code).toBe(0)
  expect(first.fates).toEqual({ shipped: 1, 'handed-off': 1, closed: 1 })
  expect(callCount()).toBe(1)
  expect(metricsJson().fates).toEqual(first.fates)
  expect(callCount()).toBe(1)
  expect(Object.keys(JSON.parse(readFileSync(join(home, 'merged-prs.json'), 'utf8')).prs)).toEqual([
    'https://github.com/acme/widget/pull/1',
  ])
})

test('a gh failure leaves the run handed-off, exits 0 and prints one stderr line', () => {
  writeFileSync(fail, '')
  const r = metricsJson()
  expect(r.code).toBe(0)
  expect(r.fates).toEqual({ 'handed-off': 2, closed: 1 })
  expect(r.err.trim().split('\n')).toHaveLength(1)
  expect(existsSync(join(home, 'merged-prs.json'))).toBe(false)
})

test('a corrupt merged-prs.json reads as empty', () => {
  writeFileSync(join(home, 'merged-prs.json'), '{not json')
  expect(metricsJson().fates).toEqual({ shipped: 1, 'handed-off': 1, closed: 1 })
  expect(callCount()).toBe(1)
})

test('an unmatched run makes one gh call in 10 min, however often metrics runs', () => {
  writeFileSync(reply, '[]')
  expect(metricsJson().fates).toEqual({ 'handed-off': 2, closed: 1 })
  metricsJson()
  expect(callCount()).toBe(1)
})
