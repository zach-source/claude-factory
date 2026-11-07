import type { On } from 'claude-code'

/** A stand-in for the step prompt files that the mod reads (src/steps/<name>.md).
 * The mod tests cannot read the disk. Each fs.read mock answers a step path with `stepStub(path)`.
 * src/steps.test.ts tests the real text. A stub holds the placeholders that its step fills. */
export const STUB_VARS: Record<string, string> = {
  patrol: ' {{cli}} {{factories}}',
  pm: ' {{cli}}',
  briefer: '',
  reviewer: '',
}

/** the text a step file would hold at `path`, or undefined when `path` is no step file */
export function stepStub(path: string): string | undefined {
  const name = /\/src\/steps\/(\w+)\.md$/.exec(path)?.[1]
  return name && name in STUB_VARS ? `STUB ${name}${STUB_VARS[name]}\n` : undefined
}

/** what the mod registers for `name`, with the factory CLI at `cli` */
export function stubPrompt(name: string, cli: string): string {
  return `STUB ${name}${(STUB_VARS[name] ?? '')
    .replace('{{cli}}', cli)
    .replace('{{factories}}', cli.replace(/bin\/factory$/, 'factories/'))}`
}

/** answers every fs.read of a step file with its stub, and any other path with ENOENT */
export const onStepFiles = (on: On) =>
  on('fs.read', ($, e) => {
    const path = (e as { path: string }).path
    const stub = stepStub(path)
    if (stub === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
    return { value: stub } as never
  })
