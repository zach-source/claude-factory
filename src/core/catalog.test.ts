import { describe, expect, test } from 'bun:test'
import {
  CATALOG,
  CATALOG_VERSION,
  fieldOk,
  makeCatalog,
  readBody,
  readQuery,
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
  test('has 27 operations: 18 GET and 9 POST', () => {
    expect(CATALOG.length).toBe(27)
    expect(CATALOG.filter(o => o.route.method === 'GET').length).toBe(18)
    expect(CATALOG.filter(o => o.route.method === 'POST').length).toBe(9)
    expect(CATALOG.filter(o => o.route.method === 'POST' && !o.mutates).map(o => o.name)).toEqual([
      'guard.check',
    ])
  })
  test('rights map as before', () => {
    for (const o of CATALOG) {
      const get = o.route.method === 'GET' || o.name === 'guard.check'
      expect(o.rights).toBe(get ? 'read' : 'owner')
      expect(o.mutates).toBe(!get)
      expect(o.long).toBe(o.name === 'chat.send')
      expect(o.since).toBe(1)
    }
    expect(CATALOG_VERSION).toBe(1)
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
    ])
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
      'backlog.show GET /v1/backlog',
      'board.show GET /v1/board',
      'catalog.echo GET /v1/catalog/echo',
      'catalog.show GET /v1/catalog',
      'chat.send POST /v1/conversations/:id',
      'chat.show GET /v1/conversations/:id',
      'decisions.answer POST /v1/decisions/:rig/:bead/answer',
      'decisions.list GET /v1/decisions',
      'factory.halt POST /v1/halt',
      'gates.brief GET /v1/runs/:id/brief',
      'gates.decide POST /v1/runs/:id/decide',
      'guard.check POST /v1/guard/check',
      'lease.show GET /v1/lease',
      'mail.list GET /v1/mail',
      'metrics.show GET /v1/metrics',
      'plan.show GET /v1/plan',
      'prs.show GET /v1/prs',
      'rigs.list GET /v1/rigs',
      'runners.show GET /v1/runners',
      'runs.abort POST /v1/runs/:id/abort',
      'runs.goto POST /v1/runs/:id/goto',
      'runs.mail POST /v1/runs/:id/mail',
      'runs.screen GET /v1/runs/:id/screen',
      'runs.show GET /v1/runs/:id',
      'runs.start POST /v1/start',
      'runs.status GET /v1/status',
      'steps.reports GET /v1/steps',
    ])
  })
})
