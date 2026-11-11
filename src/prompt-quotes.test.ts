// claude-factory-12af: a worker prompt shows free text in single quotes; bash expands $VAR inside double quotes.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brief, reportCmd, resumeNote } from './cli'
import { forgeNote } from './prs'
import { GLAB_APPROVE_REASON } from './worker-hook'
import lifecycle from '../factories/lifecycle'
import release from '../factories/release'
import ship from '../factories/ship'
import sweeps from '../factories/sweeps'
import type { Factory } from './machine'

const root = join(import.meta.dir, '..')
const files = [
  'factories/lifecycle.ts',
  'factories/ship.ts',
  'factories/sweeps.ts',
  'factories/release.ts',
  'src/cli.ts',
  'src/prs.ts',
  'src/worker-hook.ts',
  'src/worker-system.md',
  'src/worker-vm.md',
  'src/worker-codex.md',
  'src/worker.ts',
  'src/home-guard.ts',
]
// not shell text: JSON file content, a code comment, a regex class, and two usage errors for the person who runs `factory start`
const allowed: [file: string, text: string][] = [
  ['factories/sweeps.ts', '{"repo":"<owner>/<repo>"'],
  ['factories/release.ts', 'factory start release <rig> "<version or bead>'],
  ['src/cli.ts', '--slo "<read-only command>"'],
  ['src/cli.ts', '--drift "<read-only command>"'],
  ['src/worker-hook.ts', '$\\\\\'"<>&|]*$/'],
]

/** the lines of a source file that hold a double-quoted placeholder, after the allowlisted text is removed */
const scan = (file: string, text: string) =>
  text.split('\n').flatMap((line, i) => {
    let rest = line
    for (const [f, t] of allowed) if (f === file) rest = rest.split(t).join('')
    return rest.includes('"<') || /\bbd (?:search|create|comment|close) [^`"]*"[^"`]*<[^"`]*"/.test(rest)
      ? [file + ':' + (i + 1) + ': ' + line.trim().slice(0, 100)]
      : []
  })

test('no prompt source holds a double-quoted placeholder', () => {
  const hits = files.flatMap(f => scan(f, readFileSync(join(root, f), 'utf8')))
  expect(hits).toEqual([])
})

test('each allowlisted text occurs exactly once', () => {
  for (const [f, t] of allowed) {
    const n = readFileSync(join(root, f), 'utf8').split(t).length - 1
    expect([f, t, n]).toEqual([f, t, 1])
  }
})

test('scan flags a double-quoted placeholder, passes a single-quoted one', () => {
  expect(scan('x.ts', 'bd comment <id> "<time, evidence>"')).toHaveLength(1)
  expect(scan('x.ts', 'report r 1 <outcome> "<summary>"')).toHaveLength(1)
  expect(scan('x.ts', 'run `bd search "CI runner loss: <workflow> / <job>"` now')).toHaveLength(1)
  expect(scan('x.ts', "run `bd search 'CI runner loss: <workflow> / <job>'` now")).toEqual([])
  expect(scan('x.ts', "bd comment <id> '<time, evidence>'")).toEqual([])
  expect(scan('src/cli.ts', '{"repo":"<owner>/<repo>"')).toHaveLength(1)
  expect(scan('factories/sweeps.ts', '{"repo":"<owner>/<repo>"')).toEqual([])
})

const c = {
  seq: 1,
  attempt: 1,
  pane: null,
  session: null,
  resumes: 0,
  startedAt: Date.now(),
  nudgedAt: 0,
  nudges: 0,
  retryAt: 0,
  budget: 10,
  wakeAt: 0,
  error: null,
  mail: {},
  seen: {},
  log: [],
}
const run = {
  id: 'r1',
  factory: 'f',
  repo: '/nonexistent/repo-12af',
  goal: 'g',
  ws: 'ws',
  worktree: '/nonexistent/wt-12af',
  branch: 'b',
}

test('every brief of lifecycle, ship, sweeps and release has no double-quoted placeholder and states the quote rule', () => {
  for (const def of [lifecycle, ship, sweeps, release] as Factory[]) {
    for (const node of Object.keys(def.nodes)) {
      const text = brief(run, def, node, { ...c, log: [] } as never, [])
      // the sweeps JSON example is file content, not shell
      const stripped = text.split('{"repo":"<owner>/<repo>"').join('')
      expect(stripped.includes('"<') ? node + ': has "<' : '').toBe('')
      for (const s of [
        'report r1 1 <outcome> --summary-file <path>',
        'manager --text-file <path>',
        '--body-file <path>',
        'Use only plain words there.',
        "'<query>'",
        "'\\''",
        'single quotes',
        ...(text.includes('- Add a task:') ? ["'<title>'"] : []),
      ])
        expect(text.includes(s) ? '' : node + ': lacks ' + s).toBe('')
    }
  }
})

/**
 * claude-factory-jho3: find each quoted placeholder that is not in a slot with no file form.
 * The model must escape a quote in untrusted text by hand. The hook cannot find an injected quote.
 * An allowed slot holds a short label. All other free text goes by file.
 * A command that is not known is a defect. A double quote is always a defect.
 */
const fixedSlots: [before: RegExp, quoted: string][] = [
  [/--header=$/, "'X-Scope-OrgID: <tenant>'"],
  [/--post-data=$/, "'query=<promql>'"],
  [/gh pr list [^']*--search $/, "'<failing name> in:title,body'"],
  [/glab api [^']*-f title=$/, "'<title>'"],
  [/gh api --paginate $/, "'repos/<owner>/<repo>/dependabot/alerts?state=open'"],
]

export function quotedSlots(text: string): string[] {
  const hits: string[] = []
  // an apostrophe inside a word (run's) does not open a quote
  const quoted = /(?<!\w)(['"])([^'"\n]*<[^<>\n]+>[^'"\n]*)\1(?!\w)/g
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(quoted)) {
      const before = line.slice(0, m.index)
      const cmds = [
        ...before.matchAll(
          /\b(?:bd (?:search|create|comment|close|update|show)|factory (?:memory (?:add|search|helped)|[\w-]+)|glab (?:mr note|api)|gh pr (?:comment|review|create))\b/g,
        ),
      ]
      const last = cmds.at(-1)
      const cmd = last?.[0].replace(/^.*\bfactory /, '')
      // the first quoted word after the command is the slot; a second one is body text
      const first = last !== undefined && !/['"]/.test(before.slice(last.index! + last[0].length))
      const slot = ['bd search', 'bd create', 'memory search', 'memory add'].includes(cmd ?? '')
      if (m[1] === "'" && first && slot) continue
      // a name or an id in a read-only query, not free text
      if (m[1] === "'" && fixedSlots.some(([pre, q]) => pre.test(before) && q === m[0])) continue
      hits.push(m[0])
    }
  }
  return hits
}

test('quotedSlots flags a quoted placeholder outside the allowed slots', () => {
  for (const t of [
    "bd comment <id> '<evidence>'",
    "bd create '<t>' -d '<e>'",
    "bd close <id> --reason '<r>'",
    "factory report r 1 <outcome> '<summary>'",
    "factory mail r manager '<question>'",
    "factory memory add --kind fact '<s>' '<body>'",
    "glab mr note 5 -m '<text>'",
    "gh pr comment 5 --body '<text>'",
    "factory file-elsewhere x --from a:b --title '<t>' --description-file <p>",
    "foo '<x>'",
    "gh pr create --title '<failing name> in:title,body'",
    "x --post-data='<promql>'",
    "gh pr list --state open --search '<failing name> in:body'",
    "gh api --paginate '<owner>/<repo>'",
    'bd comment <id> "<e>"',
    'bd search "<words>"',
    "glab api --method POST projects/:id/merge_requests -F title='<title>'",
    "glab api --method POST projects/:id/merge_requests -f title='<title>' -f x='<e>'",
  ])
    expect([t, quotedSlots(t).length]).toEqual([t, 1])
})

test('quotedSlots passes the allowed slots and a file form', () => {
  for (const t of [
    "bd search '<words>' --status open",
    "bd create '<title>' --parent b --body-file <path>",
    "factory memory add --kind fact '<summary>' --body-file <path>",
    "factory memory search '<query>'",
    'bd comment <id> --file <path>',
    "bd search 'CI runner loss: <workflow> / <job>' --status open",
    "wget --header='X-Scope-OrgID: <tenant>' --post-data='query=<promql>' 'http://h'",
    "gh pr list --state open --search '<failing name> in:title,body'",
    "gh api --paginate 'repos/<owner>/<repo>/dependabot/alerts?state=open'",
    "glab api --method POST projects/:id/merge_requests -f title='<title>' -F description=@<path>",
  ])
    expect([t, quotedSlots(t)]).toEqual([t, []])
})

test('every rendered worker text has no quoted placeholder outside the allowed slots', () => {
  const texts: [string, string][] = []
  for (const def of [lifecycle, ship, sweeps, release] as Factory[])
    for (const node of Object.keys(def.nodes))
      texts.push([
        `${def.name}/${node}`,
        brief(run, def, node, { ...c, log: [] } as never, [])
          .split('{"repo":"<owner>/<repo>"')
          .join(''),
      ])
  const ctx = { ...c, log: [] } as never
  texts.push(['resume note', resumeNote(run, 'implement', ctx)])
  for (const outcome of [undefined, 'blocked', 'handoff'])
    texts.push([`reportCmd ${outcome}`, reportCmd(run, ctx, outcome)])
  texts.push(
    ['forgeNote', forgeNote('gitlab.example.com').join('\n')],
    ['GLAB_APPROVE_REASON', GLAB_APPROVE_REASON],
  )
  for (const f of ['worker-system.md', 'worker-vm.md', 'worker-codex.md'])
    texts.push([f, readFileSync(join(root, 'src', f), 'utf8')])
  expect(texts.flatMap(([name, t]) => quotedSlots(t).map(h => `${name}: ${h}`))).toEqual([])
})

test('forge note and the glab approve reason use the file form for a note text', () => {
  const note = forgeNote('gitlab.example.com').join('\n')
  for (const t of [note, GLAB_APPROVE_REASON]) {
    expect(t).toContain('glab api --method POST projects/:id/merge_requests/<n>/notes -F body=@<path>')
    expect(t).not.toContain('"<')
  }
})

// a run of 4+ caps between non-letters in a single-quoted span; an env name (FACTORY_HOME) has an underscore, so it passes
function capsInQuotes(src: string): string[] {
  const hits: string[] = []
  for (const q of src.matchAll(/(?<=[\s=(])'[^'\n]*'/g))
    if (/(?<![A-Za-z_])[A-Z]{4,}(?![A-Za-z_])/.test(q[0])) hits.push(q[0])
  return hits
}

test('capsInQuotes flags an all-caps placeholder anywhere in a quoted span', () => {
  for (const t of [
    "gh api 'repos/OWNER/REPO/x'",
    "wget --post-data='query=PROMQL'",
    "gh pr list --search 'FAILING in:body'",
    "x --header='X-Scope-OrgID: TENANT'",
    "x 'OWNER/REPO'",
  ])
    expect([t, capsInQuotes(t).length]).toEqual([t, 1])
})

test('capsInQuotes passes header names, env names and the <word> form', () => {
  for (const t of [
    "wget --header='X-Scope-OrgID: <tenant>' --post-data='query=<promql>' 'http://h'",
    "gh api 'repos/<owner>/<repo>/dependabot/alerts?state=open'",
    "x 'FACTORY_HOME' 'Authorization: Bearer <t>' 'Content-Type: application/json'",
    "the attacker's diff, a 'GET'",
  ])
    expect([t, capsInQuotes(t)]).toEqual([t, []])
})

test('a factory prompt writes a quoted placeholder as <word>, never as an all-caps word', () => {
  for (const f of ['lifecycle', 'ship', 'sweeps', 'release'])
    expect([f, capsInQuotes(readFileSync(join(root, 'factories', f + '.ts'), 'utf8'))]).toEqual([f, []])
})

test('the advisories sweep quotes the dependabot path with <owner>/<repo>', () => {
  expect(readFileSync(join(root, 'factories', 'sweeps.ts'), 'utf8')).toContain(
    "'repos/<owner>/<repo>/dependabot/alerts?state=open'",
  )
})

test('each gh pr create and gh pr review in a factory prompt names a body file', () => {
  let n = 0
  for (const f of ['lifecycle', 'ship', 'sweeps']) {
    const src = readFileSync(join(root, 'factories', f + '.ts'), 'utf8')
    for (const m of src.matchAll(/gh pr (?:create|review) [^\n]{0,60}/g)) {
      n++
      expect([f, m[0].includes('--body-file <path>') ? '' : m[0]]).toEqual([f, ''])
    }
  }
  expect(n).toBeGreaterThanOrEqual(8)
  expect(readFileSync(join(root, 'factories', 'ship.ts'), 'utf8')).toContain(
    'gh pr edit <n> -R <repo> --body-file <path>',
  )
  const mr = forgeNote('gitlab.example.com').find(
    l => l.includes('glab mr create') || l.includes('projects/:id/merge_requests -'),
  )
  expect(mr).toContain('description=@<path>')
  expect(mr).toContain("-f title='<title>'")
  for (const f of ['-F title=', '-F source_branch=', '-F target_branch=']) expect(mr).not.toContain(f)
  const text = brief(run, lifecycle as Factory, 'implement', { ...c, log: [] } as never, [])
  expect(text).toContain('a pull request body, a review body')
})
