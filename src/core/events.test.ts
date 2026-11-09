import { describe, expect, test } from 'bun:test'
import { eventLog, sseResponse } from './events'

describe('eventLog', () => {
  test('seq and revision', () => {
    const l = eventLog()
    expect(l.emit('a')).toEqual({ seq: 1, resource: 'a', revision: 1 })
    expect(l.emit('b')).toEqual({ seq: 2, resource: 'b', revision: 1 })
    expect(l.emit('a')).toEqual({ seq: 3, resource: 'a', revision: 2 })
    expect(l.epoch).toMatch(/^[0-9a-f]{8}$/)
  })
  test('after: window, errors', () => {
    const l = eventLog(3)
    for (const r of ['a', 'b', 'c', 'd', 'e']) l.emit(r)
    const c = (n: number) => `${l.epoch}-${n}`
    expect((l.after(c(3)) as { seq: number }[]).map(e => e.seq)).toEqual([4, 5])
    expect((l.after(c(2)) as { seq: number }[]).map(e => e.seq)).toEqual([3, 4, 5])
    expect(l.after(c(1))).toBe('snapshot_required')
    expect(l.after(c(5))).toEqual([])
    expect(l.after(c(6))).toBe('snapshot_required')
    expect(l.after(`${l.epoch === 'ffffffff' ? '00000000' : 'ffffffff'}-3`)).toBe('snapshot_required')
    for (const bad of [
      '',
      'x',
      `${l.epoch}-`,
      `${l.epoch}--1`,
      `${l.epoch}-1234567890123456`,
      `${l.epoch.toUpperCase()}-1`,
      ` ${l.epoch}-1`,
    ])
      expect(l.after(bad)).toBe('bad cursor')
  })
  test('<epoch>-0 is valid while seq 1 is kept', () => {
    const l = eventLog()
    l.emit('a')
    expect(l.after(`${l.epoch}-0`)).toHaveLength(1)
  })
  test('cap 1000', () => {
    const l = eventLog()
    for (let i = 0; i < 1500; i++) l.emit('x')
    expect((l.after(`${l.epoch}-500`) as unknown[]).length).toBe(1000)
    expect(l.after(`${l.epoch}-499`)).toBe('snapshot_required')
  })
  test('subscribe and unsubscribe', () => {
    const l = eventLog()
    const got: number[] = []
    const off = l.subscribe(e => got.push(e.seq))
    l.emit('a')
    off()
    l.emit('a')
    expect(got).toEqual([1])
  })
})

describe('sseResponse', () => {
  test('bad cursor 400, stale 409, frames, close', async () => {
    const l = eventLog()
    expect(sseResponse(l, 'zz').status).toBe(400)
    expect(sseResponse(l, `${l.epoch}-7`).status).toBe(409)
    l.emit('a')
    const r = sseResponse(l, `${l.epoch}-0`)
    expect(r.headers.get('content-type')).toBe('text/event-stream')
    const rd = r.body!.getReader()
    const dec = new TextDecoder()
    expect(dec.decode((await rd.read()).value)).toBe(
      `id: ${l.epoch}-1\nevent: change\ndata: {"seq":1,"resource":"a","revision":1}\n\n`,
    )
    l.emit('b')
    expect(dec.decode((await rd.read()).value)).toContain(`id: ${l.epoch}-2\n`)
    l.close()
    expect((await rd.read()).done).toBe(true)
  })
  test('no cursor: only new events; heartbeat', async () => {
    const l = eventLog()
    l.emit('old')
    const rd = sseResponse(l, undefined, 20).body!.getReader()
    const dec = new TextDecoder()
    expect(dec.decode((await rd.read()).value)).toBe(': hb\n\n')
    l.emit('new')
    let t = dec.decode((await rd.read()).value)
    while (t === ': hb\n\n') t = dec.decode((await rd.read()).value)
    expect(t).toContain('"resource":"new"')
    expect(t).not.toContain('old')
    l.close()
  })
})
