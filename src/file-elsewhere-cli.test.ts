// claude-factory-mrfa: `factory file-elsewhere` decides the factory label in code and fails closed.
// A fake bd on PATH logs every call. Fixtures use acme names only.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `file-elsewhere-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const calls = join(dir, 'calls.log')
const showFile = join(dir, 'show.out')
const showErr = join(dir, 'show.err')
const failShow = join(dir, 'fail-show')
const failCreate = join(dir, 'fail-create')
const failComment = join(dir, 'fail-comment')
const repoA = join(dir, 'acme-a')
const repoB = join(dir, 'acme-b')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, BEADS_ACTOR, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** `show` answers with `source` JSON, or fails with `fail` as its stderr when given */
function setup(source: unknown = [{ id: 'acme-1' }], fail?: string) {
  rmSync(dir, { recursive: true, force: true })
  for (const d of [home, bin, join(repoA, '.beads'), join(repoB, '.beads')]) mkdirSync(d, { recursive: true })
  writeFileSync(showFile, JSON.stringify(source))
  if (fail !== undefined) {
    writeFileSync(failShow, '')
    writeFileSync(showErr, fail)
  }
  writeFileSync(
    join(bin, 'bd'),
    [
      '#!/bin/sh',
      `printf '%s|%s|%s\\n' "$PWD" "$BEADS_ACTOR" "$(printf '%s' "$*" | tr '\\n' ' ')" >> '${calls}'`,
      'case "$1" in',
      `  show) if [ -e '${failShow}' ]; then printf '%s' '{"error":"not found"}'; cat '${showErr}' >&2; exit 1; fi; cat '${showFile}';;`,
      `  create) if [ -e '${failCreate}' ]; then echo 'create boom' >&2; exit 1; fi; printf '%s' 'acme-b-9';;`,
      `  comment) if [ -e '${failComment}' ]; then echo 'comment boom' >&2; exit 1; fi;;`,
      "  list) printf '%s' '[]';;",
      '  *) exit 0;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(join(bin, 'bd'), 0o755)
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([
      { name: 'acme-a', repo: repoA, factory: 'lifecycle' },
      { name: 'acme-b', repo: repoB, factory: 'lifecycle' },
    ]),
  )
}

const lines = () =>
  existsSync(calls)
    ? readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .filter(l => l.split('|').length >= 3)
    : []
const verb = (l: string) => l.split('|')[2]!.split(' ')[0]
const creates = () => lines().filter(l => verb(l) === 'create')
const ARGS = [
  'file-elsewhere',
  'acme-b',
  '--from',
  'acme-a:acme-1',
  '--title',
  'Fix widget',
  '--description',
  'It breaks',
]
const meta = (l: string) => JSON.parse(l.match(/--metadata (\{.*?\})(?= |$)/)![1]!)

test('a plain source files with the factory label and discovered_from, then comments on the source (AC1, AC7)', () => {
  setup()
  const r = factory(ARGS)
  expect(r.code).toBe(0)
  expect(r.out).toContain('acme-b-9')
  expect(creates()).toHaveLength(1)
  const c = creates()[0]!
  expect(c.split('|')[0]!.endsWith('/acme-b')).toBe(true)
  expect(c).toContain('--actor factory')
  expect(c).toContain('-l factory')
  expect(meta(c).discovered_from).toBe('acme-1')
  expect(c).toContain('acme-a:acme-1')
  const cm = lines().filter(l => verb(l) === 'comment')
  expect(cm).toHaveLength(1)
  expect(cm[0]!.split('|')[0]!.endsWith('/acme-a')).toBe(true)
  expect(cm[0]).toContain('comment acme-1')
  expect(cm[0]).toContain('acme-b-9')
})

test('BEADS_ACTOR from the env is the bd actor (AC7)', () => {
  setup()
  expect(factory(ARGS, { BEADS_ACTOR: 'alice' }).code).toBe(0)
  expect(creates()[0]).toContain('--actor alice')
})

test.each(['https://linear.app/acme/issue/W-1', 'https://LINEAR.APP/acme/issue/W-1'])(
  'a Linear source files without the label (AC2) %s',
  ref => {
    setup([{ id: 'acme-1', external_ref: ref }])
    expect(factory(ARGS).code).toBe(0)
    expect(creates()).toHaveLength(1)
    expect(creates()[0]).not.toContain('-l factory')
    expect(meta(creates()[0]!).discovered_from).toBe('acme-1')
  },
)

test.each(['Error fetching acme-1: dolt stall', 'Issue acme-1 not found', 'something unknown'])(
  'a failed read files nothing (AC3) %s',
  stderr => {
    setup(undefined, stderr)
    expect(factory(ARGS).code).toBe(1)
    expect(creates()).toHaveLength(0)
  },
)

test.each([[[]], [[{ id: 'acme-2' }]]])('an empty or foreign read files nothing (AC3) %j', source => {
  setup(source)
  expect(factory(ARGS).code).toBe(1)
  expect(creates()).toHaveLength(0)
})

const F = ['--from', 'acme-a:acme-1']
const TD = ['--title', 't', '--description', 'd']
const bad: [string, string[]][] = [
  ['no args', ['file-elsewhere']],
  ['missing --title', ['file-elsewhere', 'acme-b', ...F, '--description', 'd']],
  ['empty description', ['file-elsewhere', 'acme-b', ...F, '--title', 't', '--description', '']],
  ['repeated --from', [...ARGS, ...F]],
  ['extra word', [...ARGS, 'extra']],
  ['no colon', ['file-elsewhere', 'acme-b', '--from', 'acme-1', ...TD]],
  ['unknown target', ['file-elsewhere', 'nope', ...F, ...TD]],
  ['unknown source', ['file-elsewhere', 'acme-b', '--from', 'nope:acme-1', ...TD]],
  ['path target', ['file-elsewhere', './x', ...F, ...TD]],
  ['same rig', ['file-elsewhere', 'acme-a', ...F, ...TD]],
  ['bad id', ['file-elsewhere', 'acme-b', '--from', 'acme-a:acme-1;x', ...TD]],
]
test.each(bad)('grammar: %s exits 1 with no bd call (AC4)', (_n, args) => {
  setup()
  expect(factory(args).code).toBe(1)
  expect(lines()).toHaveLength(0)
})

/** a run whose bead is `bead` in `repo` */
function run(bead: string, repo: string) {
  const d = join(home, 'runs', 'r1')
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id: 'r1', factory: 'x', repo, goal: 'g', ws: 'w', worktree: repo, branch: 'b', bead }),
  )
}

test('a worker files only from its own run bead (AC5)', () => {
  setup()
  run('acme-1', repoA)
  expect(factory(ARGS, { FACTORY_RUN: 'r1' }).code).toBe(0)
  expect(creates()).toHaveLength(1)
})

test('a worker is refused for another bead, another rig or no run (AC5)', () => {
  setup()
  run('acme-1', repoA)
  const other = ARGS.map(a => (a === 'acme-a:acme-1' ? 'acme-a:acme-9' : a))
  expect(factory(other, { FACTORY_RUN: 'r1' }).code).toBe(1)
  run('acme-1', repoB)
  expect(factory(ARGS, { FACTORY_RUN: 'r1' }).code).toBe(1)
  expect(factory(ARGS, { FACTORY_FROM: 'triage' }).code).toBe(1)
  expect(factory(ARGS, { BEADS_ACTOR: 'factory/r1/triage' }).code).toBe(1)
  expect(lines()).toHaveLength(0)
})

test('a create failure exits 1 and checks the token before any retry (AC6)', () => {
  setup()
  writeFileSync(failCreate, '')
  expect(factory(ARGS).code).toBe(1)
  expect(lines().some(l => verb(l) === 'list' && l.includes('factory_create='))).toBe(true)
  expect(lines().some(l => verb(l) === 'comment')).toBe(false)
})

test('a comment failure after the create names the new id (AC6)', () => {
  setup()
  writeFileSync(failComment, '')
  const r = factory(ARGS)
  expect(r.code).toBe(1)
  expect(r.err).toContain('acme-b-9')
  expect(creates()).toHaveLength(1)
})
