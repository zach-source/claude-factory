import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `home-split-cli-${process.pid}`)
const home = join(dir, 'home')
const server = join(dir, 'server')
const LIFECYCLE = join(import.meta.dir, '..', 'factories', 'lifecycle.ts')

const factory = (args: string[], extra: Record<string, string> = {}, timeout = 20000) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, FACTORY_DEF_NAME, ...rest } = process.env
  const laptop = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('HERDR_')))
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_NO_KICK: '1', FACTORY_SELF_UPDATE: '0', ...extra },
    timeout,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

function repo(name: string, origin = true) {
  const r = join(dir, name)
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  if (origin) Bun.spawnSync(['git', '-C', r, 'remote', 'add', 'origin', `git@github.com:acme/${name}.git`])
  return r
}
const addRun = (id: string, repoPath: string, value: string, pane: string | null) => {
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'run.json'), JSON.stringify({ id, repo: repoPath, factory: LIFECYCLE }))
  writeFileSync(
    join(d, 'state.json'),
    JSON.stringify({ cursor: 0, snapshot: { value, context: { pane, log: [] } } }),
  )
  writeFileSync(join(d, 'impl.seen'), '{"seen":{"a":2}}\n')
}
const rigs = () =>
  JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8')) as { name: string; remote?: string }[]
/** every file under a dir with its size: a before and after listing */
const listing = (d: string): string[] =>
  !existsSync(d)
    ? []
    : readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory()
          ? listing(join(d, e.name)).map(f => `${e.name}/${f}`)
          : [`${e.name}:${statSync(join(d, e.name)).size}`],
      )

let herdrRepo = ''
let axRepo = ''
beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  herdrRepo = repo('hrig')
  axRepo = repo('arig')
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([
      { name: 'hrig', repo: herdrRepo, factory: 'lifecycle' },
      { name: 'arig', repo: axRepo, factory: 'lifecycle', runner: 'ax' },
    ]),
  )
  addRun('live-ax', axRepo, 'plan', 'ax://t1')
  addRun('done-ax', axRepo, 'done', 'ax://t1')
  addRun('live-herdr', herdrRepo, 'plan', 'w1-2')
  mkdirSync(join(home, 'memory'))
  writeFileSync(join(home, 'memory', 'note.md'), 'n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('home split moves the AX rig and its live run, and leaves the herdr rig', () => {
  const seen = readFileSync(join(home, 'runs', 'live-ax', 'impl.seen'))
  const r = factory(['home', 'split', server])
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(rigs().map(x => x.name)).toEqual(['hrig'])
  expect(readdirSync(join(home, 'rigs-history')).length).toBe(1)
  const moved = JSON.parse(readFileSync(join(server, 'rigs.json'), 'utf8'))
  expect(moved.map((x: { name: string }) => x.name)).toEqual(['arig'])
  expect(moved[0].remote).toBe('https://github.com/acme/arig.git')
  expect(readFileSync(join(server, 'runs', 'live-ax', 'impl.seen'))).toEqual(seen)
  expect(readFileSync(join(server, 'memory', 'note.md'), 'utf8')).toBe('n')
  expect(existsSync(join(server, 'runs', 'done-ax'))).toBe(false)
  expect(existsSync(join(home, 'runs', 'live-ax'))).toBe(false)
  const stamp = readdirSync(home).find(f => f.startsWith('split-'))!
  expect(readFileSync(join(home, stamp, 'runs', 'live-ax', 'impl.seen'))).toEqual(seen)
  expect(existsSync(join(home, 'runs', 'done-ax'))).toBe(true)
  expect(existsSync(join(home, 'runs', 'live-herdr'))).toBe(true)
  const split = JSON.parse(readFileSync(join(home, 'split.json'), 'utf8'))
  expect(split).toHaveLength(1)
  expect(split[0]).toMatchObject({ name: 'arig', repo: axRepo, to: server })
  expect(typeof split[0].at).toBe('number')
})

test('--dry-run writes nothing', () => {
  const before = listing(home)
  const r = factory(['home', 'split', server, '--dry-run'])
  expect(r.code).toBe(0)
  expect(r.out).toContain('arig')
  expect(listing(home)).toEqual(before)
  expect(existsSync(server)).toBe(false)
})

const refuses = (name: string, setup: () => void, extra: Record<string, string> = {}, text?: string) =>
  test(`refuses: ${name}`, () => {
    setup()
    const before = [listing(home), listing(server)]
    const r = factory(['home', 'split', server], extra)
    expect(r.code).toBe(1)
    if (text) expect(r.err).toContain(text)
    expect([listing(home), listing(server)]).toEqual(before)
  })

refuses(
  'tick.lock held',
  () => {
    mkdirSync(join(home, 'tick.lock'))
    writeFileSync(join(home, 'tick.lock', 'pid'), String(process.pid))
  },
  {},
  'tick',
)
refuses('a live AX rig run in a herdr pane', () => addRun('pane', axRepo, 'plan', 'w1-3'), {}, 'pane')
refuses(
  'a live AX rig run at a station pinned to herdr',
  () => addRun('pinned', axRepo, 'baseline', 'ax://t2'),
  {},
  'pinned (station baseline, runner herdr)',
)
refuses('the target holds rigs.json', () => {
  mkdirSync(server)
  writeFileSync(join(server, 'rigs.json'), '[]')
})
refuses('the target holds runs/', () => mkdirSync(join(server, 'runs'), { recursive: true }))
refuses(
  'no AX rig',
  () => writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'hrig', repo: herdrRepo }])),
  {},
  'nothing to move',
)
refuses(
  'a rig with no origin',
  () => {
    const bare = repo('bare', false)
    writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'bare', repo: bare, runner: 'ax' }]))
  },
  {},
  'origin',
)
refuses('FACTORY_IN_AX=1', () => {}, { FACTORY_IN_AX: '1' })
refuses('FACTORY_SERVER_HOME=1', () => {}, { FACTORY_SERVER_HOME: '1' })

test('factory server with a non-AX rig exits 1 and writes no lease', () => {
  const r = factory(['server', '--port', '0', '--every-ms', '100', '--lease-ms', '1000'])
  expect(r.code).toBe(1)
  expect(r.err).toContain('server home holds non-AX rigs: hrig')
  expect(existsSync(join(home, 'server-lease.json'))).toBe(false)
})

test('rig add refuses a moved rig by name or by repo, and passes another rig', () => {
  expect(factory(['home', 'split', server]).code).toBe(0)
  const other = repo('other')
  const a = factory(['rig', 'add', 'arig', other])
  expect(a.code).toBe(1)
  expect(a.err).toContain('moved to the server home')
  const b = factory(['rig', 'add', 'renamed', axRepo])
  expect(b.code).toBe(1)
  expect(b.err).toContain('moved to the server home')
  const c = factory(['rig', 'add', 'other', other])
  expect(c.err).not.toContain('moved')
  expect(c.code).toBe(0)
  writeFileSync(join(home, 'split.json'), '{nope')
  const d = factory(['rig', 'add', 'third', repo('third')])
  expect(d.code).toBe(1)
  expect(d.err).toContain('split.json')
})
