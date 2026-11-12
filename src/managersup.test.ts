import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKOFF_MS, supervisor, type TaskAx } from './managersup'

// gogxc.19: each event of contracts/manager-task.md gives the listed ax action
function rig(image = 'img:1') {
  const calls: string[] = []
  const st = { phase: null as string | null, clock: 0, failApply: false }
  const ax: TaskAx = {
    phase: () => st.phase,
    apply: async i => {
      calls.push(`apply ${i}`)
      if (st.failApply) throw new Error('apply refused')
    },
    remove: ws => (calls.push(ws ? 'delete task+workspace' : 'delete task'), undefined),
    suspend: () => void calls.push('suspend'),
    resume: () => void calls.push('resume'),
  }
  const home = mkdtempSync(join(tmpdir(), 'sup-'))
  const mk = () => supervisor({ home, ax, image, now: () => st.clock })
  return { calls, st, mk, sup: mk() }
}

test('pod start, no task: apply', async () => {
  const { calls, sup } = rig()
  expect(await sup.check()).toBe('created')
  expect(calls).toEqual(['apply img:1'])
})

test('a running task: nothing', async () => {
  const { calls, st, sup } = rig()
  st.phase = 'Running'
  expect(await sup.check()).toBe('running')
  expect(calls).toEqual([])
})

test('down for 3 checks: delete the task, apply; then back-off 1, 2, 4, 10, 10 min', async () => {
  const { calls, st, sup } = rig()
  st.phase = 'Failed'
  expect(await sup.check()).toBe('down')
  expect(await sup.check()).toBe('down')
  expect(calls).toEqual([])
  expect(await sup.check()).toBe('replaced')
  expect(calls).toEqual(['delete task', 'apply img:1'])
  // inside the back-off no second replace, however many checks
  for (let i = 0; i < 5; i++) expect(await sup.check()).toBe('backoff')
  const waits: number[] = []
  for (let i = 0; i < 5; i++) {
    const before = sup.state().nextAt
    st.clock = before
    expect(await sup.check()).toBe('replaced')
    waits.push(sup.state().nextAt - before)
  }
  expect(waits).toEqual([BACKOFF_MS[1]!, BACKOFF_MS[2]!, BACKOFF_MS[3]!, BACKOFF_MS[3]!, BACKOFF_MS[3]!])
})

test('a task that reaches Running clears the back-off', async () => {
  const { st, sup } = rig()
  st.phase = 'Failed'
  for (let i = 0; i < 3; i++) await sup.check()
  st.phase = 'Running'
  await sup.check()
  expect(sup.state()).toMatchObject({ down: 0, fails: 0, nextAt: 0 })
})

test('a person sets a new image: delete task and workspace, apply; ticks run in between; the image survives a restart', async () => {
  const { calls, st, mk, sup } = rig()
  st.phase = 'Running'
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  await sup.setImage('img:2')
  clearInterval(timer)
  expect(calls).toEqual(['delete task+workspace', 'apply img:2'])
  expect(ticks).toBeGreaterThan(0)
  expect(mk().state().image).toBe('img:2')
})

test('suspend: ax suspend, and the pod leaves the task alone until resume', async () => {
  const { calls, st, sup } = rig()
  await sup.suspend(true)
  st.phase = 'Suspended'
  expect(await sup.check()).toBe('suspended')
  await sup.suspend(false)
  expect(calls).toEqual(['suspend', 'resume'])
})

test('an ax failure backs off and never throws from check', async () => {
  const { st, sup } = rig()
  st.failApply = true
  expect(await sup.check()).toBe('error')
  expect(await sup.check()).toBe('backoff')
})

test('an empty image is refused', async () => {
  const { sup } = rig()
  await expect(sup.setImage(' ')).rejects.toThrow('empty')
})

test('the session task env has the pod address, no home and no backup knobs', async () => {
  const { sessionEnv } = await import('./ax')
  const env = sessionEnv({
    FACTORY_SERVER_MANAGER_URL: 'https://pod.example:8444',
    FACTORY_AX_BACKUP_REMOTE: 'https://example.invalid/r',
    FACTORY_AX_FRESH: '1',
  })
  expect(env.FACTORY_SERVER).toBe('https://pod.example:8444')
  for (const k of ['FACTORY_HOME', 'FACTORY_AX_BACKUP_REMOTE', 'FACTORY_AX_FRESH'])
    expect(k in env).toBe(false)
  expect(() => sessionEnv({})).toThrow('FACTORY_SERVER_MANAGER_URL')
})
