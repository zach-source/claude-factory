import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
