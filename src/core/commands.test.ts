import { describe, expect, test } from 'bun:test'
import { commandStore } from './commands'

const gate = () => {
  let go!: (r: Response) => void
  const p = new Promise<Response>(r => (go = r))
  return { p, go }
}
const tick = () => new Promise(r => setTimeout(r, 5))

describe('commandStore', () => {
  test('202, running, done, one event per change', async () => {
    const ev: string[] = []
    const s = commandStore(id => ev.push(id))
    const g = gate()
    const res = s.start('fixture.wait', () => g.p)
    expect(res.status).toBe(202)
    const { commandId, status } = (await res.json()) as { commandId: string; status: string }
    expect(status).toBe('accepted')
    expect(s.get(commandId)?.status).toBe('running')
    g.go(new Response('{"a":1}', { status: 200 }))
    await tick()
    const c = s.get(commandId)!
    expect(c.status).toBe('done')
    expect(c.result).toEqual({ status: 200, body: '{"a":1}' })
    expect(c.actor).toBe('person')
    expect(c.doneAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(ev.length).toBe(3)
    expect(new Set(ev)).toEqual(new Set([commandId]))
  })
  test('status 422 gives failed; a throw gives failed 500; body cut at 65536', async () => {
    const s = commandStore(() => {})
    const a = (
      (await s.start('x', async () => new Response('no', { status: 422 })).json()) as { commandId: string }
    ).commandId
    const b = (
      (await s
        .start('x', async () => {
          throw new Error('boom')
        })
        .json()) as { commandId: string }
    ).commandId
    const c = (
      (await s.start('x', async () => new Response('z'.repeat(70000))).json()) as { commandId: string }
    ).commandId
    await tick()
    expect(s.get(a)).toMatchObject({ status: 'failed', result: { status: 422 } })
    expect(s.get(b)).toMatchObject({ status: 'failed', result: { status: 500 } })
    expect(s.get(c)?.result?.body.length).toBe(65536)
  })
  test('get: bad or unknown id gives undefined', () => {
    const s = commandStore(() => {})
    expect(s.get('nope')).toBeUndefined()
    expect(s.get('0'.repeat(36))).toBeUndefined()
  })
  test('cap: drops the oldest finished; 503 and no run when all run', async () => {
    const s = commandStore(() => {}, 2)
    const g = gate()
    const first = ((await s.start('x', async () => new Response('')).json()) as { commandId: string })
      .commandId
    await tick()
    s.start('x', () => g.p)
    expect(s.start('x', () => g.p).status).toBe(202)
    expect(s.get(first)).toBeUndefined()
    let ran = false
    const full = s.start('x', async () => {
      ran = true
      return new Response('')
    })
    expect(full.status).toBe(503)
    expect(await full.json()).toEqual({ refused: 'too many running commands' })
    expect(ran).toBe(false)
    g.go(new Response(''))
  })
})
