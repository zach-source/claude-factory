import { refuseWorker } from '../caller'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

const DAYS = /^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const USAGE = 'usage: factory gc [--days N] [--dry-run] or gc --worktrees [--rig ID] [--dry-run]'
const daysOk = (v: unknown): v is string =>
  typeof v === 'string' && DAYS.test(v) && Number.isFinite(Number(v)) && Number(v) > 0

function validate(i: unknown): asserts i is Input {
  if (!i || typeof i !== 'object' || Array.isArray(i)) throw new Error(USAGE)
  for (const [key, value] of Object.entries(i)) {
    if (key === 'worktrees' || key === 'dryRun') {
      if (value !== true) throw new Error(USAGE)
    } else if (key === 'days') {
      if (!daysOk(value)) throw new Error(USAGE)
    } else if (key === 'rig') {
      if (typeof value !== 'string' || !ID.test(value)) throw new Error(USAGE)
    } else throw new Error(USAGE)
  }
  const input = i as Input
  if ((input.worktrees && input.days !== undefined) || (!input.worktrees && input.rig !== undefined))
    throw new Error(USAGE)
}

/** Convert the local and server CLI arguments without host effects. */
export function argsInput(args: string[]): Input {
  const input: Input = {}
  const keys: Record<string, string> = {
    '--worktrees': 'worktrees',
    '--dry-run': 'dryRun',
    '--days': 'days',
    '--rig': 'rig',
  }
  for (let n = 0; n < args.length; n++) {
    const key = Object.hasOwn(keys, args[n]!) ? keys[args[n]!] : undefined
    if (!key || Object.hasOwn(input, key)) throw new Error(USAGE)
    if (key === 'days' || key === 'rig') {
      const value = args[++n]
      if (value === undefined) throw new Error(USAGE)
      input[key] = value
    } else input[key] = true
  }
  validate(input)
  return input
}

/** Run one guarded pass with a mode lock and the existing stamp policy. */
export async function run(ctx: Ctx, input: Input): Promise<RunResult> {
  const errors: string[] = []
  const result = await inProc(async print => {
    refuseWorker(ctx.env, 'gc', true)
    validate(input)
    const worktrees = input.worktrees === true
    const dryRun = input.dryRun === true
    const rig = input.rig as string | undefined
    let days = 7
    if (!worktrees) {
      const value = input.days ?? ctx.env.FACTORY_GC_DAYS ?? '7'
      if (!daysOk(value)) throw new Error(`${USAGE}: --days must be a positive number`)
      days = Number(value)
    }
    if (rig) {
      const rigs = await ctx.port.gcRigs()
      if (!rigs.includes(rig))
        throw new Error(
          `factory gc --worktrees --rig ${rig}: no such rig. Known rigs: ${rigs.join(', ') || '(none)'}`,
        )
    }
    const mode = worktrees ? 'gc-worktrees' : 'gc'
    const release = ctx.port.gcHold(`${mode}.lock`)
    if (!release) {
      print(`a gc${worktrees ? ' --worktrees' : ''} pass is already running: skipped this one`)
      return
    }
    try {
      if (!worktrees || !dryRun) ctx.port.gcStamp(`${mode}.stamp`)
      const error = (line: string) => errors.push(`${line}\n`)
      if (worktrees) await ctx.port.gcWorktreesPass(dryRun, rig, print, error)
      else await ctx.port.gcPass(days, dryRun, print, error)
    } finally {
      release()
    }
  })
  return { ...result, err: errors.join('') + result.err }
}
