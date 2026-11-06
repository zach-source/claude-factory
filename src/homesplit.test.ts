import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { join_, joinRefusal, split, splitPlan, tombstone, tombstoneFile } from './homesplit'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'homesplit-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const origin = (repo: string) => `git@example.com:acme/${repo.split('/').pop()}.git`
const state = (value: string, pane: string | null = null) =>
  JSON.stringify({ cursor: 0, snapshot: { value, context: { pane, log: [] } } })
const rigRows = () => [
  { name: 'web', repo: '/lap/web', runner: 'ax', factory: 'lifecycle' },
  { name: 'cli', repo: '/lap/cli', runner: 'herdr', factory: 'lifecycle' },
  { name: 'old', repo: '/lap/old', factory: 'lifecycle' },
]
function run(home: string, id: string, repo: string | undefined, value = 'done', pane: string | null = null) {
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  if (repo) writeFileSync(join(d, 'run.json'), JSON.stringify({ id, repo }))
  writeFileSync(join(d, 'state.json'), state(value, pane))
  writeFileSync(join(d, 'log.txt'), `log of ${id}\n`)
}
/** a home with rigs web (ax), cli (herdr) and old (no runner), and runs of each */
function fixture() {
  const home = tmp()
  writeFileSync(join(home, 'rigs.json'), JSON.stringify(rigRows(), null, 2))
  writeFileSync(join(home, 'dispatch.json'), '{}')
  run(home, 'r-web', '/lap/web')
  writeFileSync(join(home, 'runs', 'r-web', 'build.seen'), '3')
  run(home, 'r-cli', '/lap/cli')
  run(home, 'r-old', '/lap/old')
  run(home, 'r-unknown', '/lap/elsewhere')
  run(home, 'r-norun', undefined)
  return home
}
const editFor = (home: string) => (fn: (l: any[]) => any[]) =>
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify(fn(JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8')))),
  )
const listing = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .map(e => `${e.parentPath}/${e.name}`)
    .sort()
const rigsOf = (home: string) =>
  (JSON.parse(readFileSync(join(home, 'rigs.json'), 'utf8')) as any[]).sort((a, b) =>
    a.name.localeCompare(b.name),
  )

test('splitPlan moves only the ax rig and the runs of its repo', () => {
  const home = fixture()
  const p = splitPlan(home, join(tmp(), 'srv'), origin)
  expect(p.refusal).toBeUndefined()
  expect(p.moveRigs.map(r => r.name)).toEqual(['web'])
  expect(p.keepRigs.map(r => r.name).sort()).toEqual(['cli', 'old'])
  expect(p.moveRuns).toEqual(['r-web'])
})

function refusalRows(): [string, (home: string) => string, RegExp][] {
  return [
    [
      'no ax rig',
      home => {
        writeFileSync(join(home, 'rigs.json'), JSON.stringify(rigRows().slice(1)))
        return join(tmp(), 'srv')
      },
      /no rig has runner "ax"/,
    ],
    [
      'target not empty',
      () => {
        const to = tmp()
        writeFileSync(join(to, 'x'), '1')
        return to
      },
      /not an empty directory/,
    ],
    ['target inside home', home => join(home, 'srv'), /must not hold each other/],
    [
      'already split',
      home => {
        writeFileSync(tombstoneFile(home), '{}')
        return join(tmp(), 'srv')
      },
      /already split/,
    ],
    ['rig without origin', () => join(tmp(), 'srv'), /no origin remote for rig web/],
    [
      'live pane run',
      home => {
        run(home, 'r-live', '/lap/web', 'build', '%7')
        return join(tmp(), 'srv')
      },
      /herdr pane/,
    ],
  ]
}

for (const [name, setup, re] of refusalRows()) {
  test(`splitPlan refuses (${name}) and writes nothing`, () => {
    const home = fixture()
    const to = setup(home)
    const at = (d: string) => (existsSync(d) ? listing(d) : [])
    const [homeBefore, toBefore] = [at(home), at(to)]
    const p = splitPlan(home, to, name === 'rig without origin' ? () => undefined : origin)
    expect(p.refusal).toMatch(re)
    expect(() => split(home, to, p, origin, editFor(home))).toThrow()
    expect(at(home)).toEqual(homeBefore)
    expect(at(to)).toEqual(toBefore)
  })
}

test('split moves the run dir byte-equal with its .seen file and writes the tombstone', () => {
  const home = fixture()
  const to = join(tmp(), 'srv')
  const p = splitPlan(home, to, origin)
  split(home, to, p, origin, editFor(home), new Date(0))
  expect(readFileSync(join(to, 'runs/r-web/build.seen'), 'utf8')).toBe('3')
  expect(readFileSync(join(to, 'runs/r-web/state.json'), 'utf8')).toBe(state('done'))
  expect(readdirSync(join(home, 'runs')).sort()).toEqual(['r-cli', 'r-norun', 'r-old', 'r-unknown'])
  expect(rigsOf(home).map(r => r.name)).toEqual(['cli', 'old'])
  const server = JSON.parse(readFileSync(join(to, 'rigs.json'), 'utf8'))
  expect(server.map((r: any) => [r.name, r.remote])).toEqual([['web', 'https://example.com/acme/web.git']])
  expect(readFileSync(join(to, 'dispatch.json'), 'utf8')).toBe('{}')
  expect(tombstone(home)?.runs).toEqual(['r-web'])
})

test('split then join gives the same rigs and run ids and removes the tombstone', () => {
  const home = fixture()
  const rigsBefore = rigsOf(home)
  const runsBefore = readdirSync(join(home, 'runs')).sort()
  const to = join(tmp(), 'srv')
  split(home, to, splitPlan(home, to, origin), origin, editFor(home))
  join_(home, to, editFor(home))
  expect(rigsOf(home)).toEqual(rigsBefore)
  expect(readdirSync(join(home, 'runs')).sort()).toEqual(runsBefore)
  expect(readFileSync(join(home, 'runs/r-web/build.seen'), 'utf8')).toBe('3')
  expect(tombstone(home)).toBeUndefined()
})

test('join refuses with no tombstone, a clashing run id or a clashing rig name, and writes nothing', () => {
  const home = fixture()
  const to = join(tmp(), 'srv')
  expect(joinRefusal(home, to)).toMatch(/not split/)
  split(home, to, splitPlan(home, to, origin), origin, editFor(home))
  run(home, 'r-web', '/lap/web')
  expect(joinRefusal(home, to)).toMatch(/run r-web already exists/)
  rmSync(join(home, 'runs/r-web'), { recursive: true })
  editFor(home)(l => [...l, { name: 'web', repo: '/x', factory: 'lifecycle' }])
  expect(joinRefusal(home, to)).toMatch(/rig web already exists/)
  const before = listing(home)
  expect(() => join_(home, to, editFor(home))).toThrow()
  expect(listing(home)).toEqual(before)
})

test('tombstone throws on bad JSON and on a bad shape', () => {
  const home = tmp()
  expect(tombstone(home)).toBeUndefined()
  writeFileSync(tombstoneFile(home), '{nope')
  expect(() => tombstone(home)).toThrow(/unreadable/)
  writeFileSync(tombstoneFile(home), JSON.stringify({ to: 'x' }))
  expect(() => tombstone(home)).toThrow(/bad shape/)
})
