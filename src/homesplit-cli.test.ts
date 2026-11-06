import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dirs: string[] = []
const tmp = () => {
  const d = realpath(mkdtempSync(join(tmpdir(), 'homesplit-cli-')))
  dirs.push(d)
  return d
}
function realpath(p: string) {
  return require('node:fs').realpathSync(p) as string
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const git = (cwd: string, ...a: string[]) =>
  Bun.spawnSync(['git', '-C', cwd, ...a], { stdout: 'pipe', stderr: 'pipe' })
function repo(name: string) {
  const d = join(tmp(), name)
  mkdirSync(d)
  git(d, 'init', '-q', '-b', 'main')
  git(d, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`)
  return d
}
function cli(home: string, args: string[], extra: Record<string, string> = {}) {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_PATROL, FACTORY_SERVER, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1', ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const listing = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true, recursive: true })
        .map(e => `${e.parentPath}/${e.name}`)
        .sort()
    : []

/** a home with an ax rig `widget` and a herdr rig `gadget`, and one finished run of widget */
function fixture() {
  const home = tmp()
  const [widget, gadget] = [repo('widget'), repo('gadget')]
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([
      { name: 'widget', repo: widget, factory: 'lifecycle', runner: 'ax' },
      { name: 'gadget', repo: gadget, factory: 'lifecycle', runner: 'herdr' },
    ]),
  )
  const r = join(home, 'runs', 'r-widget')
  mkdirSync(r, { recursive: true })
  writeFileSync(
    join(r, 'factory.json'),
    JSON.stringify({ name: 'one', start: 'a', nodes: { a: { prompt: 'x', next: { ready: 'done' } } } }),
  )
  writeFileSync(
    join(r, 'run.json'),
    JSON.stringify({
      id: 'r-widget',
      repo: widget,
      factory: join(r, 'factory.json'),
      goal: 'g',
      ws: '',
      worktree: widget,
      branch: 'factory/r-widget',
    }),
  )
  writeFileSync(
    join(r, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: { value: 'done', context: { pane: null, log: [] } } }),
  )
  return { home, widget, gadget, to: join(tmp(), 'srv') }
}
const rigNames = (home: string) =>
  cli(home, ['rig', 'list'])
    .out.split('\n')
    .filter(l => /^\S+  \//.test(l))
    .map(l => l.split(' ')[0])

test('split moves the ax rig: the home hides it and the server home lists it', () => {
  const { home, to } = fixture()
  const p = cli(home, ['home', 'split', to])
  expect(p.err).toBe('')
  expect(p.code).toBe(0)
  expect(rigNames(home)).toEqual(['gadget'])
  expect(rigNames(to)).toEqual(['widget'])
  expect(existsSync(join(to, 'runs/r-widget/state.json'))).toBe(true)
  expect(existsSync(join(home, 'runs/r-widget'))).toBe(false)
  expect(cli(home, ['home']).out.trim()).toBe(home)
})

test('after split, start and rig add refuse the moved rig and a restored rigs.json still hides it', () => {
  const { home, widget, gadget, to } = fixture()
  const saved = readFileSync(join(home, 'rigs.json'), 'utf8')
  expect(cli(home, ['home', 'split', to]).code).toBe(0)
  const runsBefore = readdirSync(join(home, 'runs'))
  const s = cli(home, ['start', 'lifecycle', widget, 'x'])
  expect(s.code).not.toBe(0)
  expect(s.err).toContain('moved to the server home')
  expect(readdirSync(join(home, 'runs'))).toEqual(runsBefore)
  const a = cli(home, ['rig', 'add', 'widget', widget])
  expect(a.code).not.toBe(0)
  expect(a.err).toContain('moved to the server home')
  const b = cli(home, ['rig', 'add', 'other', widget])
  expect(b.err).toContain('moved to the server home')
  const c = cli(home, ['rig', 'add', 'widget', gadget])
  expect(c.err).toContain('moved to the server home')
  writeFileSync(join(home, 'rigs.json'), saved)
  expect(rigNames(home)).toEqual(['gadget'])
  // hidden by name alone and by repo alone
  const rows = JSON.parse(saved)
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([rows[1], { ...rows[0], repo: gadget + '-x' }]))
  expect(rigNames(home)).toEqual(['gadget'])
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([rows[1], { ...rows[0], name: 'renamed' }]))
  expect(rigNames(home)).toEqual(['gadget'])
})

test('split refuses under FACTORY_SERVER and as a worker, and writes nothing', () => {
  const { home, to } = fixture()
  const [h, t] = [listing(home), listing(to)]
  const a = cli(home, ['home', 'split', to], { FACTORY_SERVER: 'http://127.0.0.1:1' })
  expect(a.code).not.toBe(0)
  expect(a.err).toContain('FACTORY_SERVER')
  const b = cli(home, ['home', 'split', to], { FACTORY_FROM: 'manager' })
  expect(b.code).not.toBe(0)
  const ax = cli(home, ['home', 'split', to], { FACTORY_IN_AX: '1' })
  expect(ax.code).not.toBe(0)
  expect(ax.err).toContain('runs on the laptop')
  expect(listing(home)).toEqual(h)
  expect(listing(to)).toEqual(t)
})

test('split refuses while a tick holds tick.lock', () => {
  const { home, to } = fixture()
  mkdirSync(join(home, 'tick.lock'))
  writeFileSync(join(home, 'tick.lock', 'pid'), String(process.pid))
  const p = cli(home, ['home', 'split', to])
  expect(p.code).not.toBe(0)
  expect(p.err).toContain('tick.lock')
  expect(existsSync(to)).toBe(false)
  expect(existsSync(join(home, 'home-split.json'))).toBe(false)
})

test('--dry-run writes nothing', () => {
  const { home, to } = fixture()
  const h = listing(home)
  const p = cli(home, ['home', 'split', to, '--dry-run'])
  expect(p.code).toBe(0)
  expect(p.out).toContain('rigs to move: widget')
  expect(listing(home)).toEqual(h)
  expect(existsSync(to)).toBe(false)
  expect(cli(home, ['home', 'bogus', to]).code).not.toBe(0)
})

test('join brings the rig and runs back, and start passes the moved check again', () => {
  const { home, widget, to } = fixture()
  const before = JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8'))
  expect(cli(home, ['home', 'split', to]).code).toBe(0)
  const j = cli(home, ['home', 'join', to])
  expect(j.err).toBe('')
  expect(j.code).toBe(0)
  expect(existsSync(join(home, 'home-split.json'))).toBe(false)
  expect(existsSync(join(home, 'runs/r-widget/state.json'))).toBe(true)
  expect(
    JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8')).sort((a: any, b: any) =>
      a.name.localeCompare(b.name),
    ),
  ).toEqual(before.sort((a: any, b: any) => a.name.localeCompare(b.name)))
  expect(cli(home, ['start', 'lifecycle', widget, 'x']).err).not.toContain('moved to the server home')
})

test('a bad home-split.json makes rig list fail with its error', () => {
  const { home } = fixture()
  writeFileSync(join(home, 'home-split.json'), '{nope')
  const p = cli(home, ['rig', 'list'])
  expect(p.code).not.toBe(0)
  expect(p.err).toContain('home-split.json')
})
