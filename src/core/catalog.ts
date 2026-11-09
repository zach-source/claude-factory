/** The operation catalog. It lists each feature of the manager with its inputs and its /v1 route. It imports node: modules, the operation files in ./ops, and types from ../metrics. */
import type { ManagerUsage, RunRecord } from '../metrics'
import * as backlogOps from './ops/backlog'
import * as decisionsOps from './ops/decisions'
import * as gatesOps from './ops/gates'
import * as leaseOps from './ops/lease'
import * as mailOps from './ops/mail'
import * as metricsOps from './ops/metrics'
import * as planOps from './ops/plan'
import * as prsOps from './ops/prs'
import * as rigsOps from './ops/rigs'
import * as runnersOps from './ops/runners'
import * as runsOps from './ops/runs'
import * as stepsOps from './ops/steps'

export type Kind = 'id' | 'text' | 'note' | 'path' | 'flag' | 'enum'
export type Field = { name: string; kind: Kind; required: boolean; help: string; values?: string[] }
export type RunResult = { code: number; out: string; err: string; timedOut?: boolean }
/** run one CLI form; `text` is mail text that the runner passes by file */
export type Runner = (argv: string[], text?: string) => Promise<RunResult>
export type Env = Record<string, string | undefined>
export type Print = (line: string) => void
/** the cli.ts helpers that the moved operations call; cli.ts builds it, tests fake it */
export type Port = {
  show: (id: string | undefined) => Promise<unknown>
  status: (id: string | undefined, print: Print) => Promise<void>
  backlog: () => Promise<unknown>
  prs: () => Promise<unknown>
  decisionsList: () => unknown
  planShowText: () => string
  gateBriefFacts: (id: string | undefined) => Promise<unknown>
  records: () => RunRecord[]
  refreshMerges: (recs: RunRecord[]) => Promise<RunRecord[]>
  managerUsage: (since: number) => ManagerUsage[]
  rigList: (print: Print) => Promise<void>
  decide: (id: string | undefined, outcome: string | undefined, note: string, print: Print) => Promise<void>
  decisionsAnswer: (rig: string, bead: string, text: string, print: Print) => void
  goto: (id: string | undefined, node: string | undefined, print: Print) => Promise<void>
  abort: (id: string | undefined) => void
  mail: (
    m: { id: string | undefined; to: string | undefined; text: string; wake: boolean },
    who: { env: Env; cwd: string },
    print: Print,
  ) => Promise<void>
}
/** `env` is the environment of the caller: the CLI gives process.env, the server gives personEnv */
export type Ctx = { home: string; cli: Runner; board: () => unknown; env: Env; port: Port }
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

/**
 * Run `fn` with a line buffer, as the CLI prints. A thrown OpError goes up. Any other thrown Error gives
 * code 1, the lines printed before it, and the CLI's own `factory: <msg>` line on err.
 */
export async function inProc(fn: (print: Print) => unknown): Promise<RunResult> {
  const lines: string[] = []
  const out = () => lines.map(l => `${l}\n`).join('')
  try {
    await fn(l => lines.push(l))
    return { code: 0, out: out(), err: '' }
  } catch (e) {
    if (e instanceof OpError || !(e instanceof Error)) throw e
    return { code: 1, out: out(), err: `factory: ${e.message}\n` }
  }
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

/** the 23 operations: the routes of the client port, the board, the catalog and the parity fixture */
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
  local(
    {
      name: 'runs.show',
      summary: 'Show one run as JSON.',
      method: 'GET',
      path: '/v1/runs/:id',
      inputs: [id('id')],
    },
    'json',
    (c, i) => runsOps.show(c, i),
  ),
  local(
    {
      name: 'runs.status',
      summary: 'Show the status of all runs, or of one run.',
      method: 'GET',
      path: '/v1/status',
      inputs: [f('run', 'id', false)],
    },
    'text',
    (c, i) => runsOps.status(c, i),
  ),
  local(
    { name: 'prs.show', summary: 'Show the open pull requests of the runs.', method: 'GET', path: '/v1/prs' },
    'text',
    (c, i) => prsOps.show(c, i),
  ),
  local(
    { name: 'backlog.show', summary: 'Show the backlog of each rig.', method: 'GET', path: '/v1/backlog' },
    'text',
    (c, i) => backlogOps.show(c, i),
  ),
  local(
    {
      name: 'decisions.list',
      summary: 'List the questions that wait for the person.',
      method: 'GET',
      path: '/v1/decisions',
    },
    'text',
    (c, i) => decisionsOps.list(c, i),
  ),
  local({ name: 'plan.show', summary: 'Show the plan.', method: 'GET', path: '/v1/plan' }, 'text', (c, i) =>
    planOps.show(c, i),
  ),
  local(
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
    'text',
    (c, i) => metricsOps.show(c, i),
  ),
  local(
    {
      name: 'gates.brief',
      summary: 'Show the facts of the gate of a run.',
      method: 'GET',
      path: '/v1/runs/:id/brief',
      inputs: [id('id')],
    },
    'json',
    (c, i) => gatesOps.brief(c, i),
  ),
  local(
    {
      name: 'rigs.list',
      summary: 'List the rigs, their runs and their settings.',
      method: 'GET',
      path: '/v1/rigs',
    },
    'text',
    (c, i) => rigsOps.list(c, i),
  ),
  local(
    {
      name: 'runners.show',
      summary: 'Show the live runs and rigs on each runner.',
      method: 'GET',
      path: '/v1/runners',
    },
    'json',
    (c, i) => runnersOps.show(c, i),
  ),
  local(
    {
      name: 'mail.list',
      summary: 'List the manager mail of the last tick.',
      method: 'GET',
      path: '/v1/mail',
    },
    'json',
    (c, i) => mailOps.list(c, i),
  ),
  local(
    {
      name: 'steps.reports',
      summary: 'Show the last patrol, pm, brief and review reports.',
      method: 'GET',
      path: '/v1/steps',
    },
    'json',
    (c, i) => stepsOps.reports(c, i),
  ),
  local(
    { name: 'lease.show', summary: 'Show the manager lease.', method: 'GET', path: '/v1/lease' },
    'text',
    (c, i) => leaseOps.show(c, i),
  ),
  local(
    {
      name: 'gates.decide',
      summary: 'Decide a gate of a run.',
      method: 'POST',
      path: '/v1/runs/:id/decide',
      inputs: [id('id'), id('outcome'), f('note', 'note')],
    },
    'text',
    (c, i) => gatesOps.decide(c, i),
  ),
  local(
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
    'text',
    async (c, i) => {
      // the text file form of the old runner cut the end and refused a text of only blanks
      const text = typeof i.text === 'string' ? i.text.trimEnd() : ''
      if (!text) throw new OpError(422, 'the mail text is empty')
      return runsOps.mail(c, { ...i, text })
    },
  ),
  local(
    {
      name: 'runs.goto',
      summary: 'Move a run to a station.',
      method: 'POST',
      path: '/v1/runs/:id/goto',
      inputs: [id('id'), id('node')],
    },
    'text',
    (c, i) => runsOps.goto(c, i),
  ),
  local(
    {
      name: 'runs.abort',
      summary: 'Abort a run and close its worker.',
      method: 'POST',
      path: '/v1/runs/:id/abort',
      inputs: [id('id')],
    },
    'text',
    (c, i) => runsOps.abort(c, i),
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
  local(
    {
      name: 'decisions.answer',
      summary: 'Answer a question that waits for the person.',
      method: 'POST',
      path: '/v1/decisions/:rig/:bead/answer',
      inputs: [id('rig'), id('bead'), f('text', 'text', true, 'the answer')],
    },
    'text',
    (c, i) => decisionsOps.answer(c, i),
  ),
])
