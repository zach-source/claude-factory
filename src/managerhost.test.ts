import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  awaitHome,
  backupStep,
  decide,
  lastSession,
  managerLine,
  restoreStep,
  sessionLoop,
  warmMemory,
  withResume,
} from './managerhost'

const free = () => () => {}
const nap = async () => {}

test('d289.18: a backup that finds the tick lock tries again each second and logs the skip once', async () => {
  const lines: string[] = []
  const cfg = { ws: '/w', remote: 'r', branch: 'b' }
  let calls = 0
  let naps = 0
  const busyTwice = () => (++calls <= 2 ? { skipped: 'lock' as const } : { sha: 'abc', changed: true })
  await backupStep(
    cfg,
    true,
    free,
    m => lines.push(m),
    busyTwice,
    120,
    async () => void naps++,
  )
  expect([calls, naps, lines]).toEqual([3, 2, ['backup abc']])
  calls = 0
  const busy = () => (++calls, { skipped: 'lock' as const })
  await backupStep(cfg, true, free, m => lines.push(m), busy, 4, nap)
  expect(calls).toBe(4)
  expect(lines.slice(1)).toEqual(['backup skipped: a tick held the lock at 4 tries'])
})

test('d289.21: the backup step writes backup.want before it tries the lock, and removes it at the end', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'mhost-'))
  mkdirSync(join(ws, 'home'))
  const want = join(ws, 'home', 'backup.want')
  const cfg = { ws, remote: 'r', branch: 'b' }
  const seen: boolean[] = []
  let n = 0
  const busy = () => (
    seen.push(existsSync(want)),
    ++n < 600 ? { skipped: 'lock' as const } : { sha: 'a', changed: true }
  )
  const lines: string[] = []
  // the default: 600 tries of 1 s, 10 min
  await backupStep(cfg, true, free, m => lines.push(m), busy, undefined, nap)
  expect([n, seen.every(Boolean), existsSync(want), lines]).toEqual([600, true, false, ['backup a']])
  rmSync(ws, { recursive: true, force: true })
})

test('herdr down restarts everything, a live herdr with no pane restarts the manager only', () => {
  expect(decide({ herdrUp: false, panes: 0 })).toBe('restart-all')
  expect(decide({ herdrUp: true, panes: 0 })).toBe('start-manager')
  expect(decide({ herdrUp: true, panes: 1 })).toBe('none')
})

test('a restart resumes the newest known session and replaces an old --resume', () => {
  expect(withResume(['--model', 'x'])).toEqual(['--model', 'x'])
  expect(withResume(['--model', 'x'], 's2')).toEqual(['--model', 'x', '--resume', 's2'])
  expect(withResume(['-r', 's1', '--model', 'x'], 's2')).toEqual(['--model', 'x', '--resume', 's2'])
  expect(lastSession(JSON.stringify([{ session: 's1' }, { session: 's2' }]))).toBe('s2')
  expect(lastSession('[]')).toBeUndefined()
  expect(lastSession('not json')).toBeUndefined()
})

test('AC7: a backup step logs its result, never throws, and skips while the tick lock is held', async () => {
  const lines: string[] = []
  const log = (m: string) => lines.push(m)
  const boom = (): never => {
    throw new Error('disk full')
  }
  const cfg = { ws: '/w', remote: 'r', branch: 'b' }
  expect(backupStep(cfg, true, free, log, boom)).resolves.toBeUndefined()
  await Bun.sleep(0)
  expect(lines.at(-1)).toBe('backup failed: disk full')
  await backupStep(cfg, true, free, log, () => ({ sha: 'abc', changed: true }))
  expect(lines.at(-1)).toBe('backup abc')
  await backupStep(cfg, true, free, log, () => ({
    sha: 'b',
    changed: true,
    redacted: ['github-pat home/m.md'],
  }))
  expect(lines.slice(-2)).toEqual(['backup b', 'backup redacted github-pat home/m.md'])
  await backupStep(cfg, true, free, log, () => ({ skipped: 'lock' }), 3, nap)
  expect(lines.at(-1)).toBe('backup skipped: a tick held the lock at 3 tries')
  await backupStep(cfg, false, free, log, () => ({ error: 'backup refused: home is not ready' }))
  expect(lines.at(-1)).toBe('backup refused: home is not ready')
  const n = lines.length
  await backupStep({ ...cfg, remote: undefined }, true, free, log, boom)
  expect(lines.length).toBe(n)
})

test('AC1/AC6: the restore step logs what it did and never throws', () => {
  const lines: string[] = []
  const log = (m: string) => lines.push(m)
  const cfg = { ws: '/w', remote: 'r', branch: 'b' }
  expect(restoreStep({ ...cfg, remote: undefined }, log, () => ({ skipped: 'no remote' }))).toBe(false)
  expect(lines).toEqual([])
  expect(restoreStep(cfg, log, () => ({ restored: 'abc' }))).toBe(false)
  expect(lines.at(-1)).toBe('restored abc')
  expect(restoreStep(cfg, log, () => ({ skipped: 'no backup' }))).toBe(false)
  expect(lines.at(-1)).toContain('no backup')
  expect(restoreStep(cfg, log, () => ({ error: 'x' }))).toBe(true)
  expect(lines.at(-1)).toBe('restore failed: x')
  const r = restoreStep(cfg, log, () => {
    throw new Error('y')
  })
  expect(r).toBe(true)
  expect(lines.at(-1)).toBe('restore failed: y')
})

test('a failed restore keeps the host waiting even when the home is ready (FACTORY_AX_FRESH)', async () => {
  const answers = [true, true, false]
  let calls = 0
  let sleeps = 0
  await awaitHome(
    () => true,
    () => (calls++, answers.shift()!),
    async () => void sleeps++,
  )
  expect(calls).toBe(3)
  expect(sleeps).toBe(2)
})

test('the pane line quotes what the shell would split', () => {
  expect(managerLine(['--model', 'a b'], 's')).toBe("factory manager --model 'a b' --resume s")
})

test('f4bwc: warmMemory builds the vector cache once when it is missing and logs the time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warm-'))
  const lines: string[] = []
  const log = (m: string) => lines.push(m)
  let runs = 0
  const run = () => {
    runs++
    return 0
  }
  warmMemory(dir, log, run) // no memory dir: nothing to embed
  expect(runs).toBe(0)
  mkdirSync(join(dir, 'memory'))
  warmMemory(dir, log, run)
  expect(runs).toBe(1)
  expect(lines.at(-1)).toMatch(/^memory cache warm: \d+ ms$/)
  writeFileSync(join(dir, 'memory', '.index.json'), '{}')
  warmMemory(dir, log, run) // cache present: skip
  expect(runs).toBe(1)
  rmSync(join(dir, 'memory', '.index.json'))
  warmMemory(dir, log, () => 1)
  expect(lines.at(-1)).toContain('failed')
})

test('gogxc.17: the session loop posts health each beat, restarts what is down, and touches no home', async () => {
  const calls: string[] = []
  const rows: { action: string; panes: number }[] = []
  const panes = [2, 0, -1, 1]
  let beat = 0
  await sessionLoop({
    bringUp: async () => void calls.push('up'),
    startManager: () => void calls.push('manager'),
    panes: () => panes[beat++]!,
    health: r => rows.push(r),
    sleep: async () => {},
    log: m => calls.push(`log ${m}`),
    stop: () => beat >= panes.length,
  })
  expect(rows.map(r => [r.action, r.panes])).toEqual([
    ['none', 2],
    ['start-manager', 0],
    ['restart-all', 0],
    ['none', 1],
  ])
  expect(calls).toEqual([
    'up',
    'log start-manager: herdr has no pane',
    'manager',
    'log restart-all: herdr is down',
    'up',
  ])
})
