// A stand-in for the core `factory interview` and `factory interview answer` (hpmc.35). It builds the list
// from what the wrapped handler returns for `tick` and `decisions`, with the same openInterviews as the core,
// and it answers by the old per-member commands, so a test sees the same `decisions answer`, `start`, `mail`.
import { interviewAnswer, openInterviews } from '../hooks/view'

type Out = { exitCode: number; stdout: string; stderr: string }
type Event = { argv: string[] }
type Handler = ($: unknown, e: Event) => { value: Out }

const NO_DECISIONS = '{"rigs":[],"proposals":{}}'
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })

function core(h: Handler, $: unknown, e: Event, at: number, answered: Record<string, string>) {
  const call = (argv: string[]) => h($, { ...e, argv }).value
  const dec = call(['decisions'])
  if (dec.exitCode !== 0) return { value: dec }
  const t = JSON.parse(call(['tick']).stdout || '{"runs":[]}')
  const d = JSON.parse(dec.stdout || NO_DECISIONS)
  const list = openInterviews(t.runs ?? [], d.rigs, d.proposals, answered)
  if (e.argv[at + 1] !== 'answer') return ok(JSON.stringify(list))
  const [, , item, choice = '', typed = ''] = e.argv.slice(at)
  const iv = list.find(m => m.key === item)
  if (!iv) return { value: { exitCode: 1, stdout: '', stderr: 'no open question' } }
  for (const m of [iv, ...(iv.also ?? [])]) {
    const text = interviewAnswer(m, choice || undefined, typed)!
    const steps =
      m.kind === 'bead' || m.kind === 'owned'
        ? [
            ['decisions', 'answer', m.rig!, m.bead!, text],
            ...(m.kind === 'owned' && choice === 'start now'
              ? [
                  [
                    'start',
                    d.rigs.find((r: { rig: string }) => r.rig === m.rig)?.factory ?? 'lifecycle',
                    m.rig!,
                    m.bead!,
                    '--owned',
                  ],
                ]
              : []),
          ]
        : [
            ['mail', m.run!, m.node!, '--wake', text],
            ...(m.kind === 'stuck' ? [[choice === 'abort' ? 'abort' : 'retry', m.run!]] : []),
          ]
    for (const s of steps) {
      const r = call(s)
      if (r.exitCode !== 0) return { value: r }
    }
    answered[m.key] = choice
  }
  return ok('answered')
}

export function coreRun(h: Handler): Handler {
  const answered: Record<string, string> = {}
  return ($, e) => {
    const at = e.argv.indexOf('interview')
    if (at >= 0) return core(h, $, e, at, answered)
    // a test that does not care about bd decisions gets none
    if (e.argv.includes('decisions') && !e.argv.includes('answer')) {
      const r = h($, e)
      return r.value.stdout || r.value.exitCode ? r : { value: { ...r.value, stdout: NO_DECISIONS } }
    }
    return h($, e)
  }
}
