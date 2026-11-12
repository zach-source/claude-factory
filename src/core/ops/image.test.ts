import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { checkParity, FRONT_ENDS, GAPS_FILE, parseGaps } from '../../parity'
import { CATALOG, type Ctx, type Port } from '../catalog'
import { argsInput, run } from './image'

const USAGE = 'factory: usage: factory image build [--target worker|manager]\n'

const setup = (o: { held?: boolean; throws?: boolean; env?: Record<string, string | undefined> } = {}) => {
  const calls: unknown[][] = []
  const port = {
    gcHold: (name: string) => {
      calls.push(['hold', name])
      return o.held ? null : () => void calls.push(['release'])
    },
    imageBuild: async (target: string, error: (l: string) => void) => {
      calls.push(['build', target])
      if (o.throws) throw new Error('docker buildx build failed (exit 1)')
      error('warn')
      return 'ref'
    },
  } as unknown as Port
  const ctx = { env: o.env ?? {}, port } as unknown as Ctx
  return { calls, ctx }
}

test('kq1a AC2 a valid input builds the target; worker when target is missing', async () => {
  for (const [input, target] of [
    [{}, 'worker'],
    [{ target: 'worker' }, 'worker'],
    [{ target: 'manager' }, 'manager'],
  ] as const) {
    const t = setup()
    expect(await run(t.ctx, input)).toEqual({ code: 0, out: 'ref\n', err: 'warn\n' })
    expect(t.calls).toEqual([['hold', 'image.lock'], ['build', target], ['release']])
  }
})

test('kq1a AC2 any other input resolves to the usage line with zero port calls', async () => {
  const bad = [
    { target: 'x' },
    { target: '' },
    { target: true },
    { target: 'Worker' },
    { other: 'a' },
    { target: 'worker', extra: true },
    null,
    [],
  ]
  for (const input of bad) {
    const t = setup()
    expect(await run(t.ctx, input as never)).toEqual({ code: 1, out: '', err: USAGE })
    expect(t.calls).toEqual([])
  }
})

test('kq1a AC3 a worker or a patrol is refused before any port call', async () => {
  for (const env of [
    { FACTORY_FROM: 'implement' },
    { FACTORY_FROM: 'manager' },
    { FACTORY_RUN: 'r1' },
    { FACTORY_DEF_NAME: 'x' },
    { BEADS_ACTOR: 'factory/r1/plan' },
  ]) {
    const t = setup({ env })
    const r = await run(t.ctx, {})
    expect(r.code).toBe(1)
    expect(r.err).toContain('a worker cannot run factory image build')
    expect(t.calls).toEqual([])
  }
  const t = setup({ env: { FACTORY_PATROL: '1' } })
  const r = await run(t.ctx, {})
  expect(r.code).toBe(1)
  expect(r.err).toContain('a patrol cannot run factory image build')
  expect(t.calls).toEqual([])
})

test('kq1a AC4 a failed build gives code 1 and releases the lock; a held lock gives no build', async () => {
  const t = setup({ throws: true })
  expect(await run(t.ctx, {})).toEqual({
    code: 1,
    out: '',
    err: 'factory: docker buildx build failed (exit 1)\n',
  })
  expect(t.calls).toEqual([['hold', 'image.lock'], ['build', 'worker'], ['release']])
  const h = setup({ held: true })
  expect(await run(h.ctx, {})).toEqual({
    code: 1,
    out: '',
    err: 'factory: an image build is already running: try again when it ends\n',
  })
  expect(h.calls).toEqual([['hold', 'image.lock']])
})

test('kq1a AC6 argsInput accepts build and build --target; every other argv throws the usage', () => {
  expect(argsInput(['build'])).toEqual({})
  expect(argsInput(['build', '--target', 'manager'])).toEqual({ target: 'manager' })
  for (const args of [
    [],
    ['push'],
    ['build', '--target'],
    ['build', '--target', 'x'],
    ['build', '--target', 'worker', 'extra'],
    ['build', '--other'],
    ['build', 'build'],
    ['build', 'worker', 'manager'],
  ])
    expect(() => argsInput(args)).toThrow('usage: factory image build')
})

test('kq1a AC8 image.build is in the catalog and parity-gaps.json has no image entry', async () => {
  const gaps = parseGaps(readFileSync(GAPS_FILE, 'utf8'))
  expect(gaps.filter(g => g.op.startsWith('image.'))).toEqual([])
  expect(CATALOG.some(o => o.name === 'image.build')).toBe(true)
  expect(await checkParity(CATALOG, FRONT_ENDS, gaps)).toEqual([])
})
