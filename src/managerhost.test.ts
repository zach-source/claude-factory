import { expect, test } from 'bun:test'
import { backupStep, decide, lastSession, managerLine, restoreStep, withResume } from './managerhost'

const free = () => () => {}

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

test('AC7: a backup step logs its result, never throws, and skips while the tick lock is held', () => {
  const lines: string[] = []
  const log = (m: string) => lines.push(m)
  const boom = (): never => {
    throw new Error('disk full')
  }
  const cfg = { ws: '/w', remote: 'r', branch: 'b' }
  expect(() => backupStep(cfg, true, free, log, boom)).not.toThrow()
  expect(lines.at(-1)).toBe('backup failed: disk full')
  let released = 0
  backupStep(
    cfg,
    true,
    () => () => void released++,
    log,
    () => ({ sha: 'abc', changed: true }),
  )
  expect(released).toBe(1)
  expect(lines.at(-1)).toBe('backup abc')
  backupStep(cfg, true, () => null, log, boom)
  expect(lines.at(-1)).toBe('backup skipped: a tick holds the lock')
  backupStep(cfg, false, free, log, () => ({ error: 'backup refused: home is not ready' }))
  expect(lines.at(-1)).toBe('backup refused: home is not ready')
  const n = lines.length
  backupStep({ ...cfg, remote: undefined }, true, free, log, boom)
  expect(lines.length).toBe(n)
})

test('AC1/AC6: the restore step logs what it did and never throws', () => {
  const lines: string[] = []
  const log = (m: string) => lines.push(m)
  const cfg = { ws: '/w', remote: 'r', branch: 'b' }
  restoreStep({ ...cfg, remote: undefined }, log, () => ({ skipped: 'no remote' }))
  expect(lines).toEqual([])
  restoreStep(cfg, log, () => ({ restored: 'abc' }))
  expect(lines.at(-1)).toBe('restored abc')
  restoreStep(cfg, log, () => ({ skipped: 'no backup' }))
  expect(lines.at(-1)).toContain('no backup')
  restoreStep(cfg, log, () => ({ error: 'x' }))
  expect(lines.at(-1)).toBe('restore failed: x')
  restoreStep(cfg, log, () => {
    throw new Error('y')
  })
  expect(lines.at(-1)).toBe('restore failed: y')
})

test('the pane line quotes what the shell would split', () => {
  expect(managerLine(['--model', 'a b'], 's')).toBe("factory manager --model 'a b' --resume s")
})
