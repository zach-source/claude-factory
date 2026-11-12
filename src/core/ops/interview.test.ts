import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ctx, Port } from '../catalog'
import { answer, list } from './interview'

const rigs = [
  {
    rig: 'acme',
    factory: 'lifecycle',
    beads: [{ id: 'b1', title: 'Ship the thing?', description: 'Own it.', kind: 'owned' }],
  },
]

function ctx(env: Record<string, string> = {}) {
  const calls: unknown[][] = []
  const c = {
    home: mkdtempSync(join(tmpdir(), 'interview-')),
    env,
    board: () => ({ runs: [] }),
    cli: async (argv: string[]) => (calls.push(['cli', ...argv]), { code: 0, out: '', err: '' }),
    port: {
      decisionsList: () => ({ rigs, proposals: {} }),
      decisionsAnswer: (...a: unknown[]) => calls.push(['answer', ...a.slice(0, 3)]),
    } as unknown as Port,
  } satisfies Ctx
  return { c, calls }
}

const keys = async (c: Ctx) => JSON.parse((await list(c, {})).out).map((x: { key: string }) => x.key)

test('list shows an owner-only bead', async () => {
  expect(await keys(ctx().c)).toEqual(['own:acme:b1'])
})

test('start now answers the bead, starts it with --owned and closes the item', async () => {
  const { c, calls } = ctx()
  const r = await answer(c, { item: 'own:acme:b1', choice: 'start now' })
  expect(r.code).toBe(0)
  expect(calls.map(x => x[0])).toEqual(['answer', 'cli'])
  expect(calls[1]).toEqual(['cli', 'start', 'lifecycle', 'acme', 'b1', '--owned'])
  expect(await keys(c)).toEqual([])
})

test('not now only answers the bead', async () => {
  const { c, calls } = ctx()
  await answer(c, { item: 'own:acme:b1', choice: 'not now' })
  expect(calls.map(x => x[0])).toEqual(['answer'])
})

test('a patrol cannot answer, and an unknown item fails', async () => {
  expect((await answer(ctx({ FACTORY_PATROL: '1' }).c, { item: 'own:acme:b1', choice: 'x' })).code).toBe(1)
  expect((await answer(ctx().c, { item: 'nope', choice: 'x' })).err).toContain('no open question')
})

test('a failed start leaves the bead answered but its item open to try again', async () => {
  const { c } = ctx()
  c.cli = async () => ({ code: 1, out: '', err: 'no room on the rig\n' })
  const r = await answer(c, { item: 'own:acme:b1', choice: 'start now' })
  expect(r.code).toBe(1)
  expect(r.err).toContain('no room on the rig')
  expect(await keys(c)).toEqual(['own:acme:b1'])
})
