import { expect, test } from 'bun:test'
import { clusterKey, filingActor, filingGuard, type FilingBead } from './filing-guard'

const now = Date.UTC(2026, 0, 2)
const bead = (id: string, o: Partial<FilingBead> = {}): FilingBead => ({
  id,
  title: 'widget: x',
  created_by: `factory/acme-${id}/plan`,
  created_at: new Date(now - 60_000 * (100 - Number(id.replace(/\D/g, '') || 0))).toISOString(),
  ...o,
})
const many = (n: number, f: (i: number) => Partial<FilingBead> & { id: string }) =>
  Array.from({ length: n }, (_, i) => bead(f(i).id, f(i)))
const kept = (v: { kept: boolean }[]) => v.map(x => x.kept)

test('filingActor reads run and station from a factory created_by only', () => {
  expect(filingActor('factory/acme-r1/review')).toEqual({ run: 'acme-r1', station: 'review' })
  expect(filingActor('factory')).toEqual({})
  for (const c of ['factory-bot', 'factoryx', 'a person', '', undefined])
    expect(filingActor(c)).toBeUndefined()
})

test('clusterKey takes the title before the first : or (, else the first two words', () => {
  expect(clusterKey({ id: 'a', title: 'Worker-hook: x' })).toBe('worker-hook')
  expect(clusterKey({ id: 'a', title: 'widget (y)' })).toBe('widget')
  expect(clusterKey({ id: 'a', title: 'a (b: c)' })).toBe('a')
  expect(clusterKey({ id: 'a', title: 'Fix the flaky test' })).toBe('fix-the')
  expect(clusterKey({ id: 'a', title: ': foo bar' })).toBe('foo-bar')
  expect(clusterKey({ id: 'a', title: '' })).toBe('untitled')
  expect(clusterKey({ id: 'a' })).toBe('untitled')
})

test('clusterKey prefers the parent, from the field or the id', () => {
  expect(clusterKey({ id: 'x', parent: 'acme-9', title: 'Other: y' })).toBe('acme-9')
  expect(clusterKey({ id: 'acme-9.3', title: 'Other: y' })).toBe('acme-9')
})

test('the 7th bead in a cluster within 24h is held', () => {
  const v = filingGuard(
    many(7, i => ({ id: `b${i}` })),
    now,
  )
  expect(kept(v)).toEqual([true, true, true, true, true, true, false])
  expect(v[6]?.held).toBe('cluster')
})

test('the 4th bead from one run/station is held', () => {
  const v = filingGuard(
    many(4, i => ({ id: `b${i}`, title: `t${i}: x`, created_by: 'factory/acme-r1/plan' })),
    now,
  )
  expect(kept(v)).toEqual([true, true, true, false])
  expect(v[3]?.held).toBe('station')
  expect(v[3]?.station).toBe('acme-r1/plan')
})

test('a person-filed bead is absent and uses no slot', () => {
  const six = many(6, i => ({ id: `b${i}` }))
  const person = bead('b9', { created_by: 'Zach' })
  const noBy = bead('b8', { created_by: undefined })
  const v = filingGuard([...six, person, noBy], now)
  expect(kept(v)).toEqual([true, true, true, true, true, true])
  expect(v.find(x => x.id === 'b9' || x.id === 'b8')).toBeUndefined()
})

test('a bead more than the window before the next one uses no slot and gets a verdict', () => {
  const old = bead('b0', { created_at: new Date(now - 27 * 3_600_000).toISOString() })
  const v = filingGuard([old, ...many(6, i => ({ id: `b${i + 1}` }))], now)
  expect(v.find(x => x.id === 'b0')?.kept).toBe(true)
  expect(kept(v)).toEqual([true, true, true, true, true, true, true])
})

test('the window starts at each bead own filing time: a past-cap bead stays held as time goes on', () => {
  const old = bead('b0', { created_at: new Date(now - 25 * 3_600_000).toISOString() })
  const v = filingGuard([old, ...many(6, i => ({ id: `b${i + 1}` }))], now)
  expect(kept(v)).toEqual([true, true, true, true, true, true, false])
  expect(v[6]?.held).toBe('cluster')
})

test('the station cap also keeps a bead held when the first bead of the run is older than 24h', () => {
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString()
  const v = filingGuard(
    [25, 24.5, 24.2, 23.5].map((h, i) =>
      bead(`b${i}`, { title: `t${i}: x`, created_by: 'factory/acme-r1/plan', created_at: at(h) }),
    ),
    now,
  )
  expect(kept(v)).toEqual([true, true, true, false])
  expect(v[3]?.held).toBe('station')
})

test('a bead exactly 24h before the next one uses no slot', () => {
  const day = 24 * 3_600_000
  const t0 = now - 2 * day
  const at = (ms: number) => new Date(ms).toISOString()
  const first = bead('b0', { created_at: at(t0) })
  const rest = many(6, i => ({ id: `b${i + 1}`, created_at: at(t0 + day + i * 1000) }))
  expect(kept(filingGuard([first, ...rest], now))).toEqual([true, true, true, true, true, true, true])
})

test('a held bead uses no slot: a bead filed after the oldest kept one left its window is kept', () => {
  const at = (hrs: number) => new Date(now - hrs * 3_600_000).toISOString()
  const six = many(6, i => ({ id: `b${i}`, created_at: at(40 - i) }))
  const held = bead('b6', { created_at: at(30) })
  const late = bead('b7', { created_at: at(15.5) })
  const v = filingGuard([...six, held, late], now)
  expect(kept(v)).toEqual([true, true, true, true, true, true, false, true])
})

test('a bead with no created_at counts as now: scored, and it can be the 7th', () => {
  const beads = [...many(6, i => ({ id: `b${i}` })), bead('z', { created_at: undefined })]
  const v = filingGuard(beads, now)
  expect(v.at(-1)?.id).toBe('z')
  expect(v.at(-1)?.kept).toBe(false)
})

test('a bead with an unparseable created_at counts as now and can be the 7th', () => {
  const beads = [...many(6, i => ({ id: `b${i}` })), bead('z', { created_at: 'garbage' })]
  const v = filingGuard(beads, now)
  expect(v.at(-1)?.id).toBe('z')
  expect(v.at(-1)?.kept).toBe(false)
})

test('a closed bead gets a verdict and uses a slot', () => {
  const v = filingGuard([bead('b0', { status: 'closed' }), ...many(6, i => ({ id: `b${i + 1}` }))], now)
  expect(v.find(x => x.id === 'b0')?.kept).toBe(true)
  expect(kept(v)).toEqual([true, true, true, true, true, true, false])
})

test('the verdicts do not depend on input order, and equal times sort by id', () => {
  const same = new Date(now - 1000).toISOString()
  const beads = many(8, i => ({ id: `b${i}`, created_at: same }))
  const a = filingGuard(beads, now)
  expect(filingGuard([...beads].reverse(), now)).toEqual(a)
  expect(a.map(x => x.id)).toEqual(beads.map(x => x.id))
  expect(filingGuard(beads, now)).toEqual(a)
})

test('a station-held bead uses no cluster slot', () => {
  const x = many(5, i => ({ id: `a${i}`, created_by: 'factory/acme-r1/plan' }))
  const late = new Date(now - 1000).toISOString()
  const others = many(3, i => ({ id: `c${i}`, created_at: late, created_by: `factory/acme-o${i}/plan` }))
  const v = filingGuard([...x, ...others], now)
  expect(kept(v.filter(r => r.station === 'acme-r1/plan'))).toEqual([true, true, true, false, false])
  expect(kept(v.filter(r => r.station !== 'acme-r1/plan'))).toEqual([true, true, true])
})

test('opts set the caps', () => {
  const three = many(3, i => ({ id: `b${i}` }))
  expect(kept(filingGuard(three, now, { clusterCap: 2 }))).toEqual([true, true, false])
  const same = many(2, i => ({ id: `b${i}`, title: `t${i}: x`, created_by: 'factory/acme-r1/plan' }))
  expect(kept(filingGuard(same, now, { stationCap: 1 }))).toEqual([true, false])
})
