// claude-factory-hpmc.7: the front-end parity check (spec 008, FR-018, FR-019).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CATALOG } from './core/catalog'
import { checkParity, FRONT_ENDS, GAPS_FILE, parseGaps, type FrontEnd, type Gap } from './parity'

const echo = async (_op: string, i: Record<string, string | boolean>) => ({
  code: 0,
  out: `${i.text}\n`,
  err: '',
})
const fe = (name: FrontEnd['name'], o: Partial<FrontEnd> = {}): FrontEnd => ({
  name,
  generic: echo,
  ownViews: [],
  hidden: [],
  ...o,
})
const gap = (frontEnd: Gap['frontEnd'], op = 'catalog.echo'): Gap => ({
  op,
  frontEnd,
  bead: 'x-1',
  reason: 'r',
})

test('AC1: the real data has no problem, and the gaps print', async () => {
  const gaps = parseGaps(readFileSync(GAPS_FILE, 'utf8'))
  for (const g of gaps) console.log(`gap: ${g.frontEnd} ${g.op} ${g.bead}: ${g.reason}`)
  expect(await checkParity(CATALOG, FRONT_ENDS, gaps)).toEqual([])
})

test('AC2: the gap file holds the four seed gaps', () => {
  const row = (frontEnd: Gap['frontEnd'], bead: string) => ({
    op: 'catalog.echo',
    frontEnd,
    bead,
    reason: 'no generic view yet',
  })
  expect(parseGaps(readFileSync(GAPS_FILE, 'utf8'))).toEqual([
    row('cli', 'claude-factory-hpmc.8'),
    row('claude-mod', 'claude-factory-hpmc.9'),
    row('herdr-mod', 'claude-factory-hpmc.10'),
    row('web', 'claude-factory-hpmc.11'),
  ])
})

test('AC3: a generic view that cannot run catalog.echo is a problem unless a gap covers it', async () => {
  const p = (why: string) => [`cli: the generic view cannot run catalog.echo: ${why}`]
  expect(await checkParity(CATALOG, [fe('cli')], [])).toEqual([])
  expect(await checkParity(CATALOG, [fe('cli', { generic: undefined })], [])).toEqual(p('no generic view'))
  const boom = async () => {
    throw new Error('boom')
  }
  expect(await checkParity(CATALOG, [fe('cli', { generic: boom })], [])).toEqual(p('boom'))
  const bad = async () => ({ code: 3, out: 'x'.repeat(100), err: '' })
  expect(await checkParity(CATALOG, [fe('cli', { generic: bad })], [])).toEqual(
    p(`code 3, out ${'x'.repeat(80)}`),
  )
  const wrong = async () => ({ code: 0, out: 'nope\n', err: '' })
  expect(await checkParity(CATALOG, [fe('cli', { generic: wrong })], [])).toEqual(p('code 0, out nope\n'))
  const none = fe('cli', { generic: undefined })
  expect(await checkParity(CATALOG, [none], [gap('cli')])).toEqual([])
  expect(await checkParity(CATALOG, [none], [gap('cli', 'runs.show')])).toEqual(p('no generic view'))
  expect(await checkParity(CATALOG, [none], [gap('web')])).toEqual(p('no generic view'))
  let calls = 0
  const count = async () => {
    calls++
    return { code: 1, out: '', err: '' }
  }
  expect(await checkParity(CATALOG, [fe('cli', { generic: count })], [gap('cli')])).toEqual([])
  expect(calls).toBe(0)
})

test('AC4: an own view must be in the catalog', async () => {
  expect(await checkParity(CATALOG, [fe('web', { ownViews: ['board.show'] })], [])).toEqual([])
  expect(await checkParity(CATALOG, [fe('web', { ownViews: ['nope.x'] })], [])).toEqual([
    'web: own view nope.x is not in the catalog',
  ])
})

test('AC5: a hidden entry names a catalog op and another front end that shows it', async () => {
  const h = (op: string, shownIn: string) => ({ op, shownIn })
  const herdr = (hidden: FrontEnd['hidden']) => fe('herdr-mod', { hidden })
  const ok = [herdr([h('board.show', 'web')]), fe('web')]
  expect(await checkParity(CATALOG, ok, [])).toEqual([])
  const msg = (op: string) => [`herdr-mod: hidden ${op} must name a front end that shows it`]
  expect(await checkParity(CATALOG, [herdr([h('nope.x', 'nope.x')])], [])).toEqual([
    'herdr-mod: hidden nope.x is not in the catalog',
  ])
  expect(await checkParity(CATALOG, [herdr([h('board.show', 'ghost')]), fe('web')], [])).toEqual(
    msg('board.show'),
  )
  expect(await checkParity(CATALOG, [herdr([h('board.show', 'herdr-mod')])], [])).toEqual(msg('board.show'))
  const both = [herdr([h('board.show', 'web')]), fe('web', { hidden: [h('board.show', 'herdr-mod')] })]
  expect(await checkParity(CATALOG, both, [])).toEqual([
    ...msg('board.show'),
    'web: hidden board.show must name a front end that shows it',
  ])
})

test('problem order: front ends in list order, generic view, own views, hidden', async () => {
  const a = fe('cli', { generic: undefined, ownViews: ['n.x'], hidden: [{ op: 'n.y', shownIn: 'web' }] })
  const b = fe('web', { generic: undefined })
  expect(await checkParity(CATALOG, [a, b], [])).toEqual([
    'cli: the generic view cannot run catalog.echo: no generic view',
    'cli: own view n.x is not in the catalog',
    'cli: hidden n.y is not in the catalog',
    'web: the generic view cannot run catalog.echo: no generic view',
  ])
})

test('AC6: parseGaps refuses each bad form with its message', () => {
  const ok = { op: 'catalog.echo', frontEnd: 'cli', bead: 'x-1', reason: 'r' }
  const j = (...items: unknown[]) => JSON.stringify(items)
  const rows: [string, string][] = [
    ['not json', 'parity-gaps.json: not JSON'],
    ['{}', 'parity-gaps.json: not an array'],
    ['null', 'parity-gaps.json: not an array'],
    [j(ok, null), 'parity-gaps.json: item 1: not an object'],
    [j([]), 'parity-gaps.json: item 0: not an object'],
    [j(7), 'parity-gaps.json: item 0: not an object'],
    [j({ ...ok, extra: 'x' }), 'parity-gaps.json: item 0: keys must be op, frontEnd, bead, reason'],
    [
      j({ op: ok.op, frontEnd: 'cli', reason: 'r' }),
      'parity-gaps.json: item 0: keys must be op, frontEnd, bead, reason',
    ],
    [j({ ...ok, bead: 1 }), 'parity-gaps.json: item 0: bead must be a string'],
    [j({ ...ok, bead: '' }), 'parity-gaps.json: item 0: bead must be a bead id'],
    [j({ ...ok, bead: '-x' }), 'parity-gaps.json: item 0: bead must be a bead id'],
    [j({ ...ok, reason: '  ' }), 'parity-gaps.json: item 0: reason is empty'],
    [j({ ...ok, op: 'nope.x' }), 'parity-gaps.json: item 0: op nope.x is not in the catalog'],
    [j({ ...ok, frontEnd: 'tv' }), 'parity-gaps.json: item 0: frontEnd tv is not a front end'],
    [j(ok, { ...ok, bead: 'y-2' }), 'parity-gaps.json: item 1: duplicate of item 0'],
  ]
  for (const [text, msg] of rows) expect(() => parseGaps(text)).toThrow(msg)
  expect(parseGaps('[]')).toEqual([])
})
