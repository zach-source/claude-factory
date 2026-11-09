import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homeReady, markerOk } from './managerhost'
import {
  claudeFiles,
  describe,
  isPushed,
  localLiveRuns,
  migratedRigs,
  pack,
  plan,
  projectSlug,
  runsToMove,
  selectTop,
  sha256File,
  staleMemoryOf,
} from './migrate'

const state = (value: string, pane: string | null) =>
  JSON.stringify({ cursor: 0, snapshot: { value, context: { pane, log: [] } } })

function fixture(runs: Record<string, [string, string | null, number]>) {
  const home = mkdtempSync(join(tmpdir(), 'migrate-'))
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'alpha', repo: '/home/u/repos/alpha' }]))
  for (const f of ['decisions.json', 'dispatch.json', 'metrics.jsonl', 'manager-sessions.json', 'sync.json'])
    writeFileSync(join(home, f), '{}')
  for (const f of ['tick.lock', 'rigs.json.bak-1', 'herdr.log', 'manager-host.log'])
    writeFileSync(join(home, f), 'x')
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

test('the plan leaves out manager-host.log: the host in the task writes its own, and keeps the file open', () => {
  expect(plan(fixture({}), 5, origin).top).not.toContain('manager-host.log')
})

test('the plan lists the live runs whose branch is not on origin, and describe names them', () => {
  const home = fixture({
    a: ['implement.working', 'ax://f-a-1', 1],
    b: ['verify.working', null, 1],
    c: ['done', null, 1],
  })
  for (const id of ['a', 'b', 'c'])
    writeFileSync(
      join(home, 'runs', id, 'run.json'),
      JSON.stringify({ id, repo: '/r', worktree: `/w/${id}`, branch: `factory/${id}` }),
    )
  const p = plan(home, 5, origin, undefined, r => r.id !== 'b')
  expect(p.unpushed).toEqual(['b'])
  expect(describe(p)).toContain('live runs whose branch is not pushed: b')
  expect(plan(home, 5, origin, undefined, () => true).unpushed).toEqual([])
})

test('isPushed: the worktree head, else the local branch, must be on origin', () => {
  const sh = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(a, { cwd })
    if (p.exitCode !== 0) throw new Error(`${a.join(' ')}: ${p.stderr}`)
  }
  const d = mkdtempSync(join(tmpdir(), 'migrate-push-'))
  const origin = join(d, 'o.git')
  const repo = join(d, 'repo')
  sh(d, 'git', 'init', '-q', '--bare', origin)
  sh(d, 'git', 'clone', '-q', origin, repo)
  const commit = (m: string) => {
    writeFileSync(join(repo, 'f'), m)
    sh(repo, 'git', 'add', '.')
    sh(repo, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', m)
  }
  commit('base')
  sh(repo, 'git', 'push', '-q', 'origin', 'HEAD:refs/heads/factory/p')
  sh(repo, 'git', 'branch', 'factory/p')
  const run = { id: 'p', repo, worktree: join(d, 'gone'), branch: 'factory/p' }
  expect(isPushed(run)).toBe(true)
  expect(isPushed({ ...run, branch: 'factory/none' })).toBe(false)
  // a commit only on the laptop
  sh(repo, 'git', 'worktree', 'add', '-q', join(d, 'wt'), 'factory/p')
  writeFileSync(join(d, 'wt', 'g'), 'x')
  sh(join(d, 'wt'), 'git', 'add', '.')
  sh(join(d, 'wt'), 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'local')
  expect(isPushed({ ...run, worktree: join(d, 'wt') })).toBe(false)
  sh(join(d, 'wt'), 'git', 'push', '-q', 'origin', 'HEAD:refs/heads/factory/p')
  expect(isPushed({ ...run, worktree: join(d, 'wt') })).toBe(true)
  // d289.17: a worker pushed newer commits that this repo has not fetched; the worktree head is on origin
  const other = join(d, 'other')
  sh(d, 'git', 'clone', '-q', '-b', 'factory/p', origin, other)
  writeFileSync(join(other, 'h'), 'x')
  sh(other, 'git', 'add', '.')
  sh(other, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'worker')
  sh(other, 'git', 'push', '-q', 'origin', 'HEAD:refs/heads/factory/p')
  expect(isPushed({ ...run, worktree: join(d, 'wt') })).toBe(true)
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
  expect(homeReady({ ...f, migrated: true, restoring: true })).toBe(false)
  expect(homeReady({ ...f, fresh: true, restoring: true })).toBe(false)
  // a launch id set: a hand-made home is not enough, since an old workspace has rigs.json too
  expect(homeReady({ ...f, hasRigs: true, launch: true })).toBe(false)
  expect(homeReady({ ...f, migrated: true, launch: true })).toBe(true)
})

test('markerOk trusts a .migrated of this launch only; with no launch id, any marker', () => {
  expect(markerOk('2026-11-09T10:00:00Z launch=id-1\n', 'id-1')).toBe(true)
  expect(markerOk('restored abc123 launch=id-1\n', 'id-1')).toBe(true)
  expect(markerOk('2026-11-09T10:00:00Z launch=id-0\n', 'id-1')).toBe(false)
  expect(markerOk('2026-10-19T10:00:00Z\n', 'id-1')).toBe(false)
  expect(markerOk('launch=id-10\n', 'id-1')).toBe(false)
  expect(markerOk('2026-10-19T10:00:00Z\n', undefined)).toBe(true)
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

test('pack and the plan size leave out runs/*/transcripts', () => {
  const home = fixture({ r1: ['implement.working', 'ax://f-r1-1', 1] })
  const before = plan(home, 0, origin).bytes
  mkdirSync(join(home, 'runs', 'r1', 'transcripts'))
  writeFileSync(join(home, 'runs', 'r1', 'transcripts', 'x.jsonl'), Buffer.alloc(5000))
  const p = plan(home, 0, origin)
  expect(p.bytes).toBe(before)
  const out = join(mkdtempSync(join(tmpdir(), 'migrate-out-')), 'm.tgz')
  pack(home, p, out)
  const names = Bun.spawnSync(['tar', '-tzf', out]).stdout.toString()
  expect(names).toContain('runs/r1/state.json')
  expect(names).not.toContain('transcripts')
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

test('each run keeps only its newest memory archive: the highest seq, then the newest mtime', () => {
  const f = (name: string, mtimeMs = 0) => ({ name, mtimeMs })
  expect(
    staleMemoryOf([f('t-2.memory.tgz'), f('t-10.memory.tgz'), f('t-3.memory.tgz'), f('state.json')]).sort(),
  ).toEqual(['t-2.memory.tgz', 't-3.memory.tgz'])
  expect(staleMemoryOf([f('a.memory.tgz', 1), f('b.memory.tgz', 2)])).toEqual(['a.memory.tgz'])
  expect(staleMemoryOf([f('t-1.memory.tgz')])).toEqual([])
  expect(staleMemoryOf([f('state.json')])).toEqual([])
})

test('pack and the plan size leave out the older memory archives of a run', () => {
  const home = fixture({ r1: ['implement.working', 'ax://f-r1-3', 1] })
  const before = plan(home, 0, origin).bytes
  for (const seq of [1, 2, 3])
    writeFileSync(join(home, 'runs', 'r1', `f-r1-${seq}.memory.tgz`), Buffer.alloc(1000))
  const p = plan(home, 0, origin)
  expect(p.staleMemory.sort()).toEqual(['runs/r1/f-r1-1.memory.tgz', 'runs/r1/f-r1-2.memory.tgz'])
  expect(p.staleBytes).toBe(2000)
  expect(p.bytes).toBe(before + 1000)
  expect(describe(p)).toContain('older memory archives left behind: 2')
  const out = join(mkdtempSync(join(tmpdir(), 'migrate-out-')), 'm.tgz')
  pack(home, p, out)
  const names = Bun.spawnSync(['tar', '-tzf', out]).stdout.toString()
  expect(names).toContain('runs/r1/f-r1-3.memory.tgz')
  expect(names).not.toContain('f-r1-1.memory.tgz')
  expect(names).not.toContain('f-r1-2.memory.tgz')
})

test('sha256File is the sha256 of the bytes, also past one read block', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'migrate-sha-')), 'f')
  const data = Buffer.alloc(3 * 1024 * 1024 + 7, 7)
  writeFileSync(file, data)
  expect(sha256File(file)).toBe(new Bun.CryptoHasher('sha256').update(data).digest('hex'))
})
