import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homeReady } from './managerhost'
import {
  claudeFiles,
  describe,
  localLiveRuns,
  migratedRigs,
  pack,
  plan,
  projectSlug,
  runsToMove,
  selectTop,
} from './migrate'

const state = (value: string, pane: string | null) =>
  JSON.stringify({ cursor: 0, snapshot: { value, context: { pane, log: [] } } })

function fixture(runs: Record<string, [string, string | null, number]>) {
  const home = mkdtempSync(join(tmpdir(), 'migrate-'))
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'alpha', repo: '/home/u/repos/alpha' }]))
  for (const f of ['decisions.json', 'dispatch.json', 'metrics.jsonl', 'manager-sessions.json', 'sync.json'])
    writeFileSync(join(home, f), '{}')
  for (const f of ['tick.lock', 'rigs.json.bak-1', 'herdr.log']) writeFileSync(join(home, f), 'x')
  writeFileSync(join(home, 'huge.log'), Buffer.alloc(6 * 1024 * 1024))
  for (const d of ['memory', 'launch', 'bin', 'devenv']) mkdirSync(join(home, d))
  for (const [id, [value, pane, at]] of Object.entries(runs)) {
    mkdirSync(join(home, 'runs', id), { recursive: true })
    const f = join(home, 'runs', id, 'state.json')
    writeFileSync(f, state(value, pane))
    utimesSync(f, at, at)
  }
  return home
}
const origin = (repo: string) => (repo.endsWith('alpha') ? 'git@github.com:example/alpha.git' : undefined)

test('selectTop keeps the state files and dirs, and leaves the lock, backups, caches and big files', () => {
  const home = fixture({})
  const p = plan(home, 5, origin)
  expect(p.top.sort()).toEqual(
    [
      'decisions.json',
      'dispatch.json',
      'launch',
      'manager-sessions.json',
      'memory',
      'metrics.jsonl',
      'sync.json',
    ].sort(),
  )
  expect(p.skipped).toEqual(['huge.log'])
  expect(selectTop([{ name: 'metrics.jsonl', dir: false, bytes: 99_000_000 }]).take).toEqual([
    'metrics.jsonl',
  ])
})

test('live runs always move; of the finished runs only the newest N', () => {
  const home = fixture({
    old: ['done', null, 100],
    mid: ['aborted', null, 200],
    new: ['done', null, 300],
    live: ['implement.working', 'ax://f-live-1', 50],
    gate: ['approve.waiting', null, 10],
  })
  const p = plan(home, 2, origin)
  expect(p.runs.sort()).toEqual(['gate', 'live', 'mid', 'new'])
  expect(p.left).toBe(1)
  expect(p.refusal).toBeUndefined()
})

test('a live run with a worker in a local herdr pane refuses the move and is named', () => {
  const home = fixture({ pane: ['implement.working', 'w3:p2', 1], ok: ['verify.working', 'ax://f-ok-1', 1] })
  const p = plan(home, 5, origin)
  expect(p.refusal).toContain('pane (w3:p2)')
  expect(p.refusal).not.toContain('ok (')
  expect(p.refusal).toContain('Finish or abort them')
})

test('a finished run with a stale pane does not block', () => {
  const runs = [{ id: 'd', live: false, pane: 'w1:p1', finishedAt: 1 }]
  expect(localLiveRuns(runs)).toEqual([])
  expect(runsToMove(runs, 0)).toEqual([])
})

test('migrated rigs gain an https remote from origin, keep repo, and name a rig with no origin', () => {
  const ok = migratedRigs([{ name: 'alpha', repo: '/home/u/repos/alpha' }], origin)
  expect(ok.rigs).toEqual([
    { name: 'alpha', repo: '/home/u/repos/alpha', remote: 'https://github.com/example/alpha.git' },
  ])
  expect(ok.error).toBeUndefined()
  expect(migratedRigs([{ name: 'beta', repo: '/home/u/repos/beta' }], origin).error).toContain('rig beta')
})

test('the host waits on an empty home for the marker, and starts on a marker, a fresh flag, or a hand-made home', () => {
  const f = { migrated: false, fresh: false, hasRigs: false, archive: false }
  expect(homeReady(f)).toBe(false)
  expect(homeReady({ ...f, migrated: true })).toBe(true)
  expect(homeReady({ ...f, fresh: true })).toBe(true)
  expect(homeReady({ ...f, hasRigs: true })).toBe(true)
  expect(homeReady({ ...f, hasRigs: true, archive: true })).toBe(false)
})

test('pack makes a tar.gz with the migrated rigs.json and without the laptop-only files', () => {
  const home = fixture({ r1: ['implement.working', 'ax://f-r1-1', 1], gone: ['done', null, 1] })
  const p = plan(home, 0, origin)
  const out = join(mkdtempSync(join(tmpdir(), 'migrate-out-')), 'm.tgz')
  expect(pack(home, p, out)).toBeGreaterThan(0)
  const names = Bun.spawnSync(['tar', '-tzf', out]).stdout.toString()
  expect(names).toContain('rigs.json')
  expect(names).toContain('runs/r1/state.json')
  expect(names).not.toContain('runs/gone')
  expect(names).not.toContain('tick.lock')
  const rigs = Bun.spawnSync(['tar', '-xzOf', out, 'rigs.json']).stdout.toString()
  expect(JSON.parse(rigs)[0].remote).toBe('https://github.com/example/alpha.git')
})

test("pack carries the manager's Claude memory and session transcripts, with each session's cwd set to the task's", () => {
  const home = fixture({})
  const cwd = '/home/u/factory'
  writeFileSync(join(home, 'manager-sessions.json'), JSON.stringify([{ session: 's1', cwd }]))
  const config = mkdtempSync(join(tmpdir(), 'migrate-claude-'))
  const project = join(config, 'projects', projectSlug(cwd))
  mkdirSync(join(project, 'memory'), { recursive: true })
  writeFileSync(join(project, 'memory', 'MEMORY.md'), '- a note')
  writeFileSync(join(project, 's1.jsonl'), '{}')
  writeFileSync(join(project, 'other.jsonl'), '{}')
  expect(projectSlug(cwd)).toBe('-home-u-factory')
  expect(claudeFiles([{ session: 's1', cwd }], config).map(f => f.slice(project.length))).toEqual([
    '/memory',
    '/s1.jsonl',
  ])
  const p = plan(home, 0, origin, config)
  expect(describe(p)).toContain("the manager's Claude: memory, s1.jsonl")
  const out = join(mkdtempSync(join(tmpdir(), 'migrate-out-')), 'm.tgz')
  pack(home, p, out)
  const names = Bun.spawnSync(['tar', '-tzf', out]).stdout.toString()
  expect(names).toContain('claude-project/memory/MEMORY.md')
  expect(names).toContain('claude-project/s1.jsonl')
  expect(names).not.toContain('other.jsonl')
  expect(names.match(/manager-sessions\.json/g)).toHaveLength(1)
  const sessions = Bun.spawnSync(['tar', '-xzOf', out, 'manager-sessions.json']).stdout.toString()
  expect(JSON.parse(sessions)).toEqual([{ session: 's1', cwd: '/workspace/w' }])
})
