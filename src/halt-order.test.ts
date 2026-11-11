// claude-factory-gogxc.3: stop and resume change the halt state only under tick.lock; a busy lock queues them.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainHaltQueue, haltLine, haltSeq, runHaltCmd } from './halt-order'

const home = () => mkdtempSync(join(tmpdir(), 'halt-order-'))
const busy = () => null // a tick holds the lock
const free = () => () => {}
// a stand-in for applyHalt: the state is one file
const model = (h: string) => (cmd: 'stop' | 'resume') => {
  const f = join(h, 'halt.json')
  if (cmd === 'stop') {
    if (existsSync(f)) throw new Error('already stopping')
    writeFileSync(f, '{}')
  } else {
    if (!existsSync(f)) throw new Error('not stopped')
    rmSync(f)
    writeFileSync(join(h, 'resume.json'), '{}')
  }
  return cmd
}

test('resume while a tick holds the lock is queued, and the next tick applies it', async () => {
  const h = home()
  writeFileSync(join(h, 'halt.json'), '{}') // the tick read this halt
  const r = await runHaltCmd(h, busy, 'resume', model(h), 0)
  expect(r).toEqual({ queued: 1 })
  expect(existsSync(join(h, 'halt.json'))).toBe(true) // nothing changed while the lock was busy
  drainHaltQueue(h, model(h))
  expect(existsSync(join(h, 'halt.json'))).toBe(false)
  expect(existsSync(join(h, 'resume.json'))).toBe(true) // the workers resume
  expect(existsSync(join(h, 'halt-cmd.jsonl'))).toBe(false)
  rmSync(h, { recursive: true })
})

test('two resumes and one stop in one tick: the last command wins', async () => {
  const h = home()
  writeFileSync(join(h, 'halt.json'), '{}')
  for (const c of ['resume', 'resume', 'stop'] as const) await runHaltCmd(h, busy, c, model(h), 0)
  expect(haltSeq(h)).toBe(3)
  drainHaltQueue(h, model(h)) // resume lands, the second resume is refused, stop lands
  expect(existsSync(join(h, 'halt.json'))).toBe(true)
  rmSync(h, { recursive: true })
})

test('stop with a free lock applies at once, and a refusal reaches the caller', async () => {
  const h = home()
  expect(await runHaltCmd(h, free, 'stop', model(h))).toEqual({ out: 'stop' })
  await expect(runHaltCmd(h, free, 'stop', model(h))).rejects.toThrow('already')
  expect(readFileSync(join(h, 'halt-seq'), 'utf8')).toBe('2')
  rmSync(h, { recursive: true })
})

test('the first line of status names the halt state and its age', () => {
  const at = 1_000_000
  expect(haltLine({ state: 'paused', at, closed: { r1: 1, r2: 2 } }, at + 12 * 60_000)).toBe(
    'PAUSED for 12 min: 2 worker(s) wait for factory resume',
  )
  expect(haltLine({ state: 'stopping', at, closed: {} }, at)).toStartWith('STOPPING for 0 min')
})
