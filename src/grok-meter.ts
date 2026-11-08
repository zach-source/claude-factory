// Grok is billed per token on the xAI API, with no pool to read. Each worker report carries the cost of its turns (metrics.ts
// grokUsageOf); appendUsage logs it in <home>/grok-spend.jsonl, and the sum of the last 7 days is the week's spend. An optional
// weekly budget (setting grok.weeklyBudgetUsd) keeps grok launches under it. Without a budget there is no gate.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tokensOf, type Usage } from './metrics'

export const WEEK_MS = 7 * 86_400_000
type Spend = { at: number; run: string; node: string; costMicro: number; tokens: number }

const file = (home: string) => join(home, 'grok-spend.jsonl')

/** one line for each usage row that has a cost */
export function logGrokSpend(home: string, run: string, rows: Usage[], at = Date.now()) {
  const lines = rows
    .filter(r => r.costMicro)
    .map(r =>
      JSON.stringify({ at, run, node: r.node, costMicro: r.costMicro!, tokens: tokensOf(r) } satisfies Spend),
    )
  if (lines.length) appendFileSync(file(home), lines.join('\n') + '\n')
}

/** the dollars spent in the 7 days before `now`; a missing file or a bad line counts for nothing */
export function grokSpent(home: string, now = Date.now()) {
  let text = ''
  try {
    text = readFileSync(file(home), 'utf8')
  } catch {} // no spend yet
  let micro = 0
  for (const l of text.split('\n')) {
    try {
      const s = JSON.parse(l) as Spend
      if (now - s.at < WEEK_MS && s.costMicro > 0) micro += s.costMicro
    } catch {} // an empty or cut line
  }
  return micro / 1e6
}

/** the weekly budget in dollars from FACTORY_GROK_WEEKLY_BUDGET_USD (setting grok.weeklyBudgetUsd); undefined (no gate) when unset or bad */
export function grokBudget(env: Record<string, string | undefined> = process.env) {
  const v = env.FACTORY_GROK_WEEKLY_BUDGET_USD?.trim()
  return v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined
}

/** may a launch use grok? Yes with no budget, else only while the week's spend is under it. `why` is the one line the log shows. */
export const grokVerdict = (spent: number, budget: number | undefined) => ({
  use: budget === undefined || spent < budget,
  why: `the Grok spend of the last 7 days is $${spent.toFixed(2)} (budget $${budget})`,
})

/** the line `factory status` prints */
export const grokLine = (spent: number, budget?: number) =>
  `Grok: $${spent.toFixed(2)} this week` + (budget === undefined ? '' : ` (budget $${budget})`)
