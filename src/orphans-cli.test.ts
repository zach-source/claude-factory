// The orphan pass through `factory beads` (claude-factory-pff5.4). A fake gh lists one green draft PR on
// the branch of an aborted run. Pass 1 forks it to review. Pass 2 forks nothing. A new head SHA forks again.
import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const root = join(realpathSync(tmpdir()), `orphans-cli-${process.pid}`)
const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const URL = 'https://github.com/acme/widget/pull/7'
// each test has its own dir: a detached beads pass that `start` or `abort` kicks may outlive the test
let dir = ''
let count = 0
const home = () => join(dir, 'home')
const bin = () => join(dir, 'bin')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home(),
      PATH: `${bin()}:${laptop.PATH}`,
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
      FACTORY_SELF_UPDATE: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
    },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

const script = (name: string, lines: string[]) => {
  writeFileSync(join(bin(), name), ['#!/bin/sh', ...lines].join('\n'))
  chmodSync(join(bin(), name), 0o755)
}

/** wait until no detached beads pass holds the lock, so a pass under test is the only one */
const settle = () => {
  for (let i = 0; i < 100 && existsSync(join(home(), 'beads.lock')); i++) Bun.sleepSync(100)
}

/** a rig with a GitHub origin and one aborted run (the orphan's source); returns the run id */
function setup() {
  dir = join(root, String(count++))
  mkdirSync(bin(), { recursive: true })
  mkdirSync(join(dir, 'claude-config'), { recursive: true })
  writeFileSync(join(dir, 'claude-config', '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home(), { recursive: true })
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.beads'), { recursive: true })
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a])
  git('init', '-q')
  git('remote', 'add', 'origin', 'https://github.com/acme/widget.git')
  git('commit', '--allow-empty', '-q', '-m', 'init')
  script('bd', [
    'case "$1" in',
    "  config) printf '%s' 'acme';;",
    `  show) printf '%s' '[{"id":"acme-1","title":"t","status":"open"}]';;`,
    '  create) echo acme-fork;;',
    "  ready|list|children) printf '%s' '[]';;",
    '  *) exit 0;;',
    'esac',
  ])
  script('herdr', [
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${join(dir, 'wt')}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ])
  script('gh', ['exit 1'])
  const def = join(dir, 'tiny.json')
  writeFileSync(
    def,
    JSON.stringify({
      name: 'tiny',
      start: 'work',
      nodes: {
        work: { prompt: 'Do it.', next: { ok: 'review' } },
        review: { prompt: 'Review it.', next: { ok: 'done' } },
      },
    }),
  )
  writeFileSync(join(home(), 'rigs.json'), JSON.stringify([{ name: 'a', repo, factory: def }]))
  writeFileSync(join(home(), 'labels.stamp'), '')
  expect(factory(['start', def, repo, 'acme-1']).code).toBe(0)
  const src = readdirSync(join(home(), 'runs'))[0]!
  expect(factory(['abort', src]).code).toBe(0)
  expect(factory(['tick']).code).toBe(0) // the tick applies the ABORT
  settle()
  return src
}

/** a fake gh: the open pulls hold one green draft on the source run's branch, at the head in sha.txt */
function fakeGh(src: string, sha: string) {
  writeFileSync(join(dir, 'sha.txt'), sha)
  const pulls = JSON.stringify([
    {
      number: 7,
      html_url: URL,
      state: 'open',
      draft: true,
      head: { ref: `factory/${src}`, sha: 'SHA', repo: { full_name: 'acme/widget' } },
      base: { ref: 'main', repo: { full_name: 'acme/widget' } },
      labels: [],
    },
  ])
  script('gh', [
    'case "$*" in',
    `  *check-runs*) printf '%s' '{"check_runs":[{"status":"completed","conclusion":"success"}]}';;`,
    `  *"/status"*) printf '%s' '{"statuses":[]}';;`,
    `  "api "*"state=open"*) printf '%s' '${pulls}' | sed "s/SHA/$(cat "${join(dir, 'sha.txt')}")/";;`,
    '  *) exit 0;;',
    'esac',
  ])
}

const runIds = () => readdirSync(join(home(), 'runs'))
const read = (name: string) => JSON.parse(readFileSync(join(home(), name), 'utf8'))
const pass = () => {
  rmSync(join(home(), 'orphans.stamp'), { force: true })
  expect(factory(['beads']).code).toBe(0)
  settle()
}

test('AC1, AC3, AC8, AC9: pass 1 forks the green orphan to review; pass 2 forks nothing; a new SHA forks again', () => {
  const src = setup()
  fakeGh(src, SHA1)
  pass()
  expect(runIds()).toHaveLength(2)
  const rec = read('orphan-forks.json')[URL]
  expect(rec).toMatchObject({ sha: SHA1, from: src })
  expect(rec.run).toBe(runIds().find(id => id !== src))
  factory(['tick']) // the next tick applies the fork's GOTO and MAIL
  const forked = read(`runs/${rec.run}/state.json`).snapshot
  expect(JSON.stringify(forked.value)).toContain('review')
  const mail = forked.context.mail.review
  expect(mail.map((m: { from: string }) => m.from)).toEqual(['factory'])
  expect(mail[0].text).toContain(SHA1)
  expect(mail[0].text).toContain(URL)
  expect(read('orphans.json')).toEqual([])

  pass()
  expect(runIds()).toHaveLength(2)

  // the first fork is live: abort it, so the new head has no live owner
  for (const id of runIds()) factory(['abort', id])
  factory(['tick'])
  settle()
  fakeGh(src, SHA2)
  pass()
  expect(runIds()).toHaveLength(3)
  expect(read('orphan-forks.json')[URL].sha).toBe(SHA2)
})

test('AC9: an unreadable orphan-forks.json forks nothing and shows an error row; a fresh stamp skips the pass', () => {
  const src = setup()
  fakeGh(src, SHA1)
  writeFileSync(join(home(), 'orphan-forks.json'), '{not json')
  pass()
  expect(runIds()).toHaveLength(1)
  expect(read('orphans.json')[0].error).toContain('orphan-forks.json is unreadable')
  writeFileSync(join(home(), 'orphan-forks.json'), '{}')
  expect(factory(['beads']).code).toBe(0) // orphans.stamp from the last pass is fresh
  settle()
  expect(runIds()).toHaveLength(1)
})

test('AC8: a stopped factory skips the pass; resume lets it fork', () => {
  const src = setup()
  fakeGh(src, SHA1)
  expect(factory(['stop']).code).toBe(0)
  pass()
  expect(runIds()).toHaveLength(1)
  expect(existsSync(join(home(), 'orphan-forks.json'))).toBe(false)
  expect(factory(['resume']).code).toBe(0)
  pass()
  expect(runIds()).toHaveLength(2)
})
