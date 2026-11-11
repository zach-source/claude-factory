import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { clearCodexAuth, isCodexAuthError, recordCodexAuth } from './codex-auth'
import { join } from 'node:path'
import type { ModelCall, ModelResult } from './once'

/** the manager step prompts: one file each in src/steps/. The mod reads the same files (FR-019). */
export const STEPS = ['patrol', 'pm', 'briefer', 'reviewer', 'dream', 'chat'] as const
export type StepName = (typeof STEPS)[number]

/**
 * Replaces each `{{name}}` in `text` with its value from `vars`, in one pass.
 * A value is not scanned again. The function throws for a placeholder with no value.
 * It also throws for a var that the text does not use.
 * mod/hooks/view.ts holds a copy, because the mod and the CLI ship apart. steps.test.ts keeps both equal.
 */
export function fillStep(text: string, vars: Record<string, string>): string {
  const used = new Set<string>()
  const out = text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!Object.hasOwn(vars, k)) throw new Error(`step prompt has no value for {{${k}}}`)
    used.add(k)
    return vars[k]!
  })
  const extra = Object.keys(vars).filter(k => !used.has(k))
  if (extra.length) throw new Error(`step prompt does not use ${extra.map(k => `{{${k}}}`).join(', ')}`)
  return out
}

/** the text of src/steps/<name>.md without its one final newline, with `vars` filled in */
export function stepPrompt(name: StepName, vars: Record<string, string> = {}): string {
  const text = readFileSync(join(import.meta.dir, 'steps', `${name}.md`), 'utf8')
  return fillStep(text.replace(/\n$/, ''), vars)
}

export type StepKey = 'patrol' | 'pm' | 'briefer' | 'reviewer'
export type StepSpec = { tools: string; model: string; maxTurns: number; timeoutMs: number }

/** the fixed tool set, model, turn count and time limit of each step. No step has a tool that can decide a gate. */
export const STEP_SPECS: Record<StepKey, StepSpec> = {
  patrol: {
    tools: 'Bash,Read,Grep,Glob,Write',
    model: 'claude-sonnet-5-5',
    maxTurns: 40,
    timeoutMs: 900_000,
  },
  pm: { tools: '', model: 'claude-sonnet-5-5', maxTurns: 15, timeoutMs: 900_000 },
  briefer: { tools: '', model: 'claude-haiku-5-5', maxTurns: 3, timeoutMs: 600_000 },
  reviewer: { tools: '', model: 'claude-sonnet-5-5', maxTurns: 3, timeoutMs: 600_000 },
}

/** the newest rows that agent-steps.jsonl keeps */
export const AGENT_STEPS_CAP = 2000
/** the vault takes up to 5 min to pick up a new slot: swap at most once in this time */
export const STEP_SWAP_GAP_MS = 5 * 60_000

export type AgentStepRow = {
  step: StepKey
  started_at: number
  ended_at: number
  outcome: 'ok' | 'timeout' | 'limit' | 'error'
  token_slot: string
  summary: string
}

const LIMIT_TEXT =
  /hit your .*limit|usage limit|rate limit|limit reached|weekly limit|session limit|5-hour|five.hour|authentication_failed/i

/** true when a failed step ended on a usage limit or a revoked token */
export function stepLimit(r: ModelResult): boolean {
  if (r.isOk) return false
  return r.apiErrorStatus === 401 || r.apiErrorStatus === 429 || LIMIT_TEXT.test(r.text)
}

const swapFile = (home: string) => join(home, 'token-swap-steps.json')

function swapState(home: string): { ran: number; slot?: string } | undefined {
  try {
    const s = JSON.parse(readFileSync(swapFile(home), 'utf8'))
    if (!Number.isFinite(s?.ran)) return undefined
    return { ran: s.ran, slot: typeof s.slot === 'string' ? s.slot : undefined }
  } catch {
    return undefined
  }
}

function saveSwap(home: string, ran: number, slot?: string) {
  const tmp = `${swapFile(home)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ ran, slot }))
  renameSync(tmp, swapFile(home))
}

/**
 * Asks the broker to make the best token slot live. At most one request in STEP_SWAP_GAP_MS.
 * Gives the summary tail. It never gives the body of the answer: a broken broker could put a token in it.
 */
export async function swapSlot(
  home: string,
  now: number,
  broker: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (!broker) return '; no swap: no broker'
  const state = swapState(home)
  if (state && now < state.ran + STEP_SWAP_GAP_MS)
    return `; no swap: one ran ${Math.round((now - state.ran) / 1000)} s ago`
  try {
    const res = await fetchFn(`${broker.replace(/\/+$/, '')}/token/best`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    })
    const slot = res.ok ? /^slot (\d{1,3}) is live/.exec(await res.text())?.[1] : undefined
    saveSwap(home, now, slot ?? state?.slot)
    return slot ? `; swapped to slot ${slot}` : `; swap failed: ${res.status}`
  } catch {
    saveSwap(home, now, state?.slot)
    return '; swap failed: unreachable'
  }
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

export const stepSecretEnv = (k: string): boolean =>
  /TOKEN|SECRET|PASSW|CREDENTIAL|API_KEY|AUTH/i.test(k) || k.startsWith('FACTORY_SERVER_BACKUP_')

// ponytail: gh and model login need these keys. Use a separate container to isolate them from tools.
export const STEP_KEEP_ENV: ReadonlySet<string> = new Set([
  'GH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
])

function logRow(home: string, row: AgentStepRow) {
  const path = join(home, 'agent-steps.jsonl')
  try {
    appendFileSync(path, JSON.stringify(row) + '\n')
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    if (rows.length > 2 * AGENT_STEPS_CAP) {
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, rows.slice(-AGENT_STEPS_CAP).join('\n') + '\n')
      renameSync(tmp, path)
    }
  } catch {}
}

/**
 * The one way a judgment step calls the model. It fixes the tool set and limits (STEP_SPECS),
 * keeps FACTORY_SERVER away from the child, sets FACTORY_PATROL so the step cannot decide a gate,
 * and moves HOME when FACTORY_STEP_ISOLATE=1 (the server), so the child cannot read the person certificate.
 * It stops a step over its limit, swaps the token slot on a usage limit (server only)
 * and appends one row to <home>/agent-steps.jsonl.
 */
export async function runStep(
  home: string,
  name: StepKey,
  call: Omit<ModelCall, 'tools' | 'model' | 'maxTurns' | 'timeoutMs'>,
  model: (c: ModelCall) => Promise<ModelResult>,
  deps: { fetch?: typeof fetch; specs?: Record<StepKey, StepSpec> } = {},
): Promise<ModelResult> {
  const spec = (deps.specs ?? STEP_SPECS)[name]
  const started = Date.now()
  const slot = swapState(home)?.slot ?? 'live'
  const base: Record<string, string | undefined> = { ...(call.baseEnv ?? process.env) }
  const isolate = base.FACTORY_STEP_ISOLATE === '1'
  const broker = base.FACTORY_POLICY_BROKER
  delete base.FACTORY_SERVER
  delete base.FACTORY_STEP_ISOLATE
  let cwd = call.cwd
  if (isolate) {
    for (const k of Object.keys(base)) if (stepSecretEnv(k) && !STEP_KEEP_ENV.has(k)) delete base[k]
    const dir = join(home, 'steps', name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    cwd ??= dir
    for (const rc of ['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zshenv'])
      rmSync(join(dir, rc), { force: true })
    if (!call.codex) {
      mkdirSync(join(dir, '.claude'), { recursive: true, mode: 0o700 })
      base.HOME = dir
      base.CLAUDE_CONFIG_DIR = join(dir, '.claude')
    }
  }
  const env: Record<string, string> = { ...call.env, FACTORY_PATROL: '1' }
  delete env.FACTORY_STEP_ISOLATE
  let r = await model({ ...call, ...spec, cwd, strictMcp: true, baseEnv: base, env })
  let outcome: AgentStepRow['outcome'] = r.isOk ? 'ok' : 'error'
  let tail = ''
  if (r.timedOut) {
    outcome = 'timeout'
    r = { ...r, isOk: false, reason: 'timeout', error: `the step ran over its limit of ${spec.timeoutMs} ms` }
  } else if (!call.codex && stepLimit(r)) {
    outcome = 'limit'
    tail = isolate ? await swapSlot(home, Date.now(), broker, deps.fetch) : '; no swap: not the server'
  }
  // claude-factory-y3f8w.10: a codex step shows a refused key, and works again once one succeeds
  if (call.codex) {
    if (r.isOk) clearCodexAuth(home)
    else if (isCodexAuthError(r.error)) recordCodexAuth(home, Date.now(), r.error!)
  }
  const first = (r.error ?? r.text).split('\n')[0] ?? ''
  logRow(home, {
    step: name,
    started_at: started,
    ended_at: Date.now(),
    outcome,
    // ponytail: the slot is the last known swap state, a best guess; soak must not trust it
    token_slot: call.codex ? 'codex' : slot,
    summary: cut(cut(first, 240) + tail, 300),
  })
  return r
}
