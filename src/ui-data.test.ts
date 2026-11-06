import { describe, expect, test } from 'bun:test'
import {
  bucket,
  count,
  epicRows,
  etagMatches,
  etagOf,
  hashOf,
  isStale,
  needBeads,
  sortNeeds,
  type NeedItem,
  oneOffs,
  overall,
  pullArgv,
  singleFlight,
  unchanged,
  type Issue,
} from './ui-data'

const i = (id: string, o: Partial<Issue> = {}): Issue => ({
  id,
  title: id,
  status: 'open',
  issue_type: 'task',
  ...o,
})
// e1 (open) holds t1 closed, t2 open, and sub-epic e2 that holds t3 in_progress and t4 blocked.
// e3 (closed) holds t5 closed. t6 is a one-off. t7 has a parent that does not exist, so it is a one-off.
const data: Issue[] = [
  i('e1', { issue_type: 'epic', priority: 1 }),
  i('t1', { parent: 'e1', status: 'closed' }),
  i('t2', { parent: 'e1' }),
  i('e2', { issue_type: 'epic', parent: 'e1', priority: 2 }),
  i('t3', { parent: 'e2', status: 'in_progress' }),
  i('t4', { parent: 'e2', status: 'blocked' }),
  i('e3', { issue_type: 'epic', status: 'closed' }),
  i('t5', { parent: 'e3', status: 'closed' }),
  i('t6', { priority: 0 }),
  i('t7', { parent: 'gone', priority: 3 }),
]

describe('bucket and count', () => {
  test.each([
    ['closed', 'closed'],
    ['in_progress', 'in_progress'],
    ['hooked', 'open'],
    [undefined, 'open'],
  ])('%s -> %s', (s, want) => expect(bucket(s)).toBe(want as never))
  test('count adds a total', () =>
    expect(count(data)).toEqual({ closed: 3, in_progress: 1, blocked: 1, deferred: 0, open: 5, total: 10 }))
})

describe('epicRows', () => {
  test('open epics only, sub-epic indented, leaves at all depths', () => {
    const rows = epicRows(data)
    expect(rows.map(r => [r.id, r.depth])).toEqual([
      ['e1', 0],
      ['e2', 1],
    ])
    expect(rows[0]?.counts).toEqual({ closed: 1, in_progress: 1, blocked: 1, deferred: 0, open: 1, total: 4 })
    expect(rows[0]?.beads.sort()).toEqual(['t1', 't2', 't3', 't4'])
    expect(rows[1]?.counts.total).toBe(2)
  })
  test('showClosed adds the closed epic after the open ones', () =>
    expect(epicRows(data, true).map(r => r.id)).toEqual(['e1', 'e2', 'e3']))
  test('an epic with no children has zero counts', () =>
    expect(epicRows([i('e', { issue_type: 'epic' })])[0]?.counts.total).toBe(0))
})

describe('overall', () => {
  test('counts each bead once under the shown top epics', () => expect(overall(data).total).toBe(4))
  test('with closed epics it adds their beads', () => expect(overall(data, true).total).toBe(5))
})

describe('oneOffs', () => {
  test('open non-epic beads with no parent bead, by priority', () =>
    expect(oneOffs(data).map(x => x.id)).toEqual(['t6', 't7']))
})

describe('pullArgv', () => {
  const conn = { host: '127.0.0.1', port: 3308, database: 'db', user: 'root', tls: false }
  test('pulls as the remote user and never pushes', () => {
    const a = pullArgv({ name: 'origin', user: 'beads' }, conn) ?? []
    expect(a.at(-1)).toBe("CALL DOLT_PULL('--user', 'beads', 'origin', 'main')")
    expect(a.join(' ')).not.toMatch(/PUSH/i)
    expect(a).toContain('--no-tls')
  })
  test('omits --no-tls with tls', () =>
    expect(pullArgv({ name: 'o', user: 'u' }, { ...conn, tls: true })).not.toContain('--no-tls'))
  test('refuses a name that could break the SQL text', () =>
    expect(pullArgv({ name: "o'; DROP", user: 'u' }, conn)).toBeNull())
})

describe('unchanged (skip the re-read)', () => {
  test.each([
    ['abc', 'abc', true],
    ['abc', 'abd', false],
    [undefined, 'abc', false],
    [null, 'abc', false],
    ['abc', null, false],
    ['', '', false],
  ])('%s vs %s -> %s', (a, b, want) => expect(unchanged(a, b)).toBe(want))
})

describe('hashOf', () => {
  test('finds the hash in a table or JSON', () => {
    expect(hashOf('[{"h":"1j833hnkll8ptg69v0m7g64kl0r5nggp"}]')).toBe('1j833hnkll8ptg69v0m7g64kl0r5nggp')
    expect(hashOf('| 1j833hnkll8ptg69v0m7g64kl0r5nggp |')).toBe('1j833hnkll8ptg69v0m7g64kl0r5nggp')
  })
  test.each(['', 'error: no such branch', '[{"h":null}]'])('no hash in %j', out =>
    expect(hashOf(out)).toBeNull(),
  )
})

describe('singleFlight', () => {
  test('a call during a run joins it: one run, one result for both', async () => {
    const flights = new Map<string, Promise<number>>()
    let runs = 0
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    const fn = async () => (runs++, await gate, runs)
    const a = singleFlight(flights, 'rig', fn)
    const b = singleFlight(flights, 'rig', fn)
    release()
    expect(await Promise.all([a, b])).toEqual([1, 1])
    expect(runs).toBe(1)
  })
  test('another key runs on its own', async () => {
    const flights = new Map<string, Promise<string>>()
    expect(await Promise.all(['a', 'b'].map(k => singleFlight(flights, k, async () => k)))).toEqual([
      'a',
      'b',
    ])
  })
  test('after a run ends, the next call starts a new run, also after a failure', async () => {
    const flights = new Map<string, Promise<number>>()
    let runs = 0
    await expect(
      singleFlight(flights, 'k', async () => (runs++, Promise.reject(new Error('x')))),
    ).rejects.toThrow()
    expect(flights.size).toBe(0)
    await singleFlight(flights, 'k', async () => ++runs)
    expect(runs).toBe(2)
  })
})

describe('isStale', () => {
  const every = 600_000
  test.each([
    [undefined, true],
    [1_000_000 - every, false],
    [1_000_000 - 2 * every, false],
    [1_000_000 - 2 * every - 1, true],
  ])('as-of %s -> %s', (at, want) => expect(isStale(at, 1_000_000, every)).toBe(want))
})

describe('etag', () => {
  test('same body, same tag; other body, other tag', () => {
    expect(etagOf('{"a":1}')).toBe(etagOf('{"a":1}'))
    expect(etagOf('{"a":1}')).not.toBe(etagOf('{"a":2}'))
  })
  test.each([
    ['"x"', true],
    ['W/"x"', true],
    ['"y", "x"', true],
    ['*', true],
    ['"y"', false],
    [null, false],
  ])('If-None-Match %s -> %s', (h, want) => expect(etagMatches(h, '"x"')).toBe(want))
})

describe('needBeads', () => {
  const dep = (on: string, type = 'blocks') => ({ depends_on_id: on, type })
  const rows: Issue[] = [
    i('o1', { labels: ['owner'], created_at: '2026-01-02T00:00:00Z', priority: 1 }),
    i('h1', { labels: ['factory', 'human'], created_at: '2026-01-01T00:00:00Z' }),
    i('both', { labels: ['owner', 'human'] }),
    i('closedowner', { labels: ['owner'], status: 'closed' }),
    i('deferredhuman', { labels: ['human'], status: 'deferred' }),
    i('plain', { labels: ['factory'] }),
    // x1 and x2 wait on o1 (blocks); x3 waits on o1 with parent-child (not a block); x4 is closed
    i('x1', { dependencies: [dep('o1')] }),
    i('x2', { dependencies: [dep('o1'), dep('h1')] }),
    i('x3', { dependencies: [dep('o1', 'parent-child')] }),
    i('x4', { status: 'closed', dependencies: [dep('o1')] }),
  ]
  const got = needBeads(rows, 'r')
  test('open beads with the label owner or human only; owner wins when both', () =>
    expect(got.map(n => [n.id, n.kind])).toEqual([
      ['o1', 'owner'],
      ['h1', 'human'],
      ['both', 'owner'],
    ]))
  test('counts the open beads that block-depend on each', () =>
    expect(got.map(n => [n.id, n.blocks])).toEqual([
      ['o1', 2],
      ['h1', 1],
      ['both', 0],
    ]))
  test('age is created_at; none gives undefined', () => {
    expect(got[0]?.since).toBe(Date.parse('2026-01-02T00:00:00Z'))
    expect(got[2]?.since).toBeUndefined()
  })
  test('no label, no item', () => expect(needBeads([i('a')], 'r')).toEqual([]))
})

describe('sortNeeds', () => {
  const n = (id: string, since?: number, rig = 'r'): NeedItem => ({
    kind: 'owner',
    rig,
    id,
    title: id,
    since,
    prs: [],
  })
  test.each([
    [
      [n('b', 5), n('a', 9), n('c', 1)],
      ['c', 'b', 'a'],
    ],
    [
      [n('b'), n('a', 3)],
      ['a', 'b'],
    ],
    [
      [n('b', 1), n('a', 1)],
      ['a', 'b'],
    ],
    [
      [n('a', 1, 'z'), n('b', 1, 'm')],
      ['b', 'a'],
    ],
  ])('%#', (items, want) => expect(sortNeeds(items).map(x => x.id)).toEqual(want))
  test('does not change its input', () => {
    const items = [n('b', 2), n('a', 1)]
    sortNeeds(items)
    expect(items[0]?.id).toBe('b')
  })
})
