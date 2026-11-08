/** The operation catalog. It lists each feature of the manager with its inputs and its /v1 route. It imports node: modules only. */

export type Kind = 'id' | 'text' | 'note' | 'path' | 'flag' | 'enum'
export type Field = { name: string; kind: Kind; required: boolean; help: string; values?: string[] }
export type RunResult = { code: number; out: string; err: string; timedOut?: boolean }
/** run one CLI form; `text` is mail text that the runner passes by file */
export type Runner = (argv: string[], text?: string) => Promise<RunResult>
export type Ctx = { home: string; cli: Runner; board: () => unknown }
export type Input = Record<string, string | boolean>
export type Op = {
  name: string
  summary: string
  inputs: Field[]
  output: 'table' | 'text' | 'json' | 'stream'
  rights: 'read' | 'owner' | 'manager'
  mutates: boolean
  long: boolean
  route: { method: 'GET' | 'POST'; path: string }
  since: number
  run: (ctx: Ctx, input: Input) => Promise<RunResult>
}

/** an error with an HTTP status that the client port shows as is */
export class OpError extends Error {
  constructor(
    readonly status: number,
    why: string,
  ) {
    super(why)
  }
}

export const CATALOG_VERSION = 1

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_TEXT = 65536

export function fieldOk(f: Field, v: unknown): boolean {
  switch (f.kind) {
    case 'id':
      return typeof v === 'string' && ID.test(v)
    case 'text':
    case 'note':
      return (
        typeof v === 'string' &&
        v.length <= MAX_TEXT &&
        (f.kind === 'note' || v.length >= 1) &&
        !v.includes('\u0000')
      )
    case 'path':
      return typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !v.includes('\u0000')
    case 'flag':
      return v === true
    case 'enum':
      return typeof v === 'string' && (f.values ?? []).includes(v)
  }
}

const routeKey = (o: Op) => `${o.route.method} ${o.route.path.replace(/:[^/]+/g, ':')}`
const params = (o: Op) => o.route.path.split('/').filter(s => s.startsWith(':'))

/** Check every rule, else throw: a bad catalog serves nothing. Return a copy sorted by name. */
export function makeCatalog(ops: Op[]): Op[] {
  const names = new Set<string>()
  const routes = new Set<string>()
  for (const o of ops) {
    const bad = (why: string): never => {
      throw new Error(`catalog: ${o.name}: ${why}`)
    }
    if (!/^[a-z]+\.[a-z]+$/.test(o.name)) bad('the name must be <group>.<verb>')
    if (names.has(o.name)) bad('duplicate name')
    names.add(o.name)
    const key = routeKey(o)
    if (routes.has(key)) bad(`duplicate route ${key}`)
    routes.add(key)
    if (o.mutates && o.rights === 'read') bad('a mutating operation must not have read rights')
    if (o.mutates && o.route.method === 'GET') bad('a mutating operation must not use GET')
    if (!o.route.path.startsWith('/v1/')) bad('the path must start with /v1/')
    if (new Set(o.inputs.map(f => f.name)).size !== o.inputs.length) bad('duplicate input name')
    for (const p of params(o)) {
      const f = o.inputs.find(i => i.name === p.slice(1))
      if (!f || f.kind !== 'id' || !f.required) bad(`path param ${p} needs a required id input`)
    }
    for (const f of o.inputs)
      if (f.kind === 'enum' && !f.values?.length) bad(`enum input ${f.name} has no values`)
  }
  return [...ops].sort((a, b) => (a.name < b.name ? -1 : 1))
}

const pathNames = (op: Op) => params(op).map(p => p.slice(1))

/** path params are the raw segments of url.pathname, in route order, never decoded */
export function readQuery(op: Op, ps: string[], search: string): Input | 'bad path segment' | 'bad query' {
  const idKind = { name: '', kind: 'id', required: true, help: '' } as const
  if (!ps.every(p => fieldOk(idKind, p))) return 'bad path segment'
  const input: Input = {}
  pathNames(op).forEach((n, i) => (input[n] = ps[i]!))
  const qin = op.route.method === 'GET' ? op.inputs.filter(f => !pathNames(op).includes(f.name)) : []
  if (!qin.length) return search === '' ? input : 'bad query'
  const q = new URLSearchParams(search)
  const keys = [...q.keys()]
  if (new Set(keys).size !== keys.length) return 'bad query'
  for (const k of keys) {
    const f = qin.find(i => i.name === k)
    if (!f) return 'bad query'
    const raw = q.get(k)!
    const v = f.kind === 'flag' ? (raw === '1' ? true : raw) : raw
    if (!fieldOk(f, v)) return 'bad query'
    input[k] = v
  }
  if (qin.some(f => f.required && !(f.name in input))) return 'bad query'
  return input
}

export function readBody(op: Op, input: Input, b: Record<string, unknown>): Input | 'bad body' {
  const bin = op.inputs.filter(f => !pathNames(op).includes(f.name))
  const out: Input = { ...input }
  for (const [k, v] of Object.entries(b)) {
    const f = bin.find(i => i.name === k)
    if (!f || !fieldOk(f, v)) return 'bad body'
    out[k] = v as string | boolean
  }
  if (bin.some(f => f.required && !Object.hasOwn(b, f.name))) return 'bad body'
  return out
}

const H: Record<string, string> = {
  id: 'the run id',
  run: 'the run id; all runs when not set',
  rig: 'the rig name',
  since: 'the start of the time window, for example 7d',
  json: 'print JSON',
  tokens: 'add the token counts',
  outcome: 'the gate outcome, for example approve',
  note: 'a note for the gate; can be empty',
  to: 'the station that gets the mail',
  from: 'the sender: manager only',
  cwd: 'the working folder of the sender',
  wake: 'wake the station now',
  node: 'the station to go to',
  factory: 'the factory name',
  station: 'the station to start at',
  goal: 'the goal of the run',
  owned: 'the person owns the run',
  mode: 'stop or resume',
  bead: 'the bead id',
}
const f = (name: string, kind: Kind, required = true, help = H[name]!, values?: string[]): Field => ({
  name,
  kind,
  required,
  help,
  ...(values ? { values } : {}),
})
const id = (name: string) => f(name, 'id')

type Spec = { name: string; summary: string; method: 'GET' | 'POST'; path: string; inputs?: Field[] }
const bridge = (
  s: Spec,
  argv: (i: Input) => string[],
  output: Op['output'] = 'text',
  text?: (i: Input) => string,
): Op => ({
  name: s.name,
  summary: s.summary,
  inputs: s.inputs ?? [],
  output,
  rights: s.method === 'GET' ? 'read' : 'owner',
  mutates: s.method === 'POST',
  long: false,
  route: { method: s.method, path: s.path },
  since: CATALOG_VERSION,
  run: (ctx, i) => ctx.cli(argv(i), text?.(i)),
})
const local = (s: Spec, output: Op['output'], run: Op['run']): Op => ({ ...bridge(s, () => []), output, run })
const opt = (i: Input, k: string, flag: string) => (i[k] === undefined ? [] : [flag, i[k] as string])

/** the 17 operations: the 14 routes of the client port, the board, the catalog and the parity fixture */
export const CATALOG: Op[] = makeCatalog([
  local(
    {
      name: 'board.show',
      summary: 'Show the board of the last tick: runs, rigs, halt and mail.',
      method: 'GET',
      path: '/v1/board',
    },
    'json',
    async ctx => {
      const b = ctx.board()
      if (b === null || b === undefined) throw new OpError(503, 'no tick yet')
      return { code: 0, out: JSON.stringify(b) + '\n', err: '' }
    },
  ),
  local(
    { name: 'catalog.show', summary: 'Show the catalog of operations.', method: 'GET', path: '/v1/catalog' },
    'json',
    async () => {
      // ponytail: no factory identity and no revisions exist yet (spec 006). Upgrade path: the 006 envelope.
      const env = {
        schemaVersion: 1,
        factoryId: 'factory',
        revision: 0,
        observedAt: new Date().toISOString(),
        data: {
          version: CATALOG_VERSION,
          operations: CATALOG.map(
            ({ name, summary, inputs, output, rights, mutates, long, route, since }) => ({
              name,
              summary,
              inputs,
              output,
              rights,
              mutates,
              long,
              route,
              since,
            }),
          ),
        },
      }
      return { code: 0, out: JSON.stringify(env) + '\n', err: '' }
    },
  ),
  local(
    {
      name: 'catalog.echo',
      summary: 'Return the text. The parity tests use it.',
      method: 'GET',
      path: '/v1/catalog/echo',
      inputs: [f('text', 'text', true, 'the text to return')],
    },
    'text',
    async (_, i) => ({ code: 0, out: (i.text as string) + '\n', err: '' }),
  ),
  bridge(
    {
      name: 'runs.show',
      summary: 'Show one run as JSON.',
      method: 'GET',
      path: '/v1/runs/:id',
      inputs: [id('id')],
    },
    i => ['show', i.id as string],
    'json',
  ),
  bridge(
    {
      name: 'runs.status',
      summary: 'Show the status of all runs, or of one run.',
      method: 'GET',
      path: '/v1/status',
      inputs: [f('run', 'id', false)],
    },
    i => ['status', ...(i.run === undefined ? [] : [i.run as string])],
  ),
  bridge(
    { name: 'prs.show', summary: 'Show the open pull requests of the runs.', method: 'GET', path: '/v1/prs' },
    () => ['prs'],
  ),
  bridge(
    { name: 'backlog.show', summary: 'Show the backlog of each rig.', method: 'GET', path: '/v1/backlog' },
    () => ['backlog'],
  ),
  bridge(
    {
      name: 'decisions.list',
      summary: 'List the questions that wait for the person.',
      method: 'GET',
      path: '/v1/decisions',
    },
    () => ['decisions', 'list'],
  ),
  bridge({ name: 'plan.show', summary: 'Show the plan.', method: 'GET', path: '/v1/plan' }, () => [
    'plan',
    'show',
  ]),
  bridge(
    {
      name: 'metrics.show',
      summary: 'Show the run metrics.',
      method: 'GET',
      path: '/v1/metrics',
      inputs: [
        f('rig', 'id', false),
        f('since', 'id', false),
        f('json', 'flag', false),
        f('tokens', 'flag', false),
      ],
    },
    i => [
      'metrics',
      ...opt(i, 'rig', '--rig'),
      ...opt(i, 'since', '--since'),
      ...(i.json ? ['--json'] : []),
      ...(i.tokens ? ['--tokens'] : []),
    ],
  ),
  bridge(
    {
      name: 'gates.decide',
      summary: 'Decide a gate of a run.',
      method: 'POST',
      path: '/v1/runs/:id/decide',
      inputs: [id('id'), id('outcome'), f('note', 'note')],
    },
    i => ['decide', i.id as string, i.outcome as string, ...(i.note ? [i.note as string] : [])],
  ),
  bridge(
    {
      name: 'runs.mail',
      summary: 'Send mail to a station of a run as the manager.',
      method: 'POST',
      path: '/v1/runs/:id/mail',
      inputs: [
        id('id'),
        id('to'),
        f('text', 'text', true, 'the mail text'),
        f('from', 'enum', true, undefined, ['manager']),
        f('cwd', 'path'),
        f('wake', 'flag', false),
      ],
    },
    i => ['mail', i.id as string, i.to as string, ...(i.wake ? ['--wake'] : [])],
    'text',
    i => i.text as string,
  ),
  bridge(
    {
      name: 'runs.goto',
      summary: 'Move a run to a station.',
      method: 'POST',
      path: '/v1/runs/:id/goto',
      inputs: [id('id'), id('node')],
    },
    i => ['goto', i.id as string, i.node as string],
  ),
  bridge(
    {
      name: 'runs.abort',
      summary: 'Abort a run and close its worker.',
      method: 'POST',
      path: '/v1/runs/:id/abort',
      inputs: [id('id')],
    },
    i => ['abort', i.id as string],
  ),
  bridge(
    {
      name: 'runs.start',
      summary: 'Start a run of a factory on a rig.',
      method: 'POST',
      path: '/v1/start',
      inputs: [
        id('factory'),
        id('rig'),
        f('goal', 'text'),
        f('station', 'id', false),
        f('owned', 'flag', false),
      ],
    },
    i => [
      'start',
      i.station ? `${i.factory}@${i.station}` : (i.factory as string),
      i.rig as string,
      i.goal as string,
      ...(i.owned ? ['--owned'] : []),
    ],
  ),
  bridge(
    {
      name: 'factory.halt',
      summary: 'Stop or resume the factory.',
      method: 'POST',
      path: '/v1/halt',
      inputs: [f('mode', 'enum', true, undefined, ['stop', 'resume'])],
    },
    i => [i.mode as string],
  ),
  bridge(
    {
      name: 'decisions.answer',
      summary: 'Answer a question that waits for the person.',
      method: 'POST',
      path: '/v1/decisions/:rig/:bead/answer',
      inputs: [id('rig'), id('bead'), f('text', 'text', true, 'the answer')],
    },
    i => ['decisions', 'answer', i.rig as string, i.bead as string, i.text as string],
  ),
])
