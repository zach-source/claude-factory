import { expect, test } from 'bun:test'
import { createActor } from 'xstate'
import { compile, fill, validate, where, type Factory } from '../src/machine'
import sweeps from './sweeps'
import lifecycle from './lifecycle'
import ship from './ship'
import { brief } from '../src/cli'

/** drives a run by outcomes (waking it from any timed wait) and returns the stations it visited */
function walk(def: Factory, outcomes: string[], at = def.start) {
  const actor = createActor(compile(def)).start()
  let now = 0
  if (at !== def.start) actor.send({ type: 'GOTO', node: at, at: now })
  const visited = [where(actor.getSnapshot().value)[0]]
  for (const outcome of outcomes) {
    const { seq } = actor.getSnapshot().context
    actor.send({ type: 'DONE', seq, outcome, summary: outcome, at: ++now })
    if (where(actor.getSnapshot().value)[1] === 'waiting') {
      now = actor.getSnapshot().context.wakeAt
      actor.send({ type: 'TICK', at: now })
    }
    visited.push(where(actor.getSnapshot().value)[0])
  }
  return { visited, snapshot: actor.getSnapshot() }
}

test('queue runs on the laptop like deploy, soak and rollback; release and postmortem keep the rig runner', () => {
  const runner = (n: string) => (ship.nodes as Record<string, { runner?: string }>)[n]!.runner
  for (const n of ['queue', 'deploy', 'soak', 'rollback']) expect(runner(n)).toBe('herdr')
  for (const n of ['release', 'postmortem']) expect(runner(n)).toBeUndefined()
})

test('ship validates, compiles and starts at queue', () => {
  expect(() => compile(validate(ship))).not.toThrow()
  expect(ship.name).toBe('ship')
  expect(ship.start).toBe('queue')
})

test('queue -> deploy -> soak -> queue -> done', () => {
  const { visited, snapshot } = walk(ship, ['ready', 'ready', 'deployed', 'healthy', 'empty'])
  expect(visited).toEqual(['queue', 'release', 'deploy', 'soak', 'queue', 'done'])
  expect(snapshot.context.error).toBeNull()
})

test('a failed deploy rolls back, gets a postmortem, and returns to the queue', () => {
  const { visited } = walk(ship, ['ready', 'ready', 'failed', 'recovered', 'filed', 'empty'])
  expect(visited).toEqual(['queue', 'release', 'deploy', 'rollback', 'postmortem', 'queue', 'done'])
})

test('deploy changes, hold, refresh and published return to the queue', () => {
  for (const outcome of ['changes', 'hold', 'refresh', 'published'])
    expect(walk(ship, ['ready', 'ready', outcome]).visited, outcome).toEqual([
      'queue',
      'release',
      'deploy',
      'queue',
    ])
})

test('a soak that resolves goes to the postmortem; a soak that regresses rolls back', () => {
  expect(walk(ship, ['ready', 'ready', 'deployed', 'resolved', 'filed']).visited.slice(3)).toEqual([
    'soak',
    'postmortem',
    'queue',
  ])
  expect(walk(ship, ['ready', 'ready', 'deployed', 'regressed', 'recovered']).visited.slice(3)).toEqual([
    'soak',
    'rollback',
    'postmortem',
  ])
  expect(walk(ship, ['ready', 'ready', 'deployed', 'unsure']).visited.slice(3)).toEqual(['soak', 'soak'])
})

test('only the release station marks a PR ready: the worker hook allows gh pr ready nowhere else', () => {
  for (const [id, node] of Object.entries(ship.nodes)) {
    const stripped = node.prompt.replaceAll('gh pr ready <n> --undo', '')
    expect(stripped.includes('gh pr ready'), id).toBe(id === 'release')
    expect(node.prompt.includes('--undo'), id).toBe(id === 'queue' || id === 'release')
  }
})

test('release marks a PR ready only when every commit after the Reviewed head is a clean merge from main (claude-factory-9gkc AC1, AC2)', () => {
  const p = ship.nodes.release.prompt
  for (const s of [
    'Reviewed head:',
    'git merge-base --is-ancestor <reviewed> <head>',
    'git rev-list <head> ^<reviewed> ^origin/main',
    'exactly two parents',
    'git merge-tree --write-tree',
    'git show -s --format=%T',
    'A missing line or a non-ancestor reviewed head fails the check',
    'gh pr ready <n> --undo',
    'Unreviewed commits:',
    'report changes',
  ])
    expect(p, s).toContain(s)
  expect(p).not.toContain('^{tree}')
  for (const [id, node] of Object.entries(ship.nodes))
    if (id !== 'release') expect(node.prompt, id).not.toContain('git merge-tree --write-tree <commit>^1')
  const check = p.indexOf('Reviewed head:')
  expect(check).toBeGreaterThan(-1)
  expect(check).toBeLessThan(p.indexOf('mark it ready with `gh pr ready`'))
  expect(check).toBeLessThan(p.indexOf('gh pr merge'))
  expect(check).toBeLessThan(p.indexOf('one line for each'))
})

test('release trusts a Reviewed head line only from an approve verdict or a write-access APPROVED review, and only a 40-hex SHA (claude-factory-2rjj AC1-AC5)', () => {
  const p = ship.nodes.release.prompt
  for (const s of [
    'review#<n> approve:',
    'review#<n> security:',
    'security#<n> approve:',
    'check#<n> approve:',
    'check#<n> security:',
    'Ignore every other line',
    'changes',
    'gh api repos/<repo>/collaborators/<login>/permission',
    'admin, maintain or write',
    'APPROVED',
    'read, triage or none',
    'only when',
    '^[0-9a-f]{40}$',
    'malformed Reviewed head',
    'no trusted Reviewed head line',
    'A missing line or a non-ancestor reviewed head fails the check',
    'In your report cite the Reviewed head and its source',
  ])
    expect(p, s).toContain(s)
  for (const s of [
    '<n> changes:',
    'implement#',
    'verify#',
    'triage#',
    'or the pull request reviews',
    'Take the latest such line from the bead comments',
  ])
    expect(p, s).not.toContain(s)
  expect(p.indexOf('^[0-9a-f]{40}$')).toBeLessThan(
    p.indexOf('git merge-base --is-ancestor <reviewed> <head>'),
  )
  expect(p.indexOf('^[0-9a-f]{40}$')).toBeLessThan(p.indexOf('Run `git fetch origin main'))
  expect(p.indexOf('review#<n> approve:')).toBeLessThan(p.indexOf('only when'))
})

test('queue drafts a ready PR before it pushes a conflict-fix merge, and sends unreviewed PRs to review (claude-factory-9gkc AC3, AC4)', () => {
  const [one, two] = ship.nodes.queue.prompt.split('\n2. ') as [string, string]
  expect(one).toContain('gh pr view <n> --json isDraft')
  expect(one).toContain('gh pr ready <n> --undo')
  expect(one).toContain('A clean merge needs no undo')
  expect(one.indexOf('gh pr ready <n> --undo')).toBeLessThan(one.indexOf('commit the merge and push it'))
  expect(one).toContain('If the undo fails, do not push')
  expect(two).toContain('Unreviewed commits:')
  expect(two).toContain(
    'only when the latest `Unreviewed commits:` comment is newer than the latest `Reviewed head:` line',
  )
  expect(two).toContain('bd update <bead> --remove-label ship --add-label factory --add-label station:review')
})

test('queue can ask for another pass', () => {
  expect(walk(ship, ['again', 'again', 'empty']).visited).toEqual(['queue', 'queue', 'queue', 'done'])
})

test('gates stay: deploy never merges, waits on the PR and parks on owner-only steps; nothing merges', () => {
  expect(ship.nodes.deploy.awaitsPr).toBe(true)
  expect(ship.nodes.deploy.prompt).toContain('never merge')
  expect(ship.nodes.deploy.prompt).toContain('parked, waiting on: <the owner step and the exact command>')
  expect(ship.nodes.deploy.prompt).toContain('owner-only step')
  expect(ship.rules).toBe(lifecycle.rules)
  expect(ship.rules).toContain('Only a person merges a pull request')
  expect(ship.rules).toContain("a worker's own comment never counts as approval")
  for (const [id, node] of Object.entries(ship.nodes)) {
    expect(node.prompt, id).not.toMatch(/--admin|git push --force|--force-with-lease/)
    // only release names `gh pr merge`, as a line for the owner to run; no station runs it
    if (id !== 'release') expect(node.prompt, id).not.toContain('gh pr merge')
    expect((node as { gate?: unknown }).gate, id).toBeUndefined()
  }
})

test('queue keeps PRs current with a merge commit, never a rebase or a force-push', () => {
  const p = ship.nodes.queue.prompt
  expect(p).toContain('merge origin/main into it (a merge commit')
  expect(p).toContain('Never rebase and never force-push')
  expect(p).not.toMatch(/\brebase onto\b/)
})

test('queue sends a PR that needs changes back to implement through the existing station label', () => {
  expect(ship.nodes.queue.prompt).toContain(
    'bd update <bead> --remove-label ship --add-label factory --add-label station:implement',
  )
})

test('a run ships 30 PRs in a row without a stuck step budget', () => {
  const round = ['ready', 'ready', 'published']
  const outcomes = [...Array(30).keys()].flatMap(() => round)
  const { visited, snapshot } = walk(ship, [...outcomes, 'empty'])
  expect(snapshot.context.error).toBeNull()
  expect(visited.at(-1)).toBe('done')
})

test('a queue that always reports again reaches stuck: again does not refill the budget', () => {
  const { snapshot } = walk(ship, Array(30).fill('again'))
  expect(where(snapshot.value)[1]).toBe('stuck')
})

test('queue tells the worker to unship a PR a person closed unmerged', () => {
  expect(ship.nodes.queue.prompt).toContain('closed unmerged leaves the queue')
})

test('a PR closed unmerged leaves the queue before the hold, and soak reads the bead for earlier rollbacks', () => {
  expect(ship.nodes.deploy.prompt).toContain('--remove-label ship')
  expect(ship.nodes.deploy.prompt).toContain('bd defer <bead>')
  expect(ship.nodes.soak.prompt).toContain("the bead's comments")
})

test('release needs every child task closed first', () => {
  expect(ship.nodes.release.prompt).toContain(
    'Every child task of the bead must be closed (bd children <bead>)',
  )
})

test('a release that reports changes does not refill the budget: 12 x (ready, changes) reaches stuck', () => {
  const { snapshot } = walk(ship, Array(12).fill(['ready', 'changes']).flat())
  expect(where(snapshot.value)[1]).toBe('stuck')
})

test('queue and release cover every clean queued PR, not only the next', () => {
  const q = ship.nodes.queue.prompt
  const r = ship.nodes.release.prompt
  expect(q).toContain('every queued pull request in merge order')
  expect(q).toContain('conflict or a red check on their own, each with its reason')
  expect(q).not.toContain('NEXT')
  expect(r).toContain('every queued pull request that the queue reported')
  expect(r).toContain('gh pr merge <n> -R <repo> --merge')
  expect(r).toContain('You never run them')
  expect(r).not.toContain('NEXT')
})

test('queue names the next PR first and lists every owner-only step in one list', () => {
  expect(ship.nodes.queue.prompt).toContain('name the first one first')
  expect(ship.nodes.queue.prompt).toContain('every owner-only step the queue needs in one list')
})

const NO_EDIT = 'Do not edit CHANGELOG.md in a pull request.'

test('no ship station tells a worker to edit CHANGELOG.md (debg AC1, AC2)', () => {
  for (const [name, node] of Object.entries(ship.nodes)) {
    const rest = node.prompt.replace(NO_EDIT, '')
    expect(rest, name).not.toMatch(/\b(add|write|update|edit)\b[^.]*changelog|changelog entry/i)
  }
  const p = ship.nodes.release.prompt
  expect(p).toContain(NO_EDIT)
  expect(p).toContain('writes the changelog at release (tag) time from the merged pull request titles')
  expect(p).toContain('one good changelog line')
  expect(p).toContain('gh pr edit <n> -R <repo> --title')
})

test('release keeps version bump, description and ready steps (debg AC3)', () => {
  const p = ship.nodes.release.prompt
  expect(p).toContain("the version bump the repo's conventions call for")
  expect(p).toContain("the plan's summary, the verification evidence and a rollback plan")
  expect(p).toContain('gh pr ready')
  expect(p).toContain('gh pr merge <n> -R <repo> --merge')
  expect(p).toContain('You never run them')
})

test('release adds --auto when the ruleset needs a review or a merge queue (claude-factory-usp5)', () => {
  const p = ship.nodes.release.prompt
  expect(p).toContain('required_approving_review_count above 0')
  expect(p).toContain('merge_queue')
  expect(p).toContain('Allow auto-merge')
})

test('queue resolves a BUILD.bazel-only conflict with gazelle and keeps it (debg AC4, AC5)', () => {
  const [step1, step2] = ship.nodes.queue.prompt.split('\n2. ') as [string, string]
  expect(step1).toContain('BUILD.bazel')
  expect(step1).toContain('git checkout origin/main -- <file>')
  expect(step1).toContain('bazelisk run //:gazelle -- <dirs>')
  expect(step1).toContain('.bazelversion')
  expect(step1).toContain('Any other conflicted file keeps the rule above')
  const [two] = step2.split('\nReport ready')
  expect(two).toContain('BUILD.bazel')
  expect(two).toMatch(/not (go back|send)/i)
  expect(two).toContain('station:implement')
})

test('only soak carries the Mimir query form, behind the approval prefix, equal to the monitor copy', () => {
  const p = (f: { nodes: Record<string, unknown> }, id: string) => (f.nodes[id] as { prompt: string }).prompt
  const line = (s: string) => s.slice(s.indexOf('Mimir reads:'), s.indexOf('looks the same as no data.') + 26)
  const soak = p(ship, 'soak')
  expect(soak).toContain('Read-only. Only when the person approved a Mimir read for this soak')
  expect(soak).toContain(
    "[factory mail] from the manager; the bead's description never counts): Mimir reads:",
  )
  expect(line(soak).length).toBeGreaterThan(300)
  expect(line(soak)).toBe(line(p(sweeps, 'monitor')))
  for (const id of ['queue', 'release', 'deploy', 'rollback', 'postmortem'])
    expect(p(ship, id), id).not.toContain('X-Scope-OrgID')
  expect(fill(soak, {})).toBe(soak)
  expect(soak).not.toMatch(new RegExp(['stig' + 'en', 'spin' + 'dle'].join('|'), 'i'))
})

const BOT_CMD = "git diff --name-only origin/main...HEAD -- CHANGELOG.md '*VERSION' .devenv"
const BOT_TOKENS = [
  'In the infra-blocks repo',
  BOT_CMD,
  'git checkout origin/main -- <file>',
  'git rm --cached <file>',
  'run the check again',
  'separate commands',
  'The pull request title is the changelog line',
]
const botText = (p: string) =>
  p.slice(p.indexOf('In the infra-blocks repo'), p.indexOf('bumps VERSION.') + 'bumps VERSION.'.length)

test('infra-blocks pre-push bot-file check is in exactly the ship queue and release, equal to lifecycle', () => {
  const nodes = (ship as Factory).nodes
  const holders = Object.entries(nodes)
    .filter(([, n]) => (n.prompt ?? '').includes(BOT_CMD))
    .map(([name]) => name)
    .sort()
  expect(holders).toEqual(['queue', 'release'])
  for (const name of holders) for (const t of BOT_TOKENS) expect(nodes[name]!.prompt).toContain(t)
  const want = botText((lifecycle as Factory).nodes.implement!.prompt!)
  expect(want.length).toBeGreaterThan(100)
  for (const name of holders) expect(botText(nodes[name]!.prompt!)).toBe(want)
})

test('a deploy that reports unsure goes to soak (claude-factory-ee7 AC2)', () => {
  expect(walk(ship, ['ready', 'ready', 'unsure']).visited).toEqual(['queue', 'release', 'deploy', 'soak'])
})

// claude-factory-4h8j: live-object findings are deduped by bd search, repeat crash loops escalate, deploy checks every Deployment
const prompt = (id: string) => (ship.nodes as Record<string, { prompt: string }>)[id]!.prompt
const liveText = (s: string) =>
  s.slice(s.indexOf('Live-object findings:'), s.indexOf('Search and file only in this rig'))
const deployText = (s: string) =>
  s.slice(s.indexOf('Check every Deployment'), s.indexOf('A release that builds no container image'))

test('deploy and soak carry the same live-object finding rule: search, comment, raise priority (4h8j AC1)', () => {
  const want = liveText(prompt('soak'))
  expect(want.length).toBeGreaterThan(300)
  expect(liveText(prompt('deploy'))).toBe(want)
  for (const t of [
    'bd search "<object name>" --status open',
    'bd search "<symptom>" --status open',
    'bd comment <id>',
    'bd update <id> -p <n>',
    'never above P1',
    'Never lower a priority',
    'any bead with the ship label',
    'The comment and escalation steps do not apply to',
    'has a held:* label, a rejected label or an owner label, add no label',
    '<context>/<namespace>/<kind>/<name>: <symptom>',
  ])
    expect(want).toContain(t)
  expect(want).not.toMatch(/-p 0/)
  for (const id of ['queue', 'release', 'rollback', 'postmortem'])
    expect(prompt(id), id).not.toContain('Live-object findings')
})

test('a repeat crash loop or failed rollout gets the factory label and no other label (4h8j AC2)', () => {
  const want = liveText(prompt('soak'))
  for (const t of [
    'bd update <id> --add-label factory',
    'only if it is P2 or lower',
    '24 hours',
    'earlier release',
    'a closed bead counts',
    'CrashLoopBackOff',
    'ProgressDeadlineExceeded',
  ])
    expect(want).toContain(t)
  expect(want).not.toMatch(/station:[a-z]|sweep-queue:[a-z]|--add-label (?!factory)/)
})

test('deploy checks every Deployment of the released image with reads only (4h8j AC3)', () => {
  const want = deployText(prompt('deploy'))
  expect(want.length).toBeGreaterThan(300)
  for (const t of [
    'get deploy -A -o wide',
    'same repository',
    'whatever its tag',
    'rollout status deploy/<name>',
    'report blocked',
    'forbidden or unreachable',
    'number of Deployments in scope',
  ])
    expect(want).toContain(t)
  expect(want).not.toMatch(
    /\b(apply|patch|scale|delete|edit|annotate|label|set image|rollout (restart|undo|pause|resume))\b/,
  )
  expect(want).not.toContain('{')
  for (const id of ['queue', 'release', 'soak', 'rollback', 'postmortem'])
    expect(prompt(id), id).not.toContain('get deploy -A')
})

test('a replayed second soak reads the first soak report and the dedupe rule (4h8j AC5)', () => {
  const first = 'filed acme-1 prod/acme/deploy/widget: CrashLoopBackOff'
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
    log: [
      { node: 'deploy', attempt: 1, outcome: 'deployed', summary: 'deployed v1', at: 1 },
      { node: 'soak', attempt: 1, outcome: 'unsure', summary: first, at: 2 },
    ],
  }
  const run = {
    id: 'r1',
    factory: 'ship',
    repo: '/nonexistent/repo-4h8j',
    goal: 'ship',
    ws: 'ws',
    worktree: '/nonexistent/wt-4h8j',
    branch: 'b',
  }
  const text = brief(run as never, ship as Factory, 'soak', c as never, [])
  expect(text).toContain(first)
  const rule = text.slice(text.indexOf('Live-object findings:'))
  const at = (s: string) => rule.indexOf(s)
  expect(at('bd search')).toBeGreaterThan(-1)
  expect(at('bd search')).toBeLessThan(at('bd comment'))
  expect(at('bd comment')).toBeLessThan(at('matches, file one'))
  const { visited } = walk(ship, ['ready', 'ready', 'deployed', 'healthy', 'ready', 'ready', 'unsure'])
  expect(visited.filter(n => n === 'soak')).toHaveLength(2)
})
