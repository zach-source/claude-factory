// `factory wiki refresh` end to end (claude-factory-tx6c.5). Every test spawns bin/factory with a new temp
// FACTORY_HOME and a fake `gh` first on PATH, so nothing reaches the live home or GitHub.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(realpathSync(tmpdir()), `wiki-refresh-${process.pid}`)
let n = 0
let home = ''
const bin = join(dir, 'bin')
const SLOW = { timeout: 60_000 }

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup() {
  home = join(dir, `home${++n}`)
  mkdirSync(home, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' PRIVATE\n`)
  chmodSync(join(bin, 'gh'), 0o755)
}

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_WIKI_REMOTE, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${bin}:${laptop.PATH}`,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_NO_KICK: '1',
      ...env,
    },
    timeout: 50_000,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const wiki = () => join(home, 'wiki')
const git = (...args: string[]) => {
  const p = Bun.spawnSync(['git', '-C', wiki(), ...args])
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}
const read = (p: string) => readFileSync(join(wiki(), p), 'utf8')
const wikiLog = () => (existsSync(join(home, 'wiki.log')) ? readFileSync(join(home, 'wiki.log'), 'utf8') : '')
const USAGE = 'usage: factory wiki refresh [--dry-run]'

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: {
    implement: { prompt: 'do it', next: { ready: 'done', again: 'implement' } },
    ask: { prompt: 'Ship it?', gate: true, next: { yes: 'done' } },
  },
}
const MIN = 60_000

/** a run with a pinned factory.ts and a state.json; `steps` drive the machine (at times are absolute) */
function seedRun(
  id: string,
  repo: string,
  goal: string,
  steps: { type: string; [k: string]: unknown }[] = [],
  start = 'implement',
) {
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  const def = { ...DEF, start }
  const file = join(d, 'factory.ts')
  writeFileSync(file, `export default ${JSON.stringify(def)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: file, repo, goal, ws: 'w1', worktree: repo, branch: `factory/${id}` }),
  )
  const actor = createActor(compile(def)).start()
  actor.send({ type: 'TICK', at: Date.now() - 5 * MIN })
  for (const s of steps) actor.send({ ...s, seq: actor.getSnapshot().context.seq } as never)
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
}

/** rig repos: acme has a GitHub origin, so its merged PRs map to it */
function seedRigs(names: string[]) {
  const rigs = names.map(name => {
    const repo = join(dir, `repo-${name}`)
    mkdirSync(repo, { recursive: true })
    Bun.spawnSync(['git', '-C', repo, 'init', '-q'])
    Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', `https://github.com/${name}/widget.git`])
    return { name, repo, factory: join(dir, 'f.ts') }
  })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify(rigs))
  return rigs
}

/** two rigs; acme holds a live, a waiting, an aborted run and a merged PR; widget holds one live run */
function seedAll() {
  const [acme, widget] = seedRigs(['acme', 'widget']) as unknown as [{ repo: string }, { repo: string }]
  const hour = Date.now() - 3600_000
  seedRun('ship-mw5aaaaaaa', acme.repo, 'acme-1: Fix the live thing\nmore')
  seedRun('ship-mw5bbbbbbb', acme.repo, 'acme-2: Decide the gate thing', [], 'ask')
  seedRun('ship-mw5ccccccc', acme.repo, 'acme-3: Stop this thing', [
    { type: 'DONE', outcome: 'again', summary: 'Stopped by hand. More.', at: hour },
    { type: 'ABORT' },
  ])
  seedRun('ship-mw5ddddddd', widget.repo, 'widget-1: Fix the widget thing')
  writeFileSync(
    join(home, 'merged-prs.json'),
    JSON.stringify({
      rigs: {},
      prs: { 'https://github.com/acme/widget/pull/5': { head: 'factory/ship-mw5aaaaaaa', mergedAt: hour } },
    }),
  )
}

const section = (text: string, name: string) =>
  text
    .split(/^## /m)
    .find(s => s.startsWith(name))
    ?.split('\n')
    .slice(1)
    .join('\n') ?? ''

test('AC1 pages match the seeded rows, the index lists the rigs, one commit and one log line', () => {
  setup()
  seedAll()
  expect(factory(['wiki', 'init']).code).toBe(0)
  const before = Number(git('rev-list', '--count', 'HEAD'))
  const r = factory(['wiki', 'refresh'])
  expect(r.code).toBe(0)
  expect(git('ls-files', 'rigs').split('\n').sort()).toEqual(['rigs/acme.md', 'rigs/widget.md'])
  const acme = read('rigs/acme.md')
  const widget = read('rigs/widget.md')
  expect(section(acme, 'In progress')).toContain('Fix the live thing')
  expect(section(acme, 'Waits on a person')).toContain('Decide the gate thing')
  expect(section(acme, 'Stopped')).toContain('Stop this thing')
  expect(section(acme, 'Shipped')).toContain('Fix the live thing')
  expect(section(acme, 'Shipped')).toContain('pull/5')
  expect(acme).not.toContain('widget thing')
  expect(section(widget, 'In progress')).toContain('Fix the widget thing')
  expect(widget).not.toContain('live thing')
  const idx = read('index.md')
  expect(idx).toContain('## Rigs')
  expect(idx).toContain('- [acme](rigs/acme.md)')
  expect(idx).toContain('- [widget](rigs/widget.md)')
  expect(Number(git('rev-list', '--count', 'HEAD'))).toBe(before + 1)
  expect(git('log', '-1', '--format=%an|%s')).toBe('factory|wiki refresh: 2 rig pages, 3 changed')
  expect(wikiLog()).toContain('wiki refresh: 2 rig pages, 3 changed')
})

test('AC2 a second refresh exits 0 and adds at most one commit', () => {
  setup()
  seedAll()
  factory(['wiki', 'init'])
  factory(['wiki', 'refresh'])
  const before = Number(git('rev-list', '--count', 'HEAD'))
  expect(factory(['wiki', 'refresh']).code).toBe(0)
  const d = Number(git('rev-list', '--count', 'HEAD')) - before
  expect(d === 0 || d === 1).toBe(true)
})

test('AC3 --dry-run prints the changed paths and writes nothing', () => {
  setup()
  seedAll()
  factory(['wiki', 'init'])
  const head = git('rev-parse', 'HEAD')
  const log = wikiLog()
  const r = factory(['wiki', 'refresh', '--dry-run'])
  expect(r.code).toBe(0)
  expect(r.out.trim().split('\n')).toEqual(['index.md', 'rigs/acme.md', 'rigs/widget.md'])
  expect(existsSync(join(wiki(), 'rigs'))).toBe(false)
  expect(git('rev-parse', 'HEAD')).toBe(head)
  expect(git('status', '--porcelain')).toBe('')
  expect(wikiLog()).toBe(log)
})

test.each<string[]>([['x'], ['--dry-run', '--dry-run'], ['--remote', 'u'], ['-n']])(
  'AC4 refresh %j exits 2 with usage and writes nothing',
  (...a: string[]) => {
    setup()
    seedAll()
    factory(['wiki', 'init'])
    const r = factory(['wiki', 'refresh', ...a])
    expect(r.code).toBe(2)
    expect(r.err).toContain(USAGE)
    expect(existsSync(join(wiki(), 'rigs'))).toBe(false)
  },
)

test('AC5 without a wiki repo refresh says so and makes nothing', () => {
  setup()
  seedAll()
  const r = factory(['wiki', 'refresh'])
  expect(r.code).toBe(0)
  expect(r.out + r.err).toContain('wiki: not set up: run factory wiki init')
  expect(existsSync(wiki())).toBe(false)
})

test('AC6 a held wiki.lock prints busy and writes nothing', () => {
  setup()
  seedAll()
  factory(['wiki', 'init'])
  mkdirSync(join(home, 'wiki.lock'), { recursive: true })
  writeFileSync(join(home, 'wiki.lock', 'pid'), String(process.pid))
  const r = factory(['wiki', 'refresh'])
  expect(r.code).toBe(0)
  expect(r.out + r.err).toContain('wiki: busy')
  expect(existsSync(join(wiki(), 'rigs'))).toBe(false)
})

test(
  'AC8 10 rigs and 600 runs refresh in under 10 s',
  () => {
    setup()
    const rigs = seedRigs(Array.from({ length: 10 }, (_, i) => `rig${i}`))
    for (const [i, rig] of rigs.entries())
      for (let j = 0; j < 60; j++)
        seedRun(
          `ship-mw5${String(i).padStart(2, '0')}${String(j).padStart(3, '0')}x`,
          rig.repo,
          `rig${i}-${j}: Work ${j}`,
        )
    factory(['wiki', 'init'])
    const t = Date.now()
    const r = factory(['wiki', 'refresh'])
    const ms = Date.now() - t
    expect(r.code).toBe(0)
    expect(ms).toBeLessThan(10_000)
    expect(git('ls-files', 'rigs').split('\n').length).toBe(10)
    expect(read('rigs/rig3.md')).toContain('Work 59')
  },
  SLOW,
)

test.each([['../x'], ['a/b'], ['.hidden']])('AC9 rig name %j gets no page', name => {
  setup()
  seedAll()
  const list = JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))
  list.push({ name, repo: list[0].repo, factory: list[0].factory })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify(list))
  factory(['wiki', 'init'])
  const r = factory(['wiki', 'refresh'])
  expect(r.code).toBe(0)
  expect(git('ls-files', 'rigs').split('\n').sort()).toEqual(['rigs/acme.md', 'rigs/widget.md'])
  expect(existsSync(join(home, 'x.md'))).toBe(false)
  expect(existsSync(join(wiki(), 'x.md'))).toBe(false)
  expect(wikiLog()).toContain('wiki: bad rig name, page skipped')
  expect(wikiLog()).toContain('wiki refresh: 2 rig pages')
})

test('AC10 a run with a broken state.json is left out, the pass goes on', () => {
  setup()
  seedAll()
  writeFileSync(join(home, 'runs', 'ship-mw5ddddddd', 'state.json'), '{nope')
  factory(['wiki', 'init'])
  const r = factory(['wiki', 'refresh'])
  expect(r.code).toBe(0)
  expect(read('rigs/acme.md')).toContain('Fix the live thing')
  expect(read('rigs/widget.md')).not.toContain('widget thing')
})

test('refresh pushes to origin when one is set', () => {
  setup()
  seedAll()
  const log = join(dir, 'gh-calls')
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\nprintf '%s\\n' PRIVATE\n`)
  factory(['wiki', 'init'])
  git('remote', 'add', 'origin', 'https://github.com/acme/wiki-none.git')
  expect(factory(['wiki', 'refresh']).code).toBe(0)
  expect(readFileSync(log, 'utf8')).toContain('repo view github.com/acme/wiki-none')
})
