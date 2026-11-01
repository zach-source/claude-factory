/**
 * `factory ci <pr>` shows the checks of a PR's head SHA.
 * For each failed GitHub Actions job it shows the failing step and the log tail.
 * It only reads, through the injected `gh`.
 * Exit 0 is green, 1 is failed, 2 is pending, 3 is a usage or gh error.
 * ponytail: it reads the first 100 check runs only. It ignores commit statuses, GHES and GitLab.
 * Upgrade path: page the check-runs API.
 */
export type Gh = (args: string[]) => { code: number; out: string; err: string }
export type CiResult = { text: string; exit: 0 | 1 | 2 | 3 }

const ARG =
  /^(?:[1-9][0-9]{0,6}|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]{0,6})$/
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,6})$/
const SHA = /^[0-9a-f]{40}$/
const PASS = new Set(['success', 'neutral', 'skipped'])
const TAIL = 80
const WIDTH = 400

type Check = {
  id?: number
  name?: string
  status?: string
  conclusion?: string | null
  html_url?: string
  details_url?: string
  app?: { slug?: string }
}

const usage = (): CiResult => ({
  text: 'usage: factory ci <pr-number | https://github.com/<owner>/<repo>/pull/<n>>',
  exit: 3,
})
const bad = (why: string): CiResult => ({ text: `factory ci: ${why}`, exit: 3 })

/** one printable-ASCII line for text that came from a tool or a log */
const clean = (s: string, max: number) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '')
    .slice(0, max)

export function ciReport(arg: string[], gh: Gh): CiResult {
  if (arg.length !== 1 || !ARG.test(arg[0]!)) return usage()
  const view = gh(['pr', 'view', arg[0]!, '--json', 'headRefOid,url'])
  if (view.code !== 0) return bad(`gh pr view failed (exit ${view.code})`)
  let pr: { headRefOid?: unknown; url?: unknown }
  try {
    pr = JSON.parse(view.out)
  } catch {
    return bad('gh pr view gave no JSON')
  }
  const m = typeof pr.url === 'string' ? PR_URL.exec(pr.url) : null
  if (!m || typeof pr.headRefOid !== 'string' || !SHA.test(pr.headRefOid))
    return bad('unexpected gh pr view output')
  const [, owner, repo, num] = m
  const sha = pr.headRefOid
  const slug = `${owner}/${repo}`
  const head = `${slug}#${num} ${sha}`

  const res = gh(['api', `repos/${slug}/commits/${sha}/check-runs?per_page=100`])
  if (res.code !== 0) return bad(`gh check-runs read failed (exit ${res.code})`)
  let runs: Check[]
  let total: number
  try {
    const j = JSON.parse(res.out)
    if (!Array.isArray(j.check_runs)) throw new Error('shape')
    runs = j.check_runs
    total = typeof j.total_count === 'number' ? j.total_count : runs.length
  } catch {
    return bad('gh check-runs read gave no usable JSON')
  }
  const note = total > runs.length ? `\nonly the first ${runs.length} of ${total} checks` : ''
  const pending = runs.filter(c => c.status !== 'completed')
  const failed = runs.filter(c => c.status === 'completed' && !PASS.has(String(c.conclusion)))
  if (!failed.length) {
    if (!runs.length) return { text: `${head}: pending (no checks yet)`, exit: 2 }
    if (pending.length)
      return {
        text: `${head}: pending (${pending.length} of ${runs.length} checks not done)\n${pending.map(c => `- ${clean(String(c.name), 200)}`).join('\n')}${note}`,
        exit: 2,
      }
    return { text: `${head}: green (${runs.length} checks)${note}`, exit: 0 }
  }

  const out = [
    `${head}: failed (${failed.length} of ${runs.length} checks failed${pending.length ? `, ${pending.length} pending` : ''})${note}`,
  ]
  for (const c of failed) {
    out.push('', `== ${clean(String(c.name), 200)} (${clean(String(c.conclusion), 40)})`)
    if (c.app?.slug !== 'github-actions' || !Number.isInteger(c.id)) {
      out.push(clean(String(c.details_url ?? c.html_url ?? ''), 300))
      continue
    }
    if (c.html_url) out.push(clean(c.html_url, 300))
    const jobPath = `repos/${slug}/actions/jobs/${c.id}`
    const why = (r: { code: number; err: string }) =>
      `log: not available (gh exit ${r.code}: ${clean(r.err.split('\n')[0] ?? '', 200).replace(/[^\x20-\x7e]/g, '')})`
    const job = gh(['api', jobPath])
    if (job.code !== 0) {
      out.push(why(job))
      continue
    }
    try {
      const step = (JSON.parse(job.out).steps as { number: number; name: string; conclusion: string }[]).find(
        s => s.conclusion === 'failure',
      )
      if (step) out.push(`step ${Number(step.number)} "${clean(String(step.name), 200)}"`)
    } catch {
      // no step line: the log tail below still helps
    }
    const log = gh(['api', `${jobPath}/logs`, '--allow-escape-sequences'])
    if (log.code !== 0) {
      out.push(why(log))
      continue
    }
    const lines = log.out.split('\n')
    if (lines.at(-1) === '') lines.pop()
    out.push(...lines.slice(-TAIL).map(l => clean(l, WIDTH)))
  }
  return { text: out.join('\n'), exit: 1 }
}
