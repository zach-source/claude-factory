import { refuseWorker } from '../caller'
import { inProc, type Ctx, type Input, type RunResult } from '../catalog'

const USAGE = 'usage: factory image build [--target worker|manager]'

function target(i: unknown): 'worker' | 'manager' {
  if (!i || typeof i !== 'object' || Array.isArray(i)) throw new Error(USAGE)
  for (const key of Object.keys(i)) if (key !== 'target') throw new Error(USAGE)
  const t = (i as Input).target
  if (t === undefined) return 'worker'
  if (t !== 'worker' && t !== 'manager') throw new Error(USAGE)
  return t
}

/** Convert the CLI arguments after `image`: `build` or `build --target worker|manager`. */
export function argsInput(args: string[]): Input {
  const ok = args[0] === 'build' && (args.length === 1 || (args.length === 3 && args[1] === '--target'))
  if (!ok) throw new Error(USAGE)
  const input: Input = args.length === 3 ? { target: args[2]! } : {}
  target(input)
  return input
}

/** Build and push one image through the port. The port stores the ref. A lock refuses a second build. */
export async function run(ctx: Ctx, input: Input): Promise<RunResult> {
  const errors: string[] = []
  const result = await inProc(async print => {
    refuseWorker(ctx.env, 'image build', true)
    const t = target(input)
    // ponytail: gcHold is the generic lock of the port; rename it when a third user comes
    const release = ctx.port.gcHold('image.lock')
    if (!release) throw new Error('an image build is already running: try again when it ends')
    try {
      print(await ctx.port.imageBuild(t, l => errors.push(`${l}\n`)))
    } finally {
      release()
    }
  })
  return { ...result, err: errors.join('') + result.err }
}
