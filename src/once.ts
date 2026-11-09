// The manager's subagent steps, run once and headless: `factory patrol|pm|brief|review --once`.
// The Claude Code mod runs the same steps as hidden subagents.
// A mod with no subagent API calls these commands instead.
// Each step builds its input, makes one model call (runModel) and files the answer.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRIEFER_LOG_CAP,
  PATROL_LOG_CAP,
  PATROL_LOG_RECENT,
  PATROL_MS,
  PM_LOG_CAP,
  REVIEWER_LOG_CAP,
  cutText,
  line,
  patrol,
} from '../mod/hooks/view'
import type {
  FactoryBriefLogEntry,
  FactoryMail,
  FactoryPatrolLogEntry,
  FactoryPmLogEntry,
  FactoryReviewItem,
  FactoryReviewLogEntry,
  FactoryReviewRow,
  FactoryRig,
  FactoryRun,
} from '../mod/types'
import { claudeCommand } from './harness'
import { PATROL_VERB } from './core/guards'
import { isValidPlanShape } from './plan'
import { stepPrompt } from './steps'

/** the mod's rt.unsent, rt.seen, rt.patrolAt, rt.sig and rt.sigAt, kept in `<home>/patrol-state.json` */
export type PatrolState = {
  unsent: FactoryMail[]
  seen: string[]
  patrolAt: number
  sig?: string
  sigAt?: number
}

/** the fields of `factory tick`'s output that the steps read; `--keep-mail` saves them in `<home>/manager-tick.json` */
export type TickOut = {
  busy?: boolean
  runs?: FactoryRun[]
  manager?: FactoryMail[]
  rigs?: FactoryRig[]
  reviews?: FactoryReviewItem[]
  reviewed?: FactoryReviewRow[]
  halt?: 'stopping' | 'paused'
}

/** what a step needs from the CLI: the facts functions live in src/cli.ts */
export type Io = {
  home: string
  cli: string
  factories: string
  /** the patrol's Claude settings: its Bash guard hook */
  settings: object
  planFacts: () => Promise<string>
  gateFacts: (run: string) => Promise<string>
  reviewFacts: (key: string) => string
}

export type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type ModelResult = {
  isOk: boolean
  text: string
  error?: string
  reason: string
  durationMs: number
  usage?: Usage
  /** every Bash command the model ran */
  commands: string[]
  /** the same Bash commands with their tool_use ids */
  calls: { id: string; command: string }[]
  /** the Claude session id of the run */
  session?: string
}

export type ModelCall = {
  system: string
  input: string
  model: string
  /** the Claude --tools value: '' allows no tool */
  tools: string
  maxTurns: number
  settings?: object
  env?: Record<string, string>
  /** a codex model name: run codex in its read-only sandbox, not Claude */
  codex?: string
  /** the longest the call runs */
  timeoutMs: number
  /** keep the session on disk, so a later call can resume it */
  persist?: boolean
  /** a session id to resume (persist mode only) */
  resume?: string
  /** the child's working directory */
  cwd?: string
  /** the env that the child starts from, in place of process.env */
  baseEnv?: Record<string, string | undefined>
}

/** the same check as FACTORY_DREAM_CODEX */
export const CODEX_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

const file = (home: string, name: string) => join(home, name)

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** atomic: a reader never sees half a file */
function saveJson(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2))
  renameSync(`${path}.tmp`, path)
}

const readState = (home: string): PatrolState => ({
  unsent: [],
  seen: [],
  patrolAt: 0,
  ...readJsonFile<Partial<PatrolState>>(file(home, 'patrol-state.json'), {}),
})

const readTick = (home: string): TickOut => readJsonFile<TickOut>(file(home, 'manager-tick.json'), {})

/** `factory tick --keep-mail`: saves the tick and adds its manager mail to the patrol's unsent mail */
export function keepTick(home: string, out: TickOut) {
  if (out.busy) return
  saveJson(file(home, 'manager-tick.json'), out)
  const state = readState(home)
  saveJson(file(home, 'patrol-state.json'), { ...state, unsent: [...state.unsent, ...(out.manager ?? [])] })
}

export function readLog<T>(home: string, name: string): T[] {
  if (!existsSync(file(home, name))) return []
  return readFileSync(file(home, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(l => {
      try {
        return [JSON.parse(l) as T]
      } catch {
        return [] // a half-written line: skip it
      }
    })
}

/** appends one entry and keeps only the newest `cap` lines */
function appendLog(home: string, name: string, cap: number, entry: unknown) {
  const log = [...readLog<unknown>(home, name), entry].slice(-cap)
  writeFileSync(file(home, name), `${log.map(e => JSON.stringify(e)).join('\n')}\n`)
}

/** one manager-usage.jsonl row, the same shape as the mod's appendManagerUsage. A failure never reaches the caller. */
export function appendUsage(
  home: string,
  name: 'patrol' | 'pm' | 'briefer' | 'reviewer' | 'chat',
  usage?: Usage,
) {
  try {
    if (!usage) return
    const row = {
      name,
      at: Date.now(),
      model: usage.model,
      input: usage.input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      output: usage.output_tokens,
    }
    appendFileSync(file(home, 'manager-usage.jsonl'), JSON.stringify(row) + '\n')
  } catch {}
}

const tokensOf = (u?: Usage) => (u ? u.input_tokens + u.output_tokens : undefined)

/** reads the stream-json lines of a headless Claude run */
export function parseStream(
  out: string,
  model: string,
): Omit<ModelResult, 'durationMs'> & { durationMs?: number } {
  const commands: string[] = []
  const calls: { id: string; command: string }[] = []
  let result: Record<string, any> | undefined
  let seenModel = model
  for (const l of out.split('\n')) {
    let e: Record<string, any>
    try {
      e = JSON.parse(l)
    } catch {
      continue
    }
    if (e.type === 'assistant') {
      seenModel = e.message?.model ?? seenModel
      for (const b of e.message?.content ?? [])
        if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') {
          commands.push(b.input.command)
          if (typeof b.id === 'string') calls.push({ id: b.id, command: b.input.command })
        }
    } else if (e.type === 'result') result = e
  }
  if (!result)
    return { isOk: false, text: '', error: 'the model gave no result', reason: 'no-result', commands, calls }
  const u = result.usage
  const usage = u && {
    model: seenModel,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
  const text = typeof result.result === 'string' ? result.result : ''
  return {
    isOk: !result.is_error,
    text,
    error: result.is_error ? line(text || String(result.subtype), 300) : undefined,
    reason: String(result.subtype ?? 'unknown'),
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : undefined,
    usage,
    commands,
    calls,
    session: typeof result.session_id === 'string' ? result.session_id : undefined,
  }
}

const ALLOWED_ENV = ['PATH', 'HOME', 'TERM', 'LANG']

type Spawn = { argv: string[]; env: Record<string, string | undefined>; stdin: string }

function modelSpawn(c: ModelCall): Spawn {
  const argv = c.codex
    ? [
        process.env.FACTORY_CODEX ?? 'codex',
        ...['exec', '-s', 'read-only', '-c', 'approval_policy="never"', '-m', c.codex, '-'],
      ]
    : [
        ...claudeCommand().split(/\s+/),
        ...['-p', '--output-format', 'stream-json', '--verbose'],
        ...(c.persist ? (c.resume ? ['--resume', c.resume] : []) : ['--no-session-persistence']),
        ...['--model', c.model, '--max-turns', String(c.maxTurns), '--tools', c.tools],
        // -p has nobody to ask: allow the step's tools, so a call is not refused. The guard hook still runs first.
        ...(c.tools ? ['--allowedTools', c.tools] : []),
        ...['--system-prompt', c.system, '--disable-slash-commands'],
        ...(c.settings ? ['--settings', JSON.stringify(c.settings)] : []),
      ]
  // codex has no system prompt flag: the step text leads its stdin
  const stdin = c.codex ? `${c.system}\n\n${c.input}` : c.input
  // codex can run printenv in its sandbox, so it gets an allowlist, not the whole env
  const env = c.codex
    ? Object.fromEntries(
        ALLOWED_ENV.flatMap(k => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])),
      )
    : { ...(c.baseEnv ?? process.env), ...c.env }
  return { argv, env, stdin }
}

/** turns the exit of a model child into a ModelResult */
function modelResult(
  c: ModelCall,
  out: string,
  err: string,
  exitCode: number | null,
  start: number,
): ModelResult {
  const durationMs = Date.now() - start
  if (c.codex) {
    const isOk = exitCode === 0
    return {
      isOk,
      text: out.trim(),
      error: isOk ? undefined : line(err || `codex exited ${exitCode}`, 300),
      reason: isOk ? 'completed' : 'failed',
      durationMs,
      commands: [],
      calls: [],
    }
  }
  const r = parseStream(out, c.model)
  if (r.reason === 'no-result')
    return {
      ...r,
      durationMs,
      error: line(err || out || `the model exited ${exitCode}`, 300),
      reason: 'spawn-failed',
    }
  return { ...r, durationMs: r.durationMs ?? durationMs }
}

const spawnFailed = (error: string, start: number): ModelResult => ({
  isOk: false,
  text: '',
  error,
  reason: 'spawn-failed',
  durationMs: Date.now() - start,
  commands: [],
  calls: [],
})

/** The one model call. Tests point FACTORY_CLAUDE (or FACTORY_CODEX) at a stub. */
export function runModel(c: ModelCall): ModelResult {
  const start = Date.now()
  const { argv, env, stdin } = modelSpawn(c)
  let p: Bun.SyncSubprocess<'pipe', 'pipe'>
  try {
    p = Bun.spawnSync(argv, { env, cwd: c.cwd, stdin: Buffer.from(stdin), timeout: c.timeoutMs })
  } catch (err) {
    return spawnFailed(line(String(err), 300), start)
  }
  return modelResult(c, p.stdout.toString(), p.stderr.toString(), p.exitCode, start)
}

/**
 * The same call as runModel, without blocking the process. The child leads its own process group,
 * and the timeout kills the group, so a grandchild cannot keep a pipe open.
 */
export async function runModelAsync(c: ModelCall): Promise<ModelResult> {
  const start = Date.now()
  const { argv, env, stdin } = modelSpawn(c)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const proc = Bun.spawn(argv, {
      env,
      cwd: c.cwd,
      stdin: Buffer.from(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
    timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch {}
    }, c.timeoutMs)
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return modelResult(c, out, err, proc.exitCode, start)
  } catch (err) {
    return spawnFailed(line(String(err), 300), start)
  } finally {
    clearTimeout(timer)
  }
}

const mailId = (m: FactoryMail) => `${m.run}\0${m.from}\0${m.at}\0${m.text}`

/** `factory patrol --once`. Gives the report text, or `nothing due`. */
export function patrolOnce(io: Io): string {
  const tick = readTick(io.home)
  const state = readState(io.home)
  const now = Date.now()
  // a halted factory shows no runs: only mail wakes the patrol (as in the mod)
  if (tick.halt && !state.unsent.length) return 'nothing due'
  const plan = readJsonFile<unknown>(file(io.home, 'plan.json'), undefined)
  const log = readLog<FactoryPatrolLogEntry>(io.home, 'patrol-log.jsonl')
    .slice(-PATROL_LOG_RECENT)
    .flatMap(e => e.actions)
  const last = now - (state.sigAt ?? 0) < 3_600_000 ? state.sig : undefined
  const due = patrol(
    tick.halt ? [] : (tick.runs ?? []),
    state.unsent,
    new Set(state.seen),
    now - state.patrolAt >= PATROL_MS,
    tick.halt ? [] : (tick.rigs ?? []),
    last,
    new Set(),
    log,
    isValidPlanShape(plan) ? plan : undefined,
    now,
    [...(tick.reviewed ?? []), ...(tick.reviews ?? [])],
  )
  if (!due) return 'nothing due'
  const guard = { type: 'command', command: `'${io.cli}' patrol-guard` }
  const res = runModel({
    system: stepPrompt('patrol', { cli: io.cli, factories: io.factories }),
    input: due.text,
    model: 'claude-sonnet-5-5',
    tools: 'Bash,Read,Grep,Glob,Write',
    maxTurns: 40,
    settings: { ...io.settings, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [guard] }] } },
    env: { FACTORY_PATROL: '1', FACTORY_HOME: io.home },
    timeoutMs: 15 * 60_000,
  })
  // the mod commits after a confirmed spawn: a model that never started keeps its mail for the next patrol
  if (res.reason !== 'spawn-failed') {
    const sent = new Set(state.unsent.map(mailId))
    const fresh = readState(io.home) // mail that a tick added meanwhile
    saveJson(file(io.home, 'patrol-state.json'), {
      ...fresh,
      unsent: [...due.kept, ...fresh.unsent.filter(m => !sent.has(mailId(m)))],
      seen: [...new Set([...fresh.seen, ...due.keys])],
      patrolAt: now,
      ...(due.sig !== last ? { sig: due.sig, sigAt: now } : {}),
    })
  }
  const report = res.text.length > 600 ? `${cutText(res.text, 599)}…` : res.text
  const entry: FactoryPatrolLogEntry = {
    at: now,
    reason: res.reason,
    durationMs: res.durationMs,
    tokens: tokensOf(res.usage),
    actions: res.commands
      .filter(c => PATROL_VERB.test(c.replace(/\\\n/g, '')))
      .map(c => line(c, 200))
      .slice(-50),
    report,
    ...(res.error ? { error: res.error } : {}),
  }
  appendLog(io.home, 'patrol-log.jsonl', PATROL_LOG_CAP, entry)
  appendUsage(io.home, 'patrol', res.usage)
  return res.error ? `the patrol failed: ${res.error}` : report
}

/** runs a factory command in this home, like the mod's factory() */
const factory = (io: Io, args: string[]) => {
  const p = Bun.spawnSync([io.cli, ...args], {
    env: { ...process.env, FACTORY_HOME: io.home },
    timeout: 600_000,
  })
  return { isOk: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() }
}

/** a step that needs no tool: the model reads the facts and answers in text */
function noToolCall(
  io: Io,
  step: 'pm' | 'briefer' | 'reviewer',
  model: string,
  maxTurns: number,
  facts: string,
  codex?: string,
) {
  return runModel({
    system: stepPrompt(step, step === 'pm' ? { cli: io.cli } : {}),
    input: facts,
    model,
    tools: '',
    maxTurns,
    codex,
    timeoutMs: step === 'pm' ? 15 * 60_000 : 10 * 60_000,
  })
}

/** `factory pm --once`: ranks each rig's next work, then applies the answer with `factory plan set` */
export async function pmOnce(io: Io, codex?: string): Promise<string> {
  const at = Date.now()
  let facts: string
  try {
    facts = await io.planFacts()
  } catch (err) {
    appendLog(io.home, 'pm-log.jsonl', PM_LOG_CAP, {
      at,
      reason: 'facts-failed',
      durationMs: 0,
      error: line((err as Error).message, 300),
    } satisfies FactoryPmLogEntry)
    return `plan facts failed: ${(err as Error).message}`
  }
  const res = noToolCall(io, 'pm', 'claude-sonnet-5-5', 15, facts, codex)
  appendUsage(io.home, 'pm', res.usage)
  const base = { at, reason: res.reason, durationMs: res.durationMs, tokens: tokensOf(res.usage) }
  const fence = [...res.text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1]?.trim()
  let entry: FactoryPmLogEntry
  if (res.error) entry = { ...base, error: res.error }
  else if (!fence) entry = { ...base, error: "the pm's answer had no fenced json block" }
  else {
    const answer = file(io.home, 'plan-answer.json')
    writeFileSync(answer, fence)
    const set = factory(io, ['plan', 'set', answer])
    if (!set.isOk) entry = { ...base, error: line(set.out, 300) }
    else {
      try {
        const s = JSON.parse(set.out) as { items: number; findings: number; filed: number }
        entry = { ...base, items: s.items, findings: s.findings, filed: s.filed }
      } catch (err) {
        entry = { ...base, error: line(String(err), 300) }
      }
    }
  }
  appendLog(io.home, 'pm-log.jsonl', PM_LOG_CAP, entry)
  return entry.error
    ? `the pm failed: ${entry.error}`
    : `plan set: ${entry.items} items, ${entry.findings} findings, ${entry.filed} filed`
}

/** the run to brief: the oldest at a gate with no brief and no attempt in the log */
export function briefCandidate(tick: TickOut, tried: ReadonlySet<string>) {
  return (tick.runs ?? [])
    .filter(r => r.gate && !r.gate.brief)
    .map(r => ({ r, key: `gate:${r.id}@${r.since ?? 0}` }))
    .filter(({ key }) => !tried.has(key))
    .sort((a, b) => (a.r.since ?? 0) - (b.r.since ?? 0))[0]
}

/** what a brief or review step does after its model call: file the answer, log the attempt */
type Filed = { key: string; facts: () => Promise<string> | string; answerFile: string; set: string[] }

async function filedStep(
  io: Io,
  c: { name: 'briefer' | 'reviewer'; log: string; cap: number; model: string; maxTurns: number },
  f: Filed,
  codex?: string,
): Promise<string> {
  const at = Date.now()
  const note = (e: FactoryBriefLogEntry | FactoryReviewLogEntry) => appendLog(io.home, c.log, c.cap, e)
  let facts: string
  try {
    facts = await f.facts()
  } catch (err) {
    note({ at, key: f.key, durationMs: 0, error: line((err as Error).message, 300) })
    return `${c.name} facts failed: ${(err as Error).message}`
  }
  const res = noToolCall(io, c.name, c.model, c.maxTurns, facts, codex)
  appendUsage(io.home, c.name, res.usage)
  const base = { at, key: f.key, reason: res.reason, durationMs: res.durationMs, tokens: tokensOf(res.usage) }
  let entry: FactoryBriefLogEntry | FactoryReviewLogEntry
  if (res.error) entry = { ...base, error: res.error }
  else if (!res.text.trim()) entry = { ...base, error: `the ${c.name}'s answer was empty` }
  else {
    writeFileSync(f.answerFile, res.text)
    const set = factory(io, [...f.set, f.key, f.answerFile])
    entry = set.isOk ? base : { ...base, error: line(set.out, 300) }
  }
  note(entry)
  return entry.error ? `the ${c.name} failed: ${entry.error}` : `${c.name} done for ${f.key}`
}

/** `factory brief --once`: writes the brief of one gate */
export async function briefOnce(io: Io, codex?: string): Promise<string> {
  const tried = new Set(readLog<FactoryBriefLogEntry>(io.home, 'brief-log.jsonl').map(e => e.key))
  const next = briefCandidate(readTick(io.home), tried)
  if (!next) return 'nothing due'
  return filedStep(
    io,
    { name: 'briefer', log: 'brief-log.jsonl', cap: BRIEFER_LOG_CAP, model: 'claude-haiku-5-5', maxTurns: 3 },
    {
      key: next.key,
      facts: () => io.gateFacts(next.r.id),
      answerFile: file(io.home, 'gate-brief-answer.txt'),
      set: ['gate-brief', 'set'],
    },
    codex,
  )
}

/** `factory review --once`: recommends install or reject for one pending skill or proposal */
export async function reviewOnce(io: Io, codex?: string): Promise<string> {
  const tried = new Set(readLog<FactoryReviewLogEntry>(io.home, 'review-log.jsonl').map(e => e.key))
  const item = (readTick(io.home).reviews ?? []).find(i => !tried.has(i.key))
  if (!item) return 'nothing due'
  return filedStep(
    io,
    {
      name: 'reviewer',
      log: 'review-log.jsonl',
      cap: REVIEWER_LOG_CAP,
      model: 'claude-sonnet-5-5',
      maxTurns: 3,
    },
    {
      key: item.key,
      facts: () => io.reviewFacts(item.key),
      answerFile: file(io.home, 'review-answer.txt'),
      set: ['review', 'set'],
    },
    codex,
  )
}
