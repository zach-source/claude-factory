// The Interview: the open questions for the person, and their answers. One list for every front end
// (claude-factory-hpmc.35). The list code is the one module in mod/hooks/view.ts, so the mod and the core agree.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { interviewAnswer, openInterviews, type Interview } from '../../../mod/hooks/view'
import { refuseWorker } from '../caller'
import { boardView, inProc, type Ctx, type Input, type RunResult } from '../catalog'

const FILE = 'interviewed.json'
const KEEP = 100

type Answered = Record<string, string>

/** the answered items of a home (item id -> answer). A missing or bad file is an empty record. */
function readAnswered(home: string): Answered {
  try {
    return JSON.parse(readFileSync(join(home, FILE), 'utf8')) as Answered
  } catch {
    return {}
  }
}

/** keep the newest KEEP answers */
function saveAnswered(home: string, a: Answered) {
  const tmp = join(home, `${FILE}.tmp`)
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(Object.entries(a).slice(-KEEP))))
  renameSync(tmp, join(home, FILE))
}

function items(ctx: Ctx): Interview[] {
  const board = boardView(ctx.board()) as { runs?: never[] } | null
  const dec = ctx.port.decisionsList() as { rigs?: never[]; proposals?: Record<string, never> }
  return openInterviews(board?.runs ?? [], dec.rigs ?? [], dec.proposals ?? {}, readAnswered(ctx.home))
}

/** `factory interview [list]` */
export async function list(ctx: Ctx, _i: Input): Promise<RunResult> {
  return inProc(print => print(JSON.stringify(items(ctx))))
}

/**
 * `factory interview answer <item> [choice] [text]`. The answer goes down the path of the item and of each
 * item that `mergeSame` folded into it: a gate is decided; a bead gets a comment; 'start now' on an
 * owner-only bead also starts it; a parked or stuck run gets mail. A step that fails stops the round. Each
 * member that went through is already recorded, so it does not ask again.
 */
export async function answer(ctx: Ctx, i: Input): Promise<RunResult> {
  return inProc(async print => {
    refuseWorker(ctx.env, 'interview answer')
    if (ctx.env.FACTORY_PATROL) throw new Error("a patrol cannot answer the person's questions: leave it")
    const iv = items(ctx).find(m => m.key === i.item)
    if (!iv) throw new Error(`no open question named ${i.item}`)
    const choice = typeof i.choice === 'string' ? i.choice : undefined
    const note = typeof i.text === 'string' ? i.text : ''
    const given = [choice, note.trim()].filter(Boolean).join(': ')
    const done: Answered = {}
    try {
      for (const m of [iv, ...(iv.also ?? [])]) await step(ctx, m, choice, note, print, given, done)
    } finally {
      if (Object.keys(done).length) saveAnswered(ctx.home, { ...readAnswered(ctx.home), ...done })
    }
  })
}

async function step(
  ctx: Ctx,
  m: Interview,
  choice: string | undefined,
  note: string,
  print: (l: string) => void,
  given: string,
  done: Answered,
) {
  const run = async (argv: string[]) => {
    const r = await ctx.cli(argv)
    if (r.code !== 0) throw new Error(r.err.trim() || `${argv[0]} exited ${r.code}`)
  }
  if (m.kind === 'prompt') throw new Error(`${m.key} waits at the worker pane: open the pane to answer it`)
  if (m.kind === 'gate') {
    if (!choice) throw new Error('pick an option to decide a gate')
    await ctx.port.decide(m.run, choice, note, print)
    done[m.key] = given
    return
  }
  const text = interviewAnswer(m, choice, note)
  if (!text) throw new Error('pick an option or type an answer')
  if (m.kind === 'bead' || m.kind === 'owned') {
    ctx.port.decisionsAnswer(m.rig!, m.bead!, text, print)
    if (m.kind === 'owned' && choice === 'start now') {
      const dec = ctx.port.decisionsList() as { rigs?: { rig: string; factory?: string }[] }
      const factory = dec.rigs?.find(r => r.rig === m.rig)?.factory ?? 'lifecycle'
      await run(['start', factory, m.rig!, m.bead!, '--owned'])
    }
  } else {
    await run(['mail', m.run!, m.node!, '--wake', text])
    if (m.kind === 'stuck') await run([choice === 'abort' ? 'abort' : 'retry', m.run!])
  }
  done[m.key] = given
}
