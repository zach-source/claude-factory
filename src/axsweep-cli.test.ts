// The AX sweep through `factory beads` (claude-factory-sps9). A fake ax prints the task and workspace tables
// from files and logs each argv. A done run leaks a task and a workspace; the manager and a live worker stay.
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
import { taskName } from './ax'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const root = join(realpathSync(tmpdir()), `axsweep-cli-${process.pid}`)
let dir = ''
let count = 0
const home = () => join(dir, 'home')
const bin = () => join(dir, 'bin')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const factory = (args: string[], extra: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_AX_CONTEXT, FACTORY_AX_MANAGER, ...laptop } =
    process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home(),
      FACTORY_NO_KICK: '1',
      PATH: `${bin()}:${laptop.PATH}`,
      FACTORY_HERDR: join(bin(), 'herdr'),
      FACTORY_AX: join(bin(), 'ax'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
      FACTORY_SELF_UPDATE: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
      ...extra,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

const script = (name: string, lines: string[]) => {
  writeFileSync(join(bin(), name), ['#!/bin/sh', ...lines].join('\n'))
  chmodSync(join(bin(), name), 0o755)
}
const settle = () => {
  for (let i = 0; i < 100 && existsSync(join(home(), 'beads.lock')); i++) Bun.sleepSync(100)
}
const table = (head: string, names: string[]) =>
  [head, ...names.map(n => `${n} factory Running`)].join('\n') + '\n'

/**
 * a home with one done run (state seq 15) and one live run (state seq 5, pane on its seq-5 task), the rig
 * switched to the ax runner. Returns both run ids.
 */
function setup(ax = true) {
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
  script('ax', [
    `echo "$*" >> "${join(dir, 'calls.log')}"`,
    'case "$3 $4" in',
    `  "get tasks") cat "${join(dir, 'tasks.txt')}" || exit 1;;`,
    `  "get workspaces") cat "${join(dir, 'ws.txt')}" || exit 1;;`,
    `  "delete task") if grep -qx "$5" "${join(dir, 'denied.txt')}" 2>/dev/null; then echo forbidden >&2; exit 1; fi;;`,
    'esac',
  ])
  const def = join(dir, 'tiny.json')
  writeFileSync(
    def,
    JSON.stringify({
      name: 'tiny',
      start: 'work',
      nodes: { work: { prompt: 'Do it.', next: { ok: 'done' } } },
    }),
  )
  writeFileSync(join(home(), 'rigs.json'), JSON.stringify([{ name: 'a', repo, factory: def }]))
  writeFileSync(join(home(), 'labels.stamp'), '')
  writeFileSync(join(home(), 'orphans.stamp'), '')
  expect(factory(['start', def, repo, 'acme-1']).code).toBe(0)
  const doneId = readdirSync(join(home(), 'runs'))[0]!
  expect(factory(['abort', doneId]).code).toBe(0)
  expect(factory(['tick']).code).toBe(0)
  expect(factory(['start', def, repo, 'acme-2']).code).toBe(0)
  const liveId = readdirSync(join(home(), 'runs')).find(id => id !== doneId)!
  const edit = (id: string, seq: number, pane: string | null) => {
    const f = join(home(), 'runs', id, 'state.json')
    const s = JSON.parse(readFileSync(f, 'utf8'))
    s.snapshot.context.seq = seq
    s.snapshot.context.pane = pane
    writeFileSync(f, JSON.stringify(s))
  }
  edit(doneId, 15, null)
  edit(liveId, 5, `ax://${taskName(liveId, 5)}`)
  if (ax)
    writeFileSync(
      join(home(), 'rigs.json'),
      JSON.stringify([{ name: 'a', repo, factory: def, runner: 'ax' }]),
    )
  settle()
  rmSync(join(dir, 'calls.log'), { force: true })
  return { doneId, liveId }
}

const calls = () =>
  existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n') : []
const deletes = () => calls().filter(l => l.includes(' delete '))
const pass = () => {
  rmSync(join(home(), 'ax-sweep.stamp'), { force: true })
  expect(factory(['beads']).code).toBe(0)
  settle()
}
const axLog = () => readFileSync(join(home(), 'ax.log'), 'utf8')

test('AC6, AC7, AC9: a pass deletes the leaks only; a second pass inside the period makes no ax call', () => {
  const { doneId, liveId } = setup()
  const leak = taskName(doneId, 10)
  const wsOnly = taskName(doneId, 11)
  const old = taskName(liveId, 3)
  const keep = [taskName(liveId, 5), 'f-manager', 'foreign-9', taskName(doneId, 16)]
  writeFileSync(join(dir, 'tasks.txt'), table('NAME ATESPACE PHASE', [...keep, leak, old]))
  writeFileSync(join(dir, 'ws.txt'), table('NAME ATESPACE GIT-REPOS', [...keep, leak, wsOnly]))
  pass()
  const del = deletes()
  for (const name of [leak, wsOnly, old]) {
    expect(del).toContain(`-a factory delete task ${name}`)
    expect(del).toContain(`-a factory delete workspace ${name}`)
  }
  expect(del).toHaveLength(6)
  expect(JSON.stringify(del)).not.toContain('f-manager')
  expect(axLog()).toMatch(/ax-sweep: tasks 6 workspaces 6 removed 3 failed 0\n/)
  expect(axLog()).toContain(`swept ${leak} run ${doneId}`)
  expect(JSON.parse(readFileSync(join(home(), 'ax-sweep.json'), 'utf8'))).toEqual([])

  rmSync(join(dir, 'calls.log'))
  expect(factory(['beads']).code).toBe(0) // ax-sweep.stamp is fresh
  settle()
  expect(calls()).toEqual([])
})

test('AC7: a halted home and a home with no ax rig make no ax call', () => {
  setup(false)
  pass()
  expect(calls()).toEqual([])
  const again = setup()
  expect(again.doneId).toBeTruthy()
  writeFileSync(
    join(home(), 'halt.json'),
    JSON.stringify({ state: 'paused', at: Date.now(), told: {}, closed: {} }),
  )
  pass()
  expect(calls()).toEqual([])
})

test('AC8: a failed list deletes nothing and shows an error row; a failed delete does not stop the others', () => {
  const { doneId } = setup()
  const a = taskName(doneId, 1)
  const b = taskName(doneId, 2)
  writeFileSync(join(dir, 'ws.txt'), table('NAME ATESPACE GIT-REPOS', [a, b]))
  // tasks.txt is missing: the fake exits 1
  pass()
  expect(deletes()).toEqual([])
  const rows = JSON.parse(readFileSync(join(home(), 'ax-sweep.json'), 'utf8'))
  expect(rows[0].error).toContain('ax get tasks failed')

  // the other way round: tasks list, workspaces fail
  rmSync(join(dir, 'ws.txt'))
  writeFileSync(join(dir, 'tasks.txt'), table('NAME ATESPACE PHASE', [a, b]))
  pass()
  expect(deletes()).toEqual([])
  expect(JSON.parse(readFileSync(join(home(), 'ax-sweep.json'), 'utf8'))[0].error).toContain('workspaces')
  writeFileSync(join(dir, 'ws.txt'), table('NAME ATESPACE GIT-REPOS', [a, b]))
  writeFileSync(join(dir, 'denied.txt'), `${a}\n`)
  pass()
  expect(deletes()).toContain(`-a factory delete workspace ${b}`)
  expect(axLog()).toContain(`remove ${a} failed: delete task: forbidden`)
  expect(axLog()).toMatch(/removed 1 failed 1\n/)
  expect(JSON.parse(readFileSync(join(home(), 'ax-sweep.json'), 'utf8'))[0].error).toContain(a)
})

test('AC8: a missing ax binary does not break the beads pass; the sweep deletes nothing', () => {
  const { liveId } = setup()
  const state = join(home(), 'runs', liveId, 'state.json')
  const before = readFileSync(state, 'utf8')
  rmSync(join(home(), 'ax-sweep.stamp'), { force: true })
  expect(factory(['beads'], { FACTORY_AX: 'ax-no-such-binary-zq' }).code).toBe(0)
  settle()
  expect(calls()).toEqual([])
  const rows = JSON.parse(readFileSync(join(home(), 'ax-sweep.json'), 'utf8'))
  expect(rows).toHaveLength(1)
  expect(rows[0].error).toStartWith('ax-sweep:')
  expect(readFileSync(state, 'utf8')).toBe(before)
})
