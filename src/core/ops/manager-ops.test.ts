import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CATALOG, OpError, allowed, type Ctx, type Input, type Port } from '../catalog'
import { readLog } from '../../once'

const say: string[] = []
const mk = (board: unknown = { manager: [{ from: 'a', text: 'hi' }] }): Ctx =>
  ({
    home: mkdtempSync(join(tmpdir(), 'mops-')),
    env: {},
    board: () => board,
    cli: async () => ({ code: 0, out: '', err: '' }),
    port: {
      decisionsList: () => [{ bead: 'b-1' }],
      planShowText: () => 'the plan',
      say: (t: string) => void say.push(t),
    } as unknown as Port,
  }) as Ctx
const op = (n: string) => CATALOG.find(o => o.name === n)!
const run = (n: string, c: Ctx, i: Input = {}) => op(n).run(c, i)

test('manager.log adds a row to each kind of log and keeps the cap', async () => {
  const c = mk()
  for (const kind of ['patrol', 'pm', 'brief', 'review', 'usage', 'health'])
    await run('manager.log', c, { kind, entry: JSON.stringify({ kind }) })
  expect(readLog(c.home, 'patrol-log.jsonl')).toEqual([{ kind: 'patrol' }])
  expect(readLog(c.home, 'manager-health.jsonl')).toEqual([{ kind: 'health' }])
  expect(readLog(c.home, 'manager-usage.jsonl')).toEqual([{ kind: 'usage' }])
})

test('manager.log refuses a bad kind and an entry that is not one JSON object', async () => {
  const c = mk()
  for (const entry of ['x', '[]', '1', 'null'])
    expect(await run('manager.log', c, { kind: 'pm', entry }).catch(e => e)).toBeInstanceOf(OpError)
  expect(await run('manager.log', c, { kind: 'nope', entry: '{}' }).catch(e => e)).toBeInstanceOf(OpError)
})

test('manager.show gives the last health row, else null', async () => {
  const c = mk()
  expect(JSON.parse((await run('manager.show', c)).out)).toEqual({ health: null })
  await run('manager.log', c, { kind: 'health', entry: '{"n":1}' })
  await run('manager.log', c, { kind: 'health', entry: '{"n":2}' })
  expect(JSON.parse((await run('manager.show', c)).out)).toEqual({ health: { n: 2 } })
})

test('manager.brief holds decisions, mail, plan and the last 20 patrol rows', async () => {
  const c = mk()
  for (let n = 0; n < 25; n++) await run('manager.log', c, { kind: 'patrol', entry: JSON.stringify({ n }) })
  const b = JSON.parse((await run('manager.brief', c)).out)
  expect(b.decisions).toEqual([{ bead: 'b-1' }])
  expect(b.mail).toEqual([{ from: 'a', text: 'hi' }])
  expect(b.plan).toBe('the plan')
  expect(b.patrol.map((r: { n: number }) => r.n)).toEqual(Array.from({ length: 20 }, (_, k) => k + 5))
  expect(JSON.parse((await run('manager.brief', mk(null))).out).mail).toEqual([])
})

test('manager.say reaches the task and is for the person only', async () => {
  await run('manager.say', mk(), { text: 'go on' })
  expect(say).toEqual(['go on'])
  expect(allowed(op('manager.say').rights, 'manager')).toBe(false)
  expect(allowed(op('manager.log').rights, 'manager')).toBe(true)
})
