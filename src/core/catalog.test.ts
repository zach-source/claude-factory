import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allowed,
  boardView,
  CATALOG,
  CATALOG_VERSION,
  fieldOk,
  makeCatalog,
  readBody,
  readQuery,
  slimBoard,
  snapFresh,
  snapshot,
  type Field,
  type Op,
} from './catalog'

const op = (over: Partial<Op> = {}): Op => ({
  name: 't.a',
  summary: 's',
  inputs: [],
  output: 'text',
  rights: 'read',
  mutates: false,
  long: false,
  route: { method: 'GET', path: '/v1/t' },
  since: 1,
  run: async () => ({ code: 0, out: '', err: '' }),
  ...over,
})
const idIn = (name: string, required = true): Field => ({ name, kind: 'id', required, help: 'h' })

describe('makeCatalog', () => {
  const refused: [string, Op[]][] = [
    ['a duplicate name', [op(), op({ route: { method: 'GET', path: '/v1/u' } })]],
    ['a duplicate route', [op(), op({ name: 't.b' })]],
    [
      'a duplicate route with other param names',
      [
        op({ route: { method: 'GET', path: '/v1/runs/:id' }, inputs: [idIn('id')] }),
        op({ name: 't.b', route: { method: 'GET', path: '/v1/runs/:run' }, inputs: [idIn('run')] }),
      ],
    ],
    [
      'a literal and a param route at one position',
      [
        op({ route: { method: 'GET', path: '/v1/runs/:id' }, inputs: [idIn('id')] }),
        op({ name: 't.b', route: { method: 'GET', path: '/v1/runs/active' } }),
      ],
    ],
    [
      'a param route after a literal route at one position',
      [
        op({ route: { method: 'GET', path: '/v1/runs/active' } }),
        op({ name: 't.b', route: { method: 'GET', path: '/v1/runs/:id' }, inputs: [idIn('id')] }),
      ],
    ],
    ['mutates with read rights', [op({ mutates: true, route: { method: 'POST', path: '/v1/t' } })]],
    ['mutates with GET', [op({ mutates: true, rights: 'owner' })]],
    ['a name with no dot', [op({ name: 'runs' })]],
    ['an upper case name', [op({ name: 'Runs.Show' })]],
    ['a path outside /v1/', [op({ route: { method: 'GET', path: '/x' } })]],
    ['a param with no input', [op({ route: { method: 'GET', path: '/v1/t/:id' } })]],
    [
      'a param input of kind text',
      [
        op({
          route: { method: 'GET', path: '/v1/t/:id' },
          inputs: [{ name: 'id', kind: 'text', required: true, help: 'h' }],
        }),
      ],
    ],
    [
      'an optional param input',
      [op({ route: { method: 'GET', path: '/v1/t/:id' }, inputs: [idIn('id', false)] })],
    ],
    ['two inputs with one name', [op({ inputs: [idIn('a'), idIn('a')] })]],
    ['an enum with no values', [op({ inputs: [{ name: 'm', kind: 'enum', required: true, help: 'h' }] })]],
  ]
  for (const [name, ops] of refused) test(`refuses ${name}`, () => expect(() => makeCatalog(ops)).toThrow())

  test('the error names the operation', () => {
    expect(() => makeCatalog([op({ name: 'Bad' })])).toThrow(/Bad/)
  })

  const allowed: [string, Op[]][] = [
    [
      'the same path with GET and POST',
      [op(), op({ name: 't.b', route: { method: 'POST', path: '/v1/t' } })],
    ],
    ['mutates false with read rights', [op()]],
    [
      'mutates with owner rights',
      [op({ mutates: true, rights: 'owner', route: { method: 'POST', path: '/v1/t' } })],
    ],
    [
      'mutates with manager rights',
      [op({ mutates: true, rights: 'manager', route: { method: 'POST', path: '/v1/t' } })],
    ],
    ['mutates false on a POST', [op({ route: { method: 'POST', path: '/v1/t' } })]],
  ]
  for (const [name, ops] of allowed)
    test(`allows ${name}`, () => expect(makeCatalog(ops).length).toBe(ops.length))

  test('sorts by name', () => {
    const r = makeCatalog([op({ name: 'b.x' }), op({ name: 'a.x', route: { method: 'GET', path: '/v1/u' } })])
    expect(r.map(o => o.name)).toEqual(['a.x', 'b.x'])
  })
})

describe('fieldOk', () => {
  const f = (kind: Field['kind'], values?: string[]): Field => ({
    name: 'n',
    kind,
    required: true,
    help: 'h',
    values,
  })
  const rows: [Field, unknown[], unknown[]][] = [
    [f('id'), ['r1', 'a.b-c_d', 'a'.repeat(128)], ['', '-x', '.x', 'a'.repeat(129), 'a/b', 'a%2Eb', 1]],
    [f('text'), ['x', 'a'.repeat(65536)], ['', 'a'.repeat(65537), 'a\u0000b', true]],
    [f('note'), ['', 'ok'], ['a'.repeat(65537), 'a\u0000b', 1]],
    [f('path'), ['/x', '/' + 'a'.repeat(4095)], ['x', '/' + 'a'.repeat(4096), '/a\u0000']],
    [f('flag'), [true], [false, 'true', '1', 1]],
    [f('enum', ['stop', 'resume']), ['stop', 'resume'], ['pause', '', 1]],
  ]
  for (const [field, ok, bad] of rows) {
    test(`${field.kind} accepts`, () => {
      for (const v of ok) expect(fieldOk(field, v)).toBe(true)
    })
    test(`${field.kind} refuses`, () => {
      for (const v of bad) expect(fieldOk(field, v)).toBe(false)
    })
  }
})

describe('readQuery and readBody', () => {
  const o = makeCatalog([
    op({
      route: { method: 'GET', path: '/v1/t/:id' },
      inputs: [idIn('id'), { name: 'j', kind: 'flag', required: false, help: 'h' }],
    }),
  ])[0]!
  test('reads a path param and a flag', () => {
    expect(readQuery(o, ['r1'], '?j=1')).toEqual({ id: 'r1', j: true })
  })
  test('refuses', () => {
    expect(readQuery(o, ['a%2E'], '')).toBe('bad path segment')
    expect(readQuery(o, ['r1'], '?j=true')).toBe('bad query')
    expect(readQuery(o, ['r1'], '?toString=1')).toBe('bad query')
    expect(readQuery(op(), [], '?&')).toBe('bad query')
  })
  test('readBody refuses a path input name', () => {
    const p = makeCatalog([
      op({
        route: { method: 'POST', path: '/v1/t/:id' },
        inputs: [idIn('id'), idIn('n')],
      }),
    ])[0]!
    expect(readBody(p, { id: 'r1' }, { n: 'x', id: 'r2' })).toBe('bad body')
    expect(readBody(p, { id: 'r1' }, {})).toBe('bad body')
    expect(readBody(p, { id: 'r1' }, { n: 'x' })).toEqual({ id: 'r1', n: 'x' })
  })
})

describe('CATALOG', () => {
  test('n69b2 AC1 gc has one owner POST operation and four optional inputs', () => {
    const gc = CATALOG.find(o => o.name === 'gc.run')
    expect(gc).toMatchObject({
      route: { method: 'POST', path: '/v1/gc' },
      output: 'text',
      rights: 'owner',
      mutates: true,
      long: false,
      since: 1,
    })
    expect(gc!.inputs.map(({ name, kind, required }) => [name, kind, required])).toEqual([
      ['worktrees', 'flag', false],
      ['dryRun', 'flag', false],
      ['days', 'text', false],
      ['rig', 'id', false],
    ])
    expect(CATALOG.filter(o => o.route.path === '/v1/gc')).toHaveLength(1)
  })
  test('has 51 operations: 26 GET, 20 POST, 1 DELETE, 1 PATCH and 3 PUT', () => {
    expect(CATALOG.length).toBe(51)
    expect(CATALOG.filter(o => o.route.method === 'GET').length).toBe(26)
    expect(CATALOG.filter(o => o.route.method === 'POST').length).toBe(20)
    expect(CATALOG.filter(o => o.route.method === 'DELETE').map(o => o.name)).toEqual(['runs.remove'])
    expect(CATALOG.filter(o => o.route.method === 'PATCH').map(o => o.name)).toEqual(['rigs.set'])
    expect(CATALOG.filter(o => o.route.method === 'PUT').map(o => o.name)).toEqual([
      'gates.setbrief',
      'plan.set',
      'review.set',
    ])
    expect(CATALOG.filter(o => o.route.method === 'POST' && !o.mutates).map(o => o.name)).toEqual([
      'guard.check',
    ])
  })
  test('rights map as before', () => {
    for (const o of CATALOG) {
      const get = o.route.method === 'GET' || o.name === 'guard.check'
      expect(o.rights).toBe(
        get
          ? 'read'
          : ['factory.halt', 'gc.run', 'chat.send', 'manager.say'].includes(o.name)
            ? 'owner'
            : 'manager',
      )
      expect(o.mutates).toBe(!get)
      expect(o.long).toBe(o.name === 'chat.send')
      expect(o.since).toBe(1)
    }
    expect(CATALOG_VERSION).toBe(1)
  })
  test('allowed: the manager role cannot call an owner operation', () => {
    expect(allowed('owner', 'manager')).toBe(false)
    expect(allowed('owner', 'person')).toBe(true)
    expect(allowed('manager', 'manager')).toBe(true)
    expect(allowed('read', 'manager')).toBe(true)
  })
  test('the chat operations', () => {
    const send = CATALOG.find(o => o.name === 'chat.send')!
    const show = CATALOG.find(o => o.name === 'chat.show')!
    expect(send).toMatchObject({
      summary: 'Send a message to the manager chat and wait for its answer.',
      rights: 'owner',
      mutates: true,
      long: true,
      output: 'json',
    })
    expect(send.inputs.map(i => [i.name, i.kind, i.required, i.values])).toEqual([
      ['id', 'id', true, undefined],
      ['text', 'text', true, undefined],
      ['front', 'enum', true, ['cli', 'web', 'claude-mod', 'herdr-mod']],
      ['approve', 'id', false, undefined],
      ['command', 'text', false, undefined],
    ])
    expect(readBody(send, { id: 'c' }, { text: 'x', front: 'web', approve: 'toolu_01A' })).toMatchObject({
      approve: 'toolu_01A',
    })
    expect(readBody(send, { id: 'c' }, { text: 'x', front: 'web', approve: '../x' })).toBe('bad body')
    expect(send.inputs.find(i => i.name === 'approve')!.help).toBe(
      'a tool_use id from the asks of the last manager turn: the core runs that command one time before the next turn',
    )
    expect(show).toMatchObject({
      summary: 'Show a manager conversation: its session and its turns.',
      rights: 'read',
      mutates: false,
      long: false,
      output: 'json',
    })
    expect(show.inputs.map(i => i.name)).toEqual(['id'])
    expect(readQuery(show, ['..'], '')).toBe('bad path segment')
    expect(readQuery(show, ['a%2Fb'], '')).toBe('bad path segment')
    expect(readBody(send, { id: 'c' }, { text: 'x', front: 'tui' })).toBe('bad body')
    expect(readBody(send, { id: 'c' }, { text: 'x', front: 'web' })).toEqual({
      id: 'c',
      text: 'x',
      front: 'web',
    })
  })
  test('names and routes', () => {
    expect(CATALOG.map(o => `${o.name} ${o.route.method} ${o.route.path}`)).toEqual([
      'backlog.queue POST /v1/queue',
      'backlog.show GET /v1/backlog',
      'board.show GET /v1/board',
      'catalog.echo GET /v1/catalog/echo',
      'catalog.show GET /v1/catalog',
      'chat.send POST /v1/conversations/:id',
      'chat.show GET /v1/conversations/:id',
      'decisions.answer POST /v1/decisions/:rig/:bead/answer',
      'decisions.list GET /v1/decisions',
      'factory.halt POST /v1/halt',
      'flows.show GET /v1/flows',
      'gates.brief GET /v1/runs/:id/brief',
      'gates.decide POST /v1/runs/:id/decide',
      'gates.setbrief PUT /v1/gate-brief/:run',
      'gc.run POST /v1/gc',
      'guard.check POST /v1/guard/check',
      'lease.show GET /v1/lease',
      'mail.list GET /v1/mail',
      'manager.brief GET /v1/manager/brief',
      'manager.context GET /v1/manager/context',
      'manager.log POST /v1/manager/log/:kind',
      'manager.say POST /v1/manager/say',
      'manager.show GET /v1/manager',
      'memory.add POST /v1/memory',
      'memory.search GET /v1/memory/search',
      'metrics.show GET /v1/metrics',
      'plan.facts GET /v1/plan/facts',
      'plan.set PUT /v1/plan',
      'plan.show GET /v1/plan',
      'prs.show GET /v1/prs',
      'review.facts GET /v1/review',
      'review.set PUT /v1/review',
      'rigs.adopt POST /v1/adopt',
      'rigs.list GET /v1/rigs',
      'rigs.set PATCH /v1/rigs/:rig',
      'rigs.unhold POST /v1/rigs/:rig/unhold',
      'runners.show GET /v1/runners',
      'runs.abort POST /v1/runs/:id/abort',
      'runs.fork POST /v1/runs/:id/fork',
      'runs.goto POST /v1/runs/:id/goto',
      'runs.mail POST /v1/runs/:id/mail',
      'runs.poke POST /v1/runs/:id/poke',
      'runs.remove DELETE /v1/runs/:id',
      'runs.retry POST /v1/runs/:id/retry',
      'runs.screen GET /v1/runs/:id/screen',
      'runs.show GET /v1/runs/:id',
      'runs.start POST /v1/start',
      'runs.status GET /v1/status',
      'snapshot.show GET /v1/snapshot',
      'steps.reports GET /v1/steps',
      'sweeps.run POST /v1/sweeps/:name',
    ])
  })
})

describe('slimBoard and snapshot (claude-factory-hpmc.23)', () => {
  const board = {
    lease: { holder: 'h' },
    manager: [],
    rigs: [{ name: 'a', factory: 'lifecycle', maxRuns: 3, goal: 'long goal', sweeps: ['x'] }],
    runs: [
      {
        id: 'r1',
        node: 'build',
        sub: 'work',
        since: 5,
        bead: 'a-1',
        rig: 'a',
        goal: 'g'.repeat(300),
        last: 'summary text',
        trail: [{ node: 'plan' }],
        gate: { question: 'ok?' },
      },
    ],
  }
  test('slimBoard drops summary and trail text, cuts the goal, keeps the ids and the gate', () => {
    const s = slimBoard(board) as typeof board
    expect(s.runs[0]).toMatchObject({ id: 'r1', node: 'build', sub: 'work', since: 5, bead: 'a-1', rig: 'a' })
    expect(s.runs[0]).not.toHaveProperty('last')
    expect(s.runs[0]).not.toHaveProperty('trail')
    expect(s.runs[0]!.goal.length).toBeLessThanOrEqual(120)
    expect((s.runs[0] as { gate?: unknown }).gate).toEqual({ question: 'ok?' })
    expect(s.rigs as unknown[]).toEqual([{ name: 'a', factory: 'lifecycle', maxRuns: 3 }])
    expect(s.lease).toEqual({ holder: 'h' })
    expect(JSON.stringify(s).length).toBeLessThan(JSON.stringify(board).length)
  })
  test('the board view and the slim board keep the halt state and its age first', () => {
    const paused = { halt: 'paused', haltAt: 1, ...board }
    for (const v of [boardView(paused), slimBoard(paused)])
      expect(Object.keys(v as object).slice(0, 2)).toEqual(['halt', 'haltAt'])
  })
  test('slimBoard returns a value that is not a board unchanged', () => {
    expect(slimBoard(null)).toBeNull()
    expect(slimBoard({ x: 1 })).toEqual({ x: 1 })
  })
  const ctx = (calls: string[]) =>
    ({
      home: '/h',
      env: {},
      port: {},
      board: () => board,
      cli: async (argv: string[]) => {
        calls.push(argv.join(' '))
        return { code: 0, out: '{"ok":1}\n', err: '' }
      },
    }) as never
  test('snapshot runs the named views in one call', async () => {
    const calls: string[] = []
    const r = await snapshot(ctx(calls), { views: 'board,lease' })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.out)
    expect(Object.keys(out.views)).toEqual(['board', 'lease'])
    expect(out.views.board.runs[0]).not.toHaveProperty('last')
  })
  test('snapshot refuses a view that is not a read view, and a repeated view', async () => {
    const calls: string[] = []
    for (const views of ['runs.abort', 'board,board', '', 'nope'])
      expect((await snapshot(ctx(calls), { views })).code).toBe(1)
    expect(calls).toEqual([])
  })
  test('snapshot reports a failing view and still returns the others', async () => {
    const c = ctx([])
    ;(c as { board: () => unknown }).board = () => {
      throw new Error('no tick yet')
    }
    const out = JSON.parse((await snapshot(c, { views: 'board,lease' })).out)
    expect(out.views.board).toEqual({ error: 'no tick yet' })
    expect(out.views.lease).toBeDefined()
  })
  test('snapshot --max-age answers from the cache and computes a view only when it is older (ql0jz)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-'))
    let computed = 0
    const c = {
      home,
      env: {},
      port: {},
      cli: async () => ({ code: 0, out: '', err: '' }),
      board: () => (computed++, board),
    } as never
    const run = (maxAge?: string) => snapshot(c, { views: 'board', ...(maxAge ? { maxAge } : {}) })
    await run('60000')
    expect(computed).toBe(1)
    expect(snapFresh(home, 'board', 60000)).toBe(true)
    expect(snapFresh(home, 'board', 60000, Date.now() + 61000)).toBe(false)
    expect(JSON.parse((await run('60000')).out).views.board.runs[0].id).toBe('r1')
    expect(computed).toBe(1) // the second call read the cache
    await Bun.sleep(5)
    await run('0') // a view older than 0 ms is computed again
    expect(computed).toBe(2)
    await run() // no maxAge: no cache read
    expect(computed).toBe(3)
  })
})
