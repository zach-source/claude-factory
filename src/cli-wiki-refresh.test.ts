// `factory wiki refresh` end to end (claude-factory-tx6c.5). Every test spawns bin/factory with a new temp
// FACTORY_HOME and a fake `gh` first on PATH, so nothing reaches the live home or GitHub.
import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

test('refresh writes nothing through a link in the wiki worktree', () => {
  setup()
  seedAll()
  factory(['wiki', 'init'])
  const out = join(dir, `outside${n}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'precious.txt'), 'precious\n')
  rmSync(join(wiki(), 'index.md'))
  symlinkSync(join(out, 'precious.txt'), join(wiki(), 'index.md'))
  rmSync(join(wiki(), 'rigs'), { recursive: true, force: true })
  symlinkSync(out, join(wiki(), 'rigs'))
  expect(factory(['wiki', 'refresh', '--dry-run']).out).not.toContain('rigs/')
  expect(factory(['wiki', 'refresh']).code).toBe(0)
  expect(readFileSync(join(out, 'precious.txt'), 'utf8')).toBe('precious\n')
  expect(readdirSync(out)).toEqual(['precious.txt'])
  expect(wikiLog()).toContain('wiki: refused a link or a file that is not regular, page skipped')
})

test('refresh writes nothing through a hard link in the wiki worktree', () => {
  setup()
  seedAll()
  factory(['wiki', 'init'])
  const out = join(dir, `outside${n}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'precious.txt'), 'precious\n')
  writeFileSync(join(out, 'other.json'), '{}\n')
  rmSync(join(wiki(), 'index.md'))
  linkSync(join(out, 'precious.txt'), join(wiki(), 'index.md'))
  mkdirSync(join(wiki(), 'rigs'), { recursive: true })
  rmSync(join(wiki(), 'rigs', 'acme.md'), { force: true })
  linkSync(join(out, 'other.json'), join(wiki(), 'rigs', 'acme.md'))
  expect(factory(['wiki', 'refresh']).code).toBe(0)
  expect(readFileSync(join(out, 'precious.txt'), 'utf8')).toBe('precious\n')
  expect(readFileSync(join(out, 'other.json'), 'utf8')).toBe('{}\n')
  expect(wikiLog()).toContain('wiki: refused a link or a file that is not regular, page skipped')
})

// a page that passes the commit scan, so only the staging list keeps it out of the refresh commit
const NOTE = '---\nkind: "topic"\ntitle: "Notes"\n---\nA person wrote this.\n'

test('refresh leaves a dirty page of a person out of its commit', () => {
  setup()
  seedAll()
  factory(['wiki', 'init'])
  writeFileSync(join(wiki(), 'notes.md'), NOTE)
  expect(factory(['wiki', 'refresh']).code).toBe(0)
  expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
    'index.md',
    'rigs/acme.md',
    'rigs/widget.md',
  ])
  expect(git('status', '--short')).toBe('?? notes.md')
})

test('refresh with no change makes no commit and leaves a dirty page alone', () => {
  setup()
  seedRigs([])
  factory(['wiki', 'init'])
  factory(['wiki', 'refresh'])
  const head = git('rev-parse', 'HEAD')
  writeFileSync(join(wiki(), 'notes.md'), NOTE)
  expect(factory(['wiki', 'refresh']).code).toBe(0)
  expect(git('rev-parse', 'HEAD')).toBe(head)
  expect(git('status', '--short')).toBe('?? notes.md')
})

test('refresh pushes main to origin when one is set', () => {
  setup()
  seedAll()
  const b = join(dir, `bare${n}.git`)
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', b])
  const url = 'https://github.com/acme/wiki-none.git'
  const cfg = join(dir, `cfg${n}`)
  writeFileSync(cfg, `[url "${b}"]\n\tinsteadOf = ${url}\n`)
  const env = { GIT_CONFIG_GLOBAL: cfg }
  expect(factory(['wiki', 'init', '--remote', url], env).code).toBe(0)
  expect(factory(['wiki', 'refresh'], env).code).toBe(0)
  const head = git('rev-parse', 'HEAD')
  expect(Bun.spawnSync(['git', '-C', b, 'rev-parse', 'main']).stdout.toString().trim()).toBe(head)
})

/** a wiki with a local bare origin, plus a scratch clone that plays the person who edits on GitHub */
function withOrigin() {
  setup()
  seedAll()
  const b = join(dir, `bare${n}.git`)
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', b])
  const url = 'https://github.com/acme/wiki-pull.git'
  const cfg = join(dir, `cfg${n}`)
  writeFileSync(cfg, `[url "${b}"]\n\tinsteadOf = ${url}\n`)
  const env = { GIT_CONFIG_GLOBAL: cfg }
  expect(factory(['wiki', 'init', '--remote', url], env).code).toBe(0)
  const clone = join(dir, `clone${n}`)
  const g = (...a: string[]) => {
    const p = Bun.spawnSync(['git', '-C', clone, ...a], { env: { ...process.env, ...env } })
    if (p.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${p.stderr.toString()}`)
    return p.stdout.toString().trim()
  }
  Bun.spawnSync(['git', 'clone', '-q', b, clone], { env: { ...process.env, ...env } })
  const person = (file: string, text: string) => {
    writeFileSync(join(clone, file), text)
    g('add', '-A')
    g('-c', 'user.name=p', '-c', 'user.email=person@acme.example', 'commit', '-qm', 'person')
    g('push', '-q', 'origin', 'HEAD:main')
  }
  const bareHead = () => Bun.spawnSync(['git', '-C', b, 'rev-parse', 'main']).stdout.toString().trim()
  return { b, env, person, bareHead, clone }
}

test('refresh pulls a remote commit first and pushes its own commit on top', () => {
  const o = withOrigin()
  o.person('topics-note.md', NOTE)
  expect(factory(['wiki', 'refresh'], o.env).code).toBe(0)
  expect(git('log', '--format=%ae').split('\n')).toContain('person@acme.example')
  expect(read('topics-note.md')).toBe(NOTE)
  expect(o.bareHead()).toBe(git('rev-parse', 'HEAD'))
})

test('refresh builds index.md from the pulled text', () => {
  const o = withOrigin()
  const index = `${read('index.md')}Added by a person.\n`
  o.person('index.md', index)
  expect(factory(['wiki', 'refresh'], o.env).code).toBe(0)
  expect(read('index.md')).toContain('Added by a person.')
  expect(Bun.spawnSync(['git', '-C', o.b, 'show', 'main:index.md']).stdout.toString()).toContain(
    'Added by a person.',
  )
})

test('a pull that fails keeps the dirty edit and leaves no rebase or stash', () => {
  const o = withOrigin()
  const cfg = join(dir, `cfg${n}`)
  writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}[rebase]\n\tautoStash = true\n`)
  o.person('index.md', `${read('index.md')}Remote line.\n`)
  writeFileSync(join(wiki(), 'glossary.md'), 'dirty edit\n')
  const r = factory(['wiki', 'refresh'], o.env)
  expect(r.code).toBe(0)
  expect(wikiLog()).toMatch(/wiki: pull failed \(exit \d+\), refresh goes on/)
  expect(read('glossary.md')).toBe('dirty edit\n')
  expect(git('stash', 'list')).toBe('')
  expect(existsSync(join(wiki(), '.git', 'rebase-merge'))).toBe(false)
  expect(existsSync(join(wiki(), '.git', 'rebase-apply'))).toBe(false)
})

test('refresh --dry-run runs no fetch', () => {
  const o = withOrigin()
  const before = factory(['wiki', 'refresh', '--dry-run'], o.env)
  rmSync(o.b, { recursive: true, force: true })
  const after = factory(['wiki', 'refresh', '--dry-run'], o.env)
  expect(after.code).toBe(0)
  expect(after.out).toBe(before.out)
  expect(wikiLog()).not.toContain('pull failed')
})

test(
  'AC4 96ks refresh skips the pull, the commit and the push when the repo config has a key outside the allow-list',
  () => {
    const o = withOrigin()
    o.person('topics-note.md', NOTE)
    const before = o.bareHead()
    const e = join(dir, `evil${n}.git`)
    Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', e])
    git('config', `url.${e}.insteadOf`, 'https://github.com/acme/wiki-pull.git')
    expect(factory(['wiki', 'refresh'], o.env).code).toBe(0)
    const log = wikiLog()
    expect(log).toContain('wiki: repo config not allowed, pull skipped')
    expect(log).toContain('wiki: repo config not allowed, nothing committed')
    expect(log).toContain('wiki: repo config not allowed, push refused')
    expect(git('log', '--format=%ae')).not.toContain('person@acme.example')
    expect(o.bareHead()).toBe(before)
    expect(Bun.spawnSync(['git', '-C', e, 'rev-parse', '-q', '--verify', 'main']).exitCode).not.toBe(0)
  },
  SLOW,
)
