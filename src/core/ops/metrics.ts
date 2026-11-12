import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { cursorCap, cursorLine, cursorMeter } from '../../cursor-meter'
import { grokBudget, grokLine, grokSpent } from '../../grok-meter'
import {
  denialStats,
  fate,
  inWindow,
  launchStats,
  metrics,
  parseDenialLines,
  parseLaunchLines,
  parsePrecheckLines,
  parseStartLines,
  precheckStats,
  render,
  renderDenials,
  renderLaunches,
  renderStarts,
  renderTokens,
  startStats,
  tokensReport,
} from '../../metrics'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

/** `factory metrics [--rig r] [--since <days>d] [--json] [--tokens]` */
export async function show(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    const { home, env, port } = ctx
    const rig = i.rig as string | undefined
    const since = i.since as string | undefined
    const days = since === undefined ? Infinity : Number(since.replace(/d$/, ''))
    if (!(days > 0)) throw new Error('usage: factory metrics [--rig r] [--since <days>d] [--json] [--tokens]')
    const picked = await port.refreshMerges((await port.records()).filter(r => inWindow(r, rig, days)))
    const groups = rig ? [rig] : [...new Set(picked.map(r => r.rig ?? '(no rig)'))]
    const of = (g: string) => metrics(picked.filter(r => (r.rig ?? '(no rig)') === g))
    // claude-factory-6as.4: HOME/precheck.jsonl is dispatch's own trail of pre-check hits and
    // fail-opens (logPrecheck), independent of bd; this command is the only reader.
    const since_ = since ? Date.now() - days * 86_400_000 : 0
    const precheckFile = join(home, 'precheck.jsonl')
    const precheckAll = existsSync(precheckFile)
      ? parsePrecheckLines(readFileSync(precheckFile, 'utf8')).filter(l => l.at >= since_)
      : []
    const launchFile = join(home, 'launches.jsonl')
    const launchesAll = existsSync(launchFile) ? parseLaunchLines(readFileSync(launchFile, 'utf8')) : []
    const launches = launchesAll.filter(l => l.at >= since_ && (!rig || l.rig === rig))
    // claude-factory-ad6r: HOME/starts.jsonl, one line a first brief turn; the launch join uses every launch line
    const startFile = join(home, 'starts.jsonl')
    const startsAll = existsSync(startFile) ? parseStartLines(readFileSync(startFile, 'utf8')) : []
    const startLines = startsAll.filter(l => l.at >= since_ && (!rig || l.rig === rig))
    const starts = startStats(launchesAll, startLines)
    // claude-factory-dsfg: runs/*/denials.jsonl, one file a run. --rig maps a run to its rig through
    // every launch line (not the --since window: a denial can be newer than its run's first launch)
    const rigOfRun = new Map(launchesAll.map(l => [l.run, l.rig]))
    const denials = denialStats(
      (existsSync(join(home, 'runs'))
        ? readdirSync(join(home, 'runs'), { withFileTypes: true })
        : []
      ).flatMap(d => {
        const f = join(home, 'runs', d.name, 'denials.jsonl')
        if (!d.isDirectory() || !existsSync(f) || (rig && rigOfRun.get(d.name) !== rig)) return []
        return parseDenialLines(readFileSync(f, 'utf8')).filter(l => l.at >= since_)
      }),
    )
    const precheckOf = (g: string) => precheckStats(precheckAll.filter(l => l.rig === g))
    // --tokens reads what runs stored (record().sessions) and manager-usage.jsonl, never a live transcript
    const tokenArgs = i.tokens
      ? ([
          picked.flatMap(r => (r.sessions ?? []).map(u => ({ ...u, run: r.id }))),
          new Set(picked.filter(r => fate(r) === 'shipped').map(r => r.id)),
          await port.managerUsage(since_),
        ] as const)
      : null
    // the weekly Cursor pool as a gauge: the last reading and the cap, or null when the meter is unknown
    const cursor = cursorMeter(home)
    if (i.json)
      print(
        JSON.stringify({
          cursor: cursor && { ...cursor, cap: cursorCap(env) },
          grok: { spentUsd: grokSpent(home), budgetUsd: grokBudget(env) ?? null },
          all: metrics(picked),
          ...(tokenArgs && { tokens: tokensReport(...tokenArgs) }),
          precheck: precheckStats(rig ? precheckAll.filter(l => l.rig === rig) : precheckAll),
          launches,
          ...(startsAll.length && { starts }),
          denials,
          rigs: Object.fromEntries(groups.map(g => [g, { ...of(g), precheck: precheckOf(g) }])),
        }),
      )
    else {
      print(
        render(
          metrics(picked),
          `${basename(home)}${since ? `, last ${days}d` : ''}`,
          precheckStats(rig ? precheckAll.filter(l => l.rig === rig) : precheckAll),
        ),
      )
      if (groups.length > 1) for (const g of groups) print('\n' + render(of(g), g, precheckOf(g)))
      if (launches.length) print('\nlaunches by harness and model:\n' + renderLaunches(launchStats(launches)))
      if (startLines.length) print('\nstarts by rig (first starts, median s):\n' + renderStarts(starts))
      if (Object.keys(denials).length) print('\ndenials by harness and reason:\n' + renderDenials(denials))
      if (cursor || env.CURSOR_API_KEY) print('\n' + cursorLine(cursor, cursorCap(env)))
      if (grokSpent(home) > 0 || grokBudget(env) !== undefined)
        print('\n' + grokLine(grokSpent(home), grokBudget(env)))
    }
    if (tokenArgs && !i.json) print('\n' + renderTokens(...tokenArgs))
  })
}
