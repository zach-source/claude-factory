import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePlanPick, pickPlanModel, savedPlanPick } from './plan-model'
import { managerEgress } from './ax'
import { pickAgent } from './cli'

const OPUS = 'claude-opus-5-5[1m]'
const SONNET = 'claude-sonnet-5-5[1m]'
const answer = (choice: string, confidence: number) =>
  (async () => Response.json({ answers: { complexity: { choice, confidence } } })) as unknown as typeof fetch

test('simple with high confidence picks Sonnet, and the call is the documented one', async () => {
  let seen: any
  const f = (async (url: string, init: any) => {
    seen = { url, init }
    return Response.json({ answers: { complexity: { choice: 'simple', confidence: 0.9 } } })
  }) as unknown as typeof fetch
  expect(await pickPlanModel('t', 'k', f)).toEqual({ model: SONNET, choice: 'simple', confidence: 0.9 })
  expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen.init.headers.Authorization).toBe('Bearer k')
  expect(JSON.parse(seen.init.body)).toMatchObject({ model: 'jev-latest', state: 't' })
})

test('complex picks Opus', async () => {
  expect((await pickPlanModel('t', 'k', answer('complex', 0.95))).model).toBe(OPUS)
})

test('low confidence, no key, http error, bad body and a throw all pick Opus', async () => {
  expect((await pickPlanModel('t', 'k', answer('simple', 0.59))).model).toBe(OPUS)
  expect(await pickPlanModel('t', undefined, answer('simple', 1))).toEqual({ model: OPUS, why: 'no key' })
  const bad = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch
  expect((await pickPlanModel('t', 'k', bad)).model).toBe(OPUS)
  const empty = (async () => Response.json({})) as unknown as typeof fetch
  expect((await pickPlanModel('t', 'k', empty)).model).toBe(OPUS)
  const boom = (async () => {
    throw new Error('x')
  }) as unknown as typeof fetch
  expect((await pickPlanModel('t', 'k', boom)).why).toBe('error')
})

test('ensurePlanPick calls once and keeps the pick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-'))
  process.env.TYPESAFE_API_KEY = 'k'
  let calls = 0
  const f = (async () => (
    calls++,
    Response.json({ answers: { complexity: { choice: 'simple', confidence: 1 } } })
  )) as unknown as typeof fetch
  await ensurePlanPick(dir, 's', f)
  await ensurePlanPick(dir, 's', f)
  delete process.env.TYPESAFE_API_KEY
  expect(calls).toBe(1)
  expect(savedPlanPick(dir)?.model).toBe(SONNET)
})

test('managerEgress adds the Typesafe rule only with the key', () => {
  const rule = { hosts: ['api.typesafe.ai'], key: 'TYPESAFE', header: 'Authorization', prefix: 'Bearer ' }
  expect(managerEgress({ TYPESAFE_API_KEY: 'k' })).toContainEqual(rule)
  expect(managerEgress({})).not.toContainEqual(rule)
})

test('pickAgent uses the saved pick at plan, but a rig value wins', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  mkdirSync(join(home, 'runs', 'r1'), { recursive: true })
  writeFileSync(join(home, 'runs', 'r1', 'plan-pick.json'), JSON.stringify({ model: SONNET }))
  const def = {
    name: 'f',
    start: 'plan',
    agent: 'c --model x',
    params: { plan_model: OPUS },
    nodes: { plan: { prompt: '', agent: "c --model '{plan_model}'", next: { ok: 'done' } } },
  } as unknown as Parameters<typeof pickAgent>[1]
  const pick = (rig?: object) =>
    pickAgent(
      'r1',
      def,
      'plan',
      rig as never,
      'herdr',
      {},
      '/none',
      () => true,
      () => true,
      () => false,
      1,
      home,
    )
  expect(pick()).toBe(`c --model '${SONNET}'`)
  expect(pick({ params: { plan_model: 'mine' } })).toBe("c --model 'mine'")
})
