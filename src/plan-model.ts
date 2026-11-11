import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** one Jev (System One) choice call picks the plan station's model: complex work gets Opus, simple work Sonnet */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const MIN_CONFIDENCE = 0.6
const TIMEOUT_MS = 5_000
const OPUS = 'claude-opus-5-5[1m]'
const SONNET = 'claude-sonnet-5-5[1m]'

export type PlanPick = { model: string; choice?: string; confidence?: number; why?: string }

const question = {
  complexity: {
    type: 'choice',
    instructions:
      'Judge how hard it is to plan this software task: work out the design and split it into steps.',
    criteria: {
      complex:
        'The task changes several files or modules, touches a core or shared path, needs a design decision, or is unclear.',
      simple: 'The task is small and clear: one narrow change, a doc or config edit, or a mechanical fix.',
    },
  },
}

/** Any error, a 5 s timeout, a missing key or confidence under 0.6 picks Opus (the default plan_model). */
export async function pickPlanModel(
  state: string,
  key = process.env.TYPESAFE_API_KEY,
  fetcher: typeof fetch = fetch,
): Promise<PlanPick> {
  if (!key) return { model: OPUS, why: 'no key' }
  try {
    const res = await fetcher(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions: question }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { model: OPUS, why: `http ${res.status}` }
    const a = ((await res.json()) as any)?.answers?.complexity
    const { choice, confidence } = a ?? {}
    if (typeof confidence !== 'number' || confidence < MIN_CONFIDENCE)
      return { model: OPUS, choice, confidence, why: 'low confidence' }
    if (choice === 'simple') return { model: SONNET, choice, confidence }
    return { model: OPUS, choice, confidence, ...(choice === 'complex' ? {} : { why: 'unknown choice' }) }
  } catch (e) {
    return { model: OPUS, why: (e as Error).name === 'TimeoutError' ? 'timeout' : 'error' }
  }
}

const fileOf = (runDir: string) => join(runDir, 'plan-pick.json')

/** the saved pick of a run, or null before plan picked */
export const savedPlanPick = (runDir: string): PlanPick | null => {
  try {
    return existsSync(fileOf(runDir)) ? JSON.parse(readFileSync(fileOf(runDir), 'utf8')) : null
  } catch {
    return null
  }
}

/** pick once per run and keep the answer, so a later tick or a resume keeps the same model */
export async function ensurePlanPick(runDir: string, state: string, fetcher?: typeof fetch) {
  if (savedPlanPick(runDir)) return
  const pick = await pickPlanModel(state, process.env.TYPESAFE_API_KEY, fetcher)
  writeFileSync(fileOf(runDir), JSON.stringify(pick))
}
