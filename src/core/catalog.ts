/** The operation catalog. It imports node: modules, ./chat, ./guards, the operation files in ./ops, and types from ../metrics and ../once. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FlowRun } from '../flows'
import type { Factory } from '../machine'
import type { ManagerUsage, RunRecord } from '../metrics'
import type { ModelCall, ModelResult } from '../once'
import { redactRig } from '../rigs-edit'
import * as chat from './chat'
import { check, type Role } from './guards'
import * as backlogOps from './ops/backlog'
import * as decisionsOps from './ops/decisions'
import * as interviewOps from './ops/interview'
import * as gatesOps from './ops/gates'
import * as gcOps from './ops/gc'
import * as imageOps from './ops/image'
import * as leaseOps from './ops/lease'
import * as mailOps from './ops/mail'
import * as managerOps from './ops/manager'
import * as flowsOps from './ops/flows'
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
  gcPass: (days: number, dryRun: boolean, print: Print, error: Print) => void | Promise<void>
  gcWorktreesPass: (
    dryRun: boolean,
    rig: string | undefined,
    print: Print,
    error: Print,
  ) => void | Promise<void>
  gcRigs: () => string[] | Promise<string[]>
  gcHold: (name: string) => (() => void) | null | undefined
  gcStamp: (name: string) => void
  /** build and push the image of a target, store its ref and return it; warnings go to `error` */
  imageBuild: (target: 'worker' | 'manager', error: Print) => Promise<string>
  show: (id: string | undefined) => Promise<unknown>
  status: (id: string | undefined, print: Print) => Promise<void>
  backlog: () => Promise<unknown>
  prs: () => Promise<unknown>
  decisionsList: () => unknown
  planShowText: () => string
  gateBriefFacts: (id: string | undefined) => Promise<unknown>
  records: () => RunRecord[]
  /** the factory (default lifecycle) and its runs, for flows.show */
  flowData: (factory: string | undefined) => Promise<{ def: Factory; runs: FlowRun[] }>
  refreshMerges: (recs: RunRecord[]) => Promise<RunRecord[]>
  managerUsage: (since: number) => ManagerUsage[]
  rigList: (print: Print) => Promise<void>
  decide: (id: string | undefined, outcome: string | undefined, note: string, print: Print) => Promise<void>
  decisionsAnswer: (rig: string, bead: string, text: string, print: Print) => void
  goto: (id: string | undefined, node: string | undefined, print: Print) => Promise<void>
  abort: (id: string | undefined) => void
  /** the bounded worker screen of a run; throws a reason when there is none */
  screen: (id: string | undefined) => Promise<string>
  /** one async manager chat model call (src/once.ts runModelAsync); a fake in tests */
  chatModel: (c: ModelCall) => Promise<ModelResult>
  chatRun: (c: {
    command: string
    cwd: string
    env: Env
    timeoutMs: number
  }) => Promise<{ code: number; out: string }>
  /** type text and Enter into the manager pane (ax.say) */
  say: (text: string) => unknown
  /** the pod's manager task: a new image (delete and apply), and suspend or resume (managersup) */
  managerImage: (image: string) => Promise<void>
  managerSuspend: (on: boolean) => Promise<void>
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
  /** read: any caller. manager: the person or the manager. owner: the person only. */
  rights: 'read' | 'owner' | 'manager'
  mutates: boolean
  long: boolean
  route: { method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'; path: string }
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

export type Caller = 'person' | 'manager'

/** The person may call every operation. The manager may not call an owner operation (FR-019). */
export const allowed = (rights: Op['rights'], who: Caller): boolean => who === 'person' || rights !== 'owner'

/** Check every rule, else throw: a bad catalog serves nothing. Return a copy sorted by name. */
export function makeCatalog(ops: Op[]): Op[] {
  const names = new Set<string>()
  const routes = new Set<string>()
  const seen: { method: string; path: string; segs: string[] }[] = []
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
    const segs = o.route.path.split('/')
    for (const r of seen) {
      if (r.method !== o.route.method || r.segs.length !== segs.length) continue
      if (r.segs.every((s, i) => s === segs[i] || s.startsWith(':') || segs[i]!.startsWith(':')))
        bad(`route ${o.route.path} overlaps ${r.path}`)
    }
    seen.push({ method: o.route.method, path: o.route.path, segs })
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
  runner: 'the remote runner name, for example ax',
  codex: 'wake the stations that a Codex limit holds',
  template: 'the factory template; lifecycle when not set',
}
const f = (name: string, kind: Kind, required = true, help = H[name]!, values?: string[]): Field => ({
  name,
  kind,
  required,
  help,
  ...(values ? { values } : {}),
})
const id = (name: string) => f(name, 'id')

type Spec = {
  name: string
  summary: string
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'
  path: string
  inputs?: Field[]
  rights?: Op['rights']
}
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
  rights: s.rights ?? (s.method === 'GET' ? 'read' : 'manager'),
  mutates: s.method !== 'GET',
  long: false,
  route: { method: s.method, path: s.path },
  since: CATALOG_VERSION,
  run: (ctx, i) => ctx.cli(argv(i), text?.(i)),
})
/** Run a CLI verb that reads its input from a file: write the text to a file in the home, run, then delete the file. */
const viaFile =
  (argv: (path: string) => string[], text: (i: Input) => string): Op['run'] =>
  async (ctx, i) => {
    const dir = join(ctx.home, 'text')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `put-${randomUUID()}.json`)
    writeFileSync(path, text(i), { mode: 0o600 })
    try {
      return await ctx.cli(argv(path))
    } finally {
      rmSync(path, { force: true })
    }
  }
const local = (s: Spec, output: Op['output'], run: Op['run']): Op => ({ ...bridge(s, () => []), output, run })

type Leaf = 'string' | 'number' | 'strings'
const leafOk = (v: unknown, t: Leaf): boolean =>
  t === 'string'
    ? typeof v === 'string'
    : t === 'number'
      ? typeof v === 'number' && Number.isFinite(v)
      : Array.isArray(v) && v.every(x => typeof x === 'string')

/** Keep the listed keys of an object. A value of the wrong type throws; the message names no value. */
const pick = (o: unknown, keys: Record<string, Leaf>): Record<string, unknown> => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('board rig is malformed')
  const r = o as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, t] of Object.entries(keys)) {
    if (r[k] === undefined) continue
    if (!leafOk(r[k], t)) throw new Error(`board rig field ${k} is malformed`)
    out[k] = r[k]
  }
  return out
}

/**
 * The board a client may read: each rig keeps only the fields a front end draws (mod/types FactoryRig).
 * Fail closed: env, params, beadsRemote and any unknown field never leave. A malformed rig list throws.
 */
export function boardView(b: unknown): unknown {
  if (!b || typeof b !== 'object' || (b as { rigs?: unknown }).rigs === undefined) return b
  const rigs = (b as { rigs: unknown }).rigs
  if (!Array.isArray(rigs)) throw new Error('board rigs are malformed')
  const view = rigs.map(r => {
    const o = pick(r, {
      name: 'string',
      repo: 'string',
      factory: 'string',
      maxRuns: 'number',
      sweeps: 'strings',
      goal: 'string',
      runner: 'string',
      sandboxClass: 'string',
    })
    const src = r as Record<string, unknown>
    if (src.linear !== undefined)
      o.linear = pick(src.linear, { team: 'strings', projects: 'strings', labels: 'strings' })
    if (src.linearSync !== undefined)
      o.linearSync = pick(src.linearSync, {
        at: 'number',
        pulled: 'number',
        created: 'number',
        updated: 'number',
        stripped: 'number',
        unrouted: 'number',
        error: 'string',
      })
    return redactRig(o)
  })
  return { ...b, rigs: view }
}

const HEAD = 120
const head = (v: unknown) => (typeof v === 'string' && v.length > HEAD ? v.slice(0, HEAD - 1) + '…' : v)

/**
 * The slim board (claude-factory-hpmc.23): the runs without summary and trail text, the goal and error cut
 * to a head, and each rig reduced to its name, factory and cap. A value that is not a board stays as is.
 */
export function slimBoard(b: unknown): unknown {
  if (!b || typeof b !== 'object' || !Array.isArray((b as { runs?: unknown }).runs)) return b
  const o = b as { runs: Record<string, unknown>[]; rigs?: Record<string, unknown>[] }
  const runs = o.runs.map(({ last: _l, trail: _t, summary: _s, ...r }) => ({
    ...r,
    ...(r.goal !== undefined ? { goal: head(r.goal) } : {}),
    ...(r.error !== undefined ? { error: head(r.error) } : {}),
  }))
  const rigs = Array.isArray(o.rigs)
    ? o.rigs.map(r => ({ name: r.name, factory: r.factory, maxRuns: r.maxRuns }))
    : o.rigs
  return { ...o, runs, ...(rigs ? { rigs } : {}) }
}

/**
 * the view names of `snapshot`: the group of each read op that has no required input, or one full op name
 * (`manager.context`) when a group has several such ops and the first is not the one wanted
 */
const viewOp = (view: string): Op | undefined =>
  CATALOG.find(
    o =>
      (view.includes('.') ? o.name === view : o.name.split('.')[0] === view) &&
      o.name !== 'snapshot.show' &&
      o.route.method === 'GET' &&
      o.rights === 'read' &&
      !o.route.path.includes(':') &&
      !o.inputs.some(i => i.required),
  )

const SNAP_CACHE = 'snapshot-cache.json'

/** the cached views of a home: { view: { at, value } }. A missing or bad file is an empty cache. */
function readSnapCache(home: string): Record<string, { at: number; value: unknown }> {
  try {
    return JSON.parse(readFileSync(join(home, SNAP_CACHE), 'utf8'))
  } catch {
    return {}
  }
}

/** true when `view` has a cached answer that is at most `maxAge` ms old */
export const snapFresh = (home: string, view: string, maxAge: number, now = Date.now()): boolean => {
  const c = readSnapCache(home)[view]
  return !!c && now - c.at <= maxAge
}

/**
 * `factory snapshot --views a,b`: several read views in one call, so a front end polls once (hpmc.23).
 * With `maxAge` (ms), a view that was computed at most that long ago comes from `snapshot-cache.json`
 * (ql0jz): a slow view, such as the decisions of a remote manager, does not block each call.
 */
export async function snapshot(ctx: Ctx, i: Input): Promise<RunResult> {
  const names = String(i.views ?? '')
    .split(',')
    .map(v => v.trim())
  const ops = names.map(viewOp)
  const bad = names.find((n, k) => !n || !ops[k] || names.indexOf(n) !== k)
  if (bad !== undefined || !names.length)
    return { code: 1, out: '', err: `factory: snapshot: not a view: ${bad || '(none)'}\n` }
  const maxAge = i.maxAge === undefined ? -1 : Number(i.maxAge)
  const cache = readSnapCache(ctx.home)
  const views: Record<string, unknown> = {}
  let dirty = false
  for (const [k, o] of ops.entries()) {
    const name = names[k]!
    const hit = cache[name]
    if (hit && Date.now() - hit.at <= maxAge) {
      views[name] = hit.value
      continue
    }
    try {
      const r = await o!.run(ctx, o!.name === 'board.show' ? { slim: true } : {})
      const text = r.out.trim()
      views[name] = r.code !== 0 ? { error: r.err.trim() || `exit ${r.code}` } : parseOr(text)
      if (r.code === 0 && maxAge >= 0) {
        cache[name] = { at: Date.now(), value: views[name] }
        dirty = true
      }
    } catch (e) {
      views[name] = { error: (e as Error).message }
    }
  }
  if (dirty) {
    try {
      writeFileSync(join(ctx.home, `${SNAP_CACHE}.tmp`), JSON.stringify(cache))
      renameSync(join(ctx.home, `${SNAP_CACHE}.tmp`), join(ctx.home, SNAP_CACHE))
    } catch {} // ponytail: a cache that cannot be written only costs speed
  }
  return { code: 0, out: JSON.stringify({ views }) + '\n', err: '' }
}
const parseOr = (t: string): unknown => {
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

/** The operations cover the client port, board, catalog and parity fixture. */
export const CATALOG: Op[] = makeCatalog([
  local(
    {
      name: 'gc.run',
      summary: 'Remove eligible run data or worktrees.',
      method: 'POST',
      path: '/v1/gc',
      rights: 'owner',
      inputs: [
        f('worktrees', 'flag', false, 'use the worktree pass'),
        f('dryRun', 'flag', false, 'preview without removal'),
        f('days', 'text', false, 'positive retention days'),
        f('rig', 'id', false, 'one configured rig for the worktree pass'),
      ],
    },
    'text',
    (c, i) => gcOps.run(c, i),
  ),
  {
    ...local(
      {
        name: 'image.build',
        summary: 'Build and push the worker or manager image, then store its ref.',
        method: 'POST',
        path: '/v1/image/build',
        rights: 'owner',
        inputs: [
          {
            name: 'target',
            kind: 'enum',
            required: false,
            values: ['worker', 'manager'],
            help: 'the image to build; worker when not set',
          },
        ],
      },
      'text',
      (c, i) => imageOps.run(c, i),
    ),
    long: true,
  },
  {
    ...local(
      {
        name: 'guard.check',
        summary: 'Check a Bash command of the manager or of a subagent: allow, ask or deny.',
        method: 'POST',
        path: '/v1/guard/check',
        inputs: [
          f('command', 'text', true, 'the Bash command, as the shell gets it'),
          {
            name: 'role',
            kind: 'enum',
            required: true,
            values: ['manager', 'subagent'],
            help: 'manager: the main chat of the manager; subagent: the rules of factory patrol-guard',
          },
        ],
      },
      'json',
      async (_, i) => ({
        code: 0,
        out: JSON.stringify(check(i.command as string, i.role as Role)) + '\n',
        err: '',
      }),
    ),
    rights: 'read',
    mutates: false,
  },
  local(
    {
      name: 'board.show',
      summary: 'Show the board of the last tick: runs, rigs, halt and mail.',
      method: 'GET',
      path: '/v1/board',
      inputs: [f('slim', 'flag', false, 'the slim board: no summary or trail text')],
    },
    'json',
    async (ctx, i) => {
      const b = ctx.board()
      if (b === null || b === undefined) throw new OpError(503, 'no tick yet')
      const v = boardView(b)
      return { code: 0, out: JSON.stringify(i.slim ? slimBoard(v) : v) + '\n', err: '' }
    },
  ),
  local(
    {
      name: 'snapshot.show',
      summary: 'Show several read views in one call, for example board,decisions.',
      method: 'GET',
      path: '/v1/snapshot',
      inputs: [
        f('views', 'text', true, 'the views, comma separated, for example board,decisions'),
        f('maxAge', 'id', false, 'a view computed at most this many ms ago comes from the cache'),
      ],
    },
    'json',
    (c, i) => snapshot(c, i),
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
  {
    ...local(
      {
        name: 'chat.send',
        summary: 'Send a message to the manager chat and wait for its answer.',
        method: 'POST',
        path: '/v1/conversations/:id',
        rights: 'owner',
        inputs: [
          f('id', 'id', true, 'the conversation id'),
          f('text', 'text', true, 'the message to the manager'),
          f('front', 'enum', true, 'the front end that sends', ['cli', 'web', 'claude-mod', 'herdr-mod']),
          f(
            'approve',
            'id',
            false,
            'a tool_use id from the asks of the last manager turn: the core runs that command one time before the next turn',
          ),
          f(
            'command',
            'text',
            false,
            'with approve: the exact command text that the person saw; the core refuses if the stored command differs',
          ),
        ],
      },
      'json',
      (c, i) =>
        chat.send(c, {
          id: i.id as string,
          text: i.text as string,
          front: i.front as chat.Front,
          approve: i.approve as string | undefined,
          command: i.command as string | undefined,
        }),
    ),
    long: true,
  },
  local(
    {
      name: 'chat.show',
      summary: 'Show a manager conversation: its session and its turns.',
      method: 'GET',
      path: '/v1/conversations/:id',
      inputs: [f('id', 'id', true, 'the conversation id')],
    },
    'json',
    (c, i) => inProc(print => print(JSON.stringify(chat.show(c.home, i.id as string)))),
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
      name: 'runs.screen',
      summary: 'Show the last screen of the worker of a run.',
      method: 'GET',
      path: '/v1/runs/:id/screen',
      inputs: [id('id')],
    },
    'text',
    (c, i) => runsOps.screen(c, i),
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
  local(
    {
      name: 'interview.list',
      summary: 'List the open questions for the person: gates, parked and stuck runs, and bead decisions.',
      method: 'GET',
      path: '/v1/interview',
    },
    'json',
    (c, i) => interviewOps.list(c, i),
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
      name: 'flows.show',
      summary: 'Show the workflow graph: stations, runs, edge traversals, dwell and moves.',
      method: 'GET',
      path: '/v1/flows',
      inputs: [
        f('factory', 'id', false, 'the factory name; default lifecycle'),
        f('since', 'id', false, 'a window (1h, 24h, 7d) or a time in ms; default 24h'),
      ],
    },
    'json',
    (c, i) => flowsOps.show(c, i),
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
      name: 'manager.context',
      summary:
        'Show the model and the context use (tokens and percent of the window) of the manager session.',
      method: 'GET',
      path: '/v1/manager/context',
    },
    'json',
    (c, i) => managerOps.context(c, i),
  ),
  local(
    {
      name: 'manager.show',
      summary: 'Show the last health report of the manager task.',
      method: 'GET',
      path: '/v1/manager',
    },
    'json',
    (c, i) => managerOps.show(c, i),
  ),
  local(
    {
      name: 'manager.brief',
      summary:
        'Show the first brief of a manager session: decisions, mail, plan and the last 20 patrol rows.',
      method: 'GET',
      path: '/v1/manager/brief',
    },
    'json',
    (c, i) => managerOps.brief(c, i),
  ),
  local(
    {
      name: 'manager.log',
      summary: 'Add one row to a log of the manager: patrol, pm, brief, review, usage or health.',
      method: 'POST',
      path: '/v1/manager/log/:kind',
      inputs: [
        f('kind', 'id', true, 'the log: patrol, pm, brief, review, usage or health'),
        f('entry', 'text', true, 'the row, one JSON object'),
      ],
    },
    'text',
    (c, i) => managerOps.log(c, i),
  ),
  local(
    {
      name: 'manager.image',
      summary:
        'Set the image of the manager task. The pod deletes the task and its workspace, then applies it.',
      method: 'POST',
      path: '/v1/manager/image',
      rights: 'owner',
      inputs: [f('image', 'text', true, 'the image reference')],
    },
    'text',
    (c, i) => managerOps.image(c, i),
  ),
  local(
    {
      name: 'manager.suspend',
      summary: 'Suspend the manager task, or resume it. The pod keeps ticking.',
      method: 'POST',
      path: '/v1/manager/suspend',
      rights: 'owner',
      inputs: [f('resume', 'flag', false, 'resume the task instead')],
    },
    'text',
    (c, i) => managerOps.suspend(c, i),
  ),
  local(
    {
      name: 'manager.say',
      summary: 'Type a text into the manager pane.',
      method: 'POST',
      path: '/v1/manager/say',
      rights: 'owner',
      inputs: [f('text', 'text', true, 'the text for the manager')],
    },
    'text',
    (c, i) => managerOps.say(c, i),
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
      rights: 'owner',
      inputs: [f('mode', 'enum', true, undefined, ['stop', 'resume'])],
    },
    i => [i.mode as string],
  ),
  bridge(
    {
      name: 'runs.poke',
      summary: 'Nudge the worker of a run.',
      method: 'POST',
      path: '/v1/runs/:id/poke',
      inputs: [id('id'), f('text', 'text', false, 'the nudge text; a standard nudge when not set')],
    },
    i => ['poke', i.id as string, ...(i.text ? [i.text as string] : [])],
  ),
  bridge(
    {
      name: 'runs.retry',
      summary: 'Retry a stuck station of a run.',
      method: 'POST',
      path: '/v1/runs/:id/retry',
      inputs: [id('id')],
    },
    i => ['retry', i.id as string],
  ),
  bridge(
    {
      name: 'runs.fork',
      summary: 'Start a new run from the branch and state of a run.',
      method: 'POST',
      path: '/v1/runs/:id/fork',
      inputs: [id('id'), id('station'), f('note', 'note', false, 'a note for the new run')],
    },
    i => ['fork', i.id as string, i.station as string, ...(i.note ? [i.note as string] : [])],
  ),
  bridge(
    {
      name: 'runs.remove',
      summary: 'Remove a finished run. The branch stays.',
      method: 'DELETE',
      path: '/v1/runs/:id',
      inputs: [id('id')],
    },
    i => ['rm', i.id as string],
  ),
  bridge(
    {
      name: 'backlog.queue',
      summary: 'Hand a bead to the factory.',
      method: 'POST',
      path: '/v1/queue',
      inputs: [id('rig'), id('bead'), f('station', 'id', false)],
    },
    i => ['queue', i.rig as string, i.bead as string, ...(i.station ? [i.station as string] : [])],
  ),
  bridge(
    {
      name: 'rigs.unhold',
      summary: 'Wake the stations that a usage limit of a runner holds.',
      method: 'POST',
      // ponytail: the CLI form takes a runner; the contract names the path param :rig. The value is the runner name.
      path: '/v1/rigs/:rig/unhold',
      inputs: [{ ...id('rig'), help: H.runner! }, f('codex', 'flag', false)],
    },
    i => ['unhold', i.rig as string, ...(i.codex ? ['--codex'] : [])],
  ),
  bridge(
    {
      name: 'rigs.adopt',
      summary: 'Copy a factory into the repo of a rig for the repo to own.',
      method: 'POST',
      path: '/v1/adopt',
      inputs: [id('rig'), f('template', 'id', false)],
    },
    i => ['adopt', i.rig as string, ...(i.template ? [i.template as string] : [])],
  ),
  bridge(
    {
      name: 'rigs.set',
      summary: 'Change the settings of a rig. The CLI checks each value.',
      method: 'PATCH',
      path: '/v1/rigs/:rig',
      inputs: [
        id('rig'),
        ...(
          [
            ['max', 'the most busy runs of the rig'],
            ['sweeps', 'the sweeps of the rig, a,b or none'],
            ['runner', 'the runner of the rig'],
            ['agent', 'the agent command'],
            ['clusterRuns', 'the most cluster runs'],
            ['autoQueue', 'the auto-queue rule, p,n or off'],
            ['skills', 'the skills, a,b or none'],
            ['otelContent', 'on or off'],
            ['sandboxClass', 'gvisor or microvm'],
            ['param', 'name=value; one for each line'],
            ['pushRule', 'a push rule, or none; one for each line'],
            ['sensitivePath', 'a sensitive path, or none; one for each line'],
            ['goal', 'the goal of the rig'],
          ] as const
        ).map(([n, help]) => f(n, 'text', false, help)),
      ],
    },
    i => {
      const flag = (k: string, v: unknown) => (typeof v === 'string' ? [`--${k}`, v] : [])
      const lines = (k: string, v: unknown) =>
        typeof v === 'string' ? v.split('\n').flatMap(x => [`--${k}`, x]) : []
      return [
        'rig',
        'set',
        i.rig as string,
        ...flag('max', i.max),
        ...flag('sweeps', i.sweeps),
        ...flag('runner', i.runner),
        ...flag('agent', i.agent),
        ...flag('cluster-runs', i.clusterRuns),
        ...flag('auto-queue', i.autoQueue),
        ...flag('skills', i.skills),
        ...flag('otel-content', i.otelContent),
        ...flag('sandbox-class', i.sandboxClass),
        ...lines('param', i.param),
        ...lines('push-rule', i.pushRule),
        ...lines('sensitive-path', i.sensitivePath),
        ...flag('goal', i.goal), // the goal is the rest of the line: it goes last
      ]
    },
  ),
  {
    // ponytail: the CLI sweep runs the pass for every rig and takes no name. Only "all" is allowed until it does.
    ...bridge(
      {
        name: 'sweeps.run',
        summary: 'Run the sweep pass for every rig. The name must be all.',
        method: 'POST',
        path: '/v1/sweeps/:name',
        inputs: [{ ...id('name'), help: 'the sweep name; only all' }],
      },
      () => ['sweep'],
    ),
    run: (ctx, i) =>
      i.name === 'all'
        ? ctx.cli(['sweep'])
        : Promise.reject(
            new OpError(422, 'the sweep name must be all: the pass runs the sweeps of every rig'),
          ),
  } as Op,
  bridge(
    {
      name: 'memory.search',
      summary: 'Search the memory notes.',
      method: 'GET',
      path: '/v1/memory/search',
      inputs: [
        f('query', 'text', true, 'the words to search for'),
        f('rig', 'id', false),
        f('from', 'text', false, 'the run and station that search, run/station'),
        f('noCore', 'flag', false, 'leave out CORE.md'),
      ],
    },
    i => [
      'memory',
      'search',
      ...(i.rig ? ['--rig', i.rig as string] : []),
      ...(i.from ? ['--from', i.from as string] : []),
      ...(i.noCore ? ['--no-core'] : []),
      i.query as string,
    ],
  ),
  bridge(
    {
      name: 'memory.add',
      summary: 'Add a note to the memory. The CLI checks the note.',
      method: 'POST',
      path: '/v1/memory',
      inputs: [
        // ponytail: the kinds repeat memory.NOTE_KINDS; the CLI gate is the check that counts
        f('kind', 'enum', true, 'the note kind', ['fact', 'rule', 'recipe']),
        f('summary', 'text', true, 'the one line summary'),
        f('body', 'note', false, 'the note body'),
        f('rig', 'id', false),
        f('from', 'text', false, 'the run and station that add, run/station'),
        f('until', 'text', false, 'a bead, owner/repo#N or YYYY-MM-DD'),
        f('supersedes', 'text', false, 'the path of the older note that this note replaces'),
        f('anyway', 'flag', false, 'add it even when a like note exists'),
      ],
    },
    i => [
      'memory',
      'add',
      '--kind',
      i.kind as string,
      ...(i.rig ? ['--rig', i.rig as string] : []),
      ...(i.from ? ['--from', i.from as string] : []),
      ...(i.until ? ['--until', i.until as string] : []),
      ...(i.supersedes ? ['--supersedes', i.supersedes as string] : []),
      ...(i.anyway ? ['--anyway'] : []),
      i.summary as string,
      ...(i.body ? [i.body as string] : []),
    ],
  ),
  bridge(
    {
      name: 'plan.facts',
      summary: 'Gather the plan facts for the pm step. The CLI saves them for plan.set.',
      method: 'GET',
      path: '/v1/plan/facts',
    },
    () => ['plan', 'facts'],
    'json',
  ),
  {
    // the pm answer is JSON text; the CLI parses it and checks it against the saved facts
    ...bridge(
      {
        name: 'plan.set',
        summary: 'Set the plan from the answer of the pm step.',
        method: 'PUT',
        path: '/v1/plan',
        inputs: [f('answer', 'text', true, 'the pm answer, JSON text')],
      },
      () => [],
    ),
    run: viaFile(
      p => ['plan', 'set', p],
      i => i.answer as string,
    ),
  } as Op,
  {
    ...bridge(
      {
        name: 'gates.setbrief',
        summary: 'Set the brief of a live gate visit of a run.',
        method: 'PUT',
        path: '/v1/gate-brief/:run',
        inputs: [
          id('run'),
          f('startedAt', 'id', true, 'the start time of the gate visit, from the facts'),
          f('text', 'text', true, 'the brief'),
        ],
      },
      () => [],
    ),
    run: (ctx, i) =>
      viaFile(
        p => ['gate-brief', 'set', `gate:${i.run}@${i.startedAt}`, p],
        j => j.text as string,
      )(ctx, i),
  } as Op,
  // ponytail: a review id holds ":". It cannot be a path segment, so it is a query or body field.
  bridge(
    {
      name: 'review.facts',
      summary: 'Show the facts of one pending skill or proposal for the reviewer.',
      method: 'GET',
      path: '/v1/review',
      inputs: [f('key', 'text', true, 'the review id from the pending list')],
    },
    i => ['review', 'facts', i.key as string],
    'json',
  ),
  {
    ...bridge(
      {
        name: 'review.set',
        summary: 'Set the recommendation of the reviewer for one pending item.',
        method: 'PUT',
        path: '/v1/review',
        inputs: [
          f('key', 'text', true, 'the review id from the pending list'),
          f('text', 'text', true, 'the reviewer answer'),
        ],
      },
      () => [],
    ),
    run: (ctx, i) =>
      viaFile(
        p => ['review', 'set', i.key as string, p],
        j => j.text as string,
      )(ctx, i),
  } as Op,
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
  local(
    {
      name: 'interview.answer',
      summary:
        'Answer an open question: decide a gate, answer a bead, start an owner-only bead, or mail a run.',
      method: 'POST',
      path: '/v1/interview/answer',
      rights: 'owner',
      inputs: [id('item'), f('choice', 'text'), f('text', 'note')],
    },
    'text',
    (c, i) => interviewOps.answer(c, i),
  ),
])
