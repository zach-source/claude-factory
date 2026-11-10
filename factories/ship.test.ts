import { expect, test } from 'bun:test'
import { createActor } from 'xstate'
import { compile, fill, validate, where, type Factory } from '../src/machine'
import sweeps from './sweeps'
import lifecycle from './lifecycle'
import ship from './ship'
import release from './release'
import { brief } from '../src/cli'
import { actorOf } from '../src/beads'

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

test('deploy waits for a bump pull request in another repo and never opens or merges it', () => {
  const p = ship.nodes.deploy.prompt
  expect(p).toContain('only through a pull request in another repo')
  expect(p).toContain('never open or merge it')
  expect(p).toContain('parked, waiting on: a bump pull request in <repo>')
})

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
    expect(node.prompt.includes('--undo'), id).toBe(id === 'queue' || id === 'release' || id === 'deploy')
  }
})

test('release marks a PR ready only when every commit after the Reviewed head is a clean merge from main (claude-factory-9gkc AC1, AC2)', () => {
  const p = ship.nodes.release.prompt
  for (const s of [
    'Reviewed head:',
    'git merge-base --is-ancestor <reviewed> <head>',
    'git rev-list <head> ^<reviewed> ^origin/{base_branch}',
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
  expect(p.indexOf('^[0-9a-f]{40}$')).toBeLessThan(p.indexOf('Run `git fetch origin {base_branch}'))
  expect(p.indexOf('review#<n> approve:')).toBeLessThan(p.indexOf('only when'))
})

test('release trusts a bead-comment Reviewed head only from the runner or a person, best effort (claude-factory-3grj)', () => {
  const p = ship.nodes.release.prompt
  for (const s of [
    'bd comments <bead> --json',
    "comment's author field",
    '^factory/[^/]+$',
    'factory/<run>/<station>',
    'a person',
    'best effort',
    'by factory/<run>',
  ])
    expect(p, s).toContain(s)
  expect(p.indexOf('^factory/[^/]+$')).toBeLessThan(p.indexOf('Use source 2'))
  const runner = new RegExp('^factory/[^/]+$')
  expect(runner.test(actorOf('lifecycle-x'))).toBe(true)
  expect(runner.test(actorOf('lifecycle-x') + '/implement')).toBe(false)
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
    'only when the latest `Unreviewed commits:` comment is newer than the latest trusted `Reviewed head:` line (an approve verdict, from the same sources as release;',
  )
  expect(two).toContain('bd update <bead> --remove-label ship --add-label factory --add-label station:review')
})

test('queue and release carry the same Reviewed-head source rules once (claude-factory-94gg AC1-AC3)', () => {
  const rel = ship.nodes.release.prompt
  const start = rel.indexOf('A station that approves writes a line')
  const endMark = 'ignore that review.'
  const end = rel.indexOf(endMark) + endMark.length
  expect(start).toBeGreaterThan(-1)
  const sources = rel.slice(start, end)
  const two = (ship.nodes.queue.prompt.split('\n2. ') as [string, string])[1]
  expect(two).toContain(sources)
  for (const s of [
    '^factory/[^/]+$',
    'factory/<run>/<station>',
    'bd comments <bead> --json',
    "comment's author field",
    'gh api repos/<repo>/collaborators/<login>/permission',
    'admin, maintain or write',
    'read, triage or none',
    'APPROVED',
    'best effort',
  ])
    expect(two, s).toContain(s)
  expect(two.split(sources).length).toBe(2)
  expect(ship.nodes.queue.prompt.split(sources).length).toBe(2)
  expect(rel.split(sources).length).toBe(2)
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
  expect(p).toContain('merge origin/{base_branch} into it (a merge commit')
  expect(p).toContain('Never rebase and never force-push')
  expect(p).not.toMatch(/\brebase onto\b/)
})

test('queue sends a PR that needs changes back to implement through the existing station label', () => {
  expect(ship.nodes.queue.prompt).toContain(
    'bd update <bead> --remove-label ship --add-label factory --add-label station:implement',
  )
})

test('queue does not send a PR back when its red tests are held assertions', () => {
  const p = ship.nodes.queue.prompt
  const step2 = p.split('\n2. ')[1]!
  for (const s of [
    'read its bead comments and the plan',
    'held assertions',
    'an open bead or an owner decision',
    'Do not send it back',
  ])
    expect(step2).toContain(s)
  const send = 'bd update <bead> --remove-label ship --add-label factory --add-label station:implement'
  expect(step2.indexOf('held assertions')).toBeLessThan(step2.indexOf(send))
  expect(p).toContain('report blocked once')
  expect(p).toContain('Report ready when at least one queued pull request is current')
  expect(Object.keys(ship.nodes.queue.next)).toEqual(['ready', 'again', 'empty'])
})

test('queue step 2 and postmortem check for a hold before they add factory (claude-factory-5nh2)', () => {
  const two = ship.nodes.queue.prompt.split('\n2. ')[1]!
  const pm = ship.nodes.postmortem.prompt
  const extract = (p: string) => {
    const start = p.indexOf('Hold check:')
    expect(start).toBeGreaterThan(-1)
    const endMark = '(lifecycle on most rigs).'
    const end = p.indexOf(endMark, start)
    expect(end).toBeGreaterThan(start)
    return p.slice(start, end + endMark.length)
  }
  const check = extract(two)
  const pmCheck = extract(pm)
  expect(pmCheck).toBe(check.replaceAll('<station>', 'plan'))
  for (const t of [
    'bd show <bead> --json',
    'rejected, human or owner,',
    'when a label starts with held:',
    'the key owner_decisions (any value)',
    'when the read fails,',
    'If the read fails, treat the bead as held.',
    'If the bead is held, do not add or remove a label.',
    'If no comment names the same hold reason, or the read fails, write the evidence in a bead comment.',
    'Read only the labels and metadata of its first element, the bead itself.',
    'Ignore the labels and metadata of the dependencies and dependents',
    'in your report, so that a person queues it.',
    'The steps are `bd update <bead> --remove-label ship`, then `factory queue <rig> <bead> <station>`.',
    'factory start <factory>@<station> <rig> <bead> --owned',
    'because dispatch skips an owner_decisions bead',
  ])
    expect(check).toContain(t)
  expect(two).toContain('<station> is review when the pull request needs review')
  expect(pmCheck).toContain('`factory queue <rig> <bead> plan`')
  expect(pmCheck).toContain('factory start <factory>@plan <rig> <bead> --owned')
  expect(pm).toContain('bd update <bead> --remove-label ship --add-label factory --add-label station:plan')
  for (const p of [two, pm]) {
    expect(p).not.toContain('`factory queue <rig> <bead>`')
    expect(p).not.toContain('--station')
  }
  for (const [p, own] of [
    [two, check],
    [pm, pmCheck],
  ] as const)
    expect(p.indexOf(own)).toBeLessThan(p.indexOf('--add-label factory'))
  expect(pm).toContain('If the bead is not held, send the released bead back')
  for (const [name, node] of Object.entries(ship.nodes)) {
    const prompt = (node as { prompt: string }).prompt
    for (const m of prompt.matchAll(/bd update <bead>[^`]*--add-label factory/g)) {
      const at = prompt.indexOf('Hold check:')
      expect(at, `${name} adds factory without the hold check`).toBeGreaterThan(-1)
      expect(at).toBeLessThan(m.index!)
    }
  }
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

test('release re-reads headRefOid after gh pr ready and undoes on a moved head (claude-factory-zz7b)', () => {
  const p = ship.nodes.release.prompt
  const reread = 'Right after you mark it, read `gh pr view <n> --json headRefOid` again.'
  const at = p.indexOf(reread)
  expect(at).toBeGreaterThan(p.indexOf('mark it ready with `gh pr ready`'))
  const after = p.slice(at)
  for (const s of [
    'run `gh pr ready <n> --undo` at once.',
    'Do the same if the read fails.',
    'Then report changes with the new SHAs.',
    'If the undo fails, report blocked with the pull request link.',
  ])
    expect(after, s).toContain(s)
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
  expect(step1).toContain('git checkout origin/{base_branch} -- <file>')
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

test('a deploy that reports unsure goes to soak (claude-factory-ee7 AC2)', () => {
  expect(walk(ship, ['ready', 'ready', 'unsure']).visited).toEqual(['queue', 'release', 'deploy', 'soak'])
})

// claude-factory-4h8j: live-object findings are deduped by bd search, repeat crash loops escalate, deploy checks every Deployment
const prompt = (id: string) => (ship.nodes as Record<string, { prompt: string }>)[id]!.prompt
const liveText = (s: string) =>
  s.slice(
    s.indexOf('Live-object findings:'),
    s.indexOf('no sweep-queue:* label.') + 'no sweep-queue:* label.'.length,
  )
const deployText = (s: string) =>
  s.slice(s.indexOf('Check every Deployment'), s.indexOf('A release that builds no container image'))

test('deploy and soak carry the same live-object finding rule: search, comment, raise priority (4h8j AC1)', () => {
  const want = liveText(prompt('soak'))
  expect(want.length).toBeGreaterThan(300)
  expect(liveText(prompt('deploy'))).toBe(want)
  for (const t of [
    "bd search '<object name>' --status open",
    "bd search '<symptom>' --status open",
    'bd comment <id>',
    'bd update <id> -p <n>',
    'never above P1',
    'Never lower a priority',
    'any bead with the ship label',
    'The comment and escalation steps do not apply to',
    'run `bd show <id> --json`. The output is an array.',
    'If the read fails, if that bead has a held:* label, a rejected label, a human label or an owner label, or if its metadata has the key owner_decisions (any value), add no label',
    'Read only the labels and metadata of its first element, the bead itself.',
    'Ignore the labels and metadata of the dependencies and dependents that it embeds.',
    'so a person runs `factory queue <rig> <id>`.',
    'the step is `factory start <factory> <rig> <id> --owned` instead, because dispatch skips an owner_decisions bead.',
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

const coreText = (s: string) =>
  s.slice(
    s.indexOf('Live-object findings:'),
    s.indexOf("Search and file only in this rig's beads.") +
      "Search and file only in this rig's beads.".length,
  )

test('deploy and soak share a live-object dedupe core with no escalation (sjwe.2 AC2)', () => {
  const want = coreText(prompt('soak'))
  expect(want.length).toBeGreaterThan(300)
  expect(coreText(prompt('deploy'))).toBe(want)
  for (const t of [
    "bd search '<object name>' --status open",
    "bd search '<symptom>' --status open",
    'with no --status',
    'bd comment <id>',
    '<context>/<namespace>/<kind>/<name>: <symptom>',
    'name it in the description',
  ])
    expect(want).toContain(t)
  const full = liveText(prompt('soak'))
  expect(full.indexOf(want)).toBeGreaterThanOrEqual(0)
  for (const t of [
    'In deploy and soak, put the release version in that comment.',
    "raise the open bead's priority by one step",
  ])
    expect(full.indexOf(t)).toBeGreaterThan(want.length)
  for (const t of ['bd update', '--add-label', '-p ', 'ship', 'release', '{', 'In deploy and soak'])
    expect(want).not.toContain(t)
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

// claude-factory-nibm: soak re-checks a block for each plain mail, like deploy did; both hold it from the second block
test('deploy and soak hold plain mail', () => {
  expect(ship.nodes.deploy.holdMail).toBe(true)
  expect(ship.nodes.soak.holdMail).toBe(true)
})

// claude-factory-sjwe: one live-object dedupe core in deploy, soak, sweeps monitor and lifecycle incident
const nodePrompt = (f: unknown, id: string) =>
  (f as { nodes: Record<string, { prompt?: string }> }).nodes[id]!.prompt ?? ''
const coreOf = (s: string) => {
  const end = "Search and file only in this rig's beads."
  return s.slice(s.indexOf('Live-object findings:'), s.indexOf(end) + end.length)
}

test('deploy, soak, monitor and incident carry one live-object dedupe core (sjwe AC1)', () => {
  const want = coreOf(prompt('soak'))
  expect(want.length).toBeGreaterThan(300)
  expect(coreOf(prompt('deploy'))).toBe(want)
  expect(coreOf(nodePrompt(sweeps, 'monitor'))).toBe(want)
  expect(coreOf(nodePrompt(lifecycle, 'incident'))).toBe(want)
  for (const t of [
    "bd search '<object name>' --status open",
    "bd search '<symptom>' --status open",
    'with no --status',
    'bd comment <id>',
    '<context>/<namespace>/<kind>/<name>: <symptom>',
    'name it in the description',
  ])
    expect(want).toContain(t)
  for (const t of ['bd update', '--add-label', '-p ', 'ship', 'release', '{']) expect(want).not.toContain(t)
  for (const id of ['queue', 'release', 'rollback', 'postmortem'])
    expect(prompt(id), id).not.toContain('Live-object findings')
  for (const [f, keep] of [
    [sweeps, 'monitor'],
    [lifecycle, 'incident'],
  ] as const)
    for (const id of Object.keys((f as Factory).nodes))
      if (id !== keep) expect(nodePrompt(f, id), id).not.toContain('Live-object findings')
})

test('monitor and incident only dedupe: no priority raise, no label (sjwe AC2)', () => {
  const mon = nodePrompt(sweeps, 'monitor')
  const inc = nodePrompt(lifecycle, 'incident')
  for (const p of [mon, inc]) {
    expect(p).toContain('Live-object findings:')
    expect(p).not.toContain('bd update <id> -p')
    expect(p).not.toContain('--add-label')
    expect(p).not.toContain('this ship run')
    expect(p).not.toContain('regressed (soak)')
  }
  expect(mon).toContain('add no label')
  expect(mon).toContain('change no priority')
  expect(mon.indexOf('Never file what is already tracked')).toBeLessThan(mon.indexOf('Live-object findings:'))
  expect(inc.indexOf('Live-object findings:')).toBeLessThan(inc.indexOf('Report rollback'))
  const noEsc = coreOf(prompt('soak')) + ' On a matched open bead, add no label and change no priority.'
  expect(mon).toContain(noEsc)
  expect(inc).toContain(noEsc)
  expect(prompt('deploy')).not.toContain(noEsc)
  expect(prompt('soak')).not.toContain(noEsc)
})

test('fill leaves the dedupe core as it is (sjwe AC4)', () => {
  for (const p of [
    prompt('deploy'),
    prompt('soak'),
    nodePrompt(sweeps, 'monitor'),
    nodePrompt(lifecycle, 'incident'),
  ])
    expect(fill(p, {})).toBe(p)
})

test('deploy and soak carry the AC ledger, and only they do (7s88)', () => {
  const met = 'ACn: met ('
  for (const id of ['deploy', 'soak']) {
    const p = prompt(id)
    const start = p.indexOf('AC ledger:')
    expect(start, id).toBeGreaterThan(-1)
    const ledger = p.slice(start, p.indexOf('\n', start))
    for (const t of [
      met,
      'ACn: not checked (',
      'ACs: none in plan',
      'ACn: waived (',
      '--deps discovered-from:<bead> --body-file <path>',
      'bd children <bead>',
      'no factory label',
      'When you report published (deploy) or healthy (soak), never leave the bead open with the ship label',
      'name each filed id in the close reason',
    ])
      expect(p, `${id}: ${t}`).toContain(t)
    for (const t of [
      'Question:',
      'description never counts',
      'Never close the bead',
      'unless a filed bead or a waiver carries it',
    ])
      expect(ledger, `${id} ledger: ${t}`).toContain(t)
    expect(ledger).not.toContain('The one exception')
    expect(p.indexOf('unless a filed bead or a waiver carries it'), id).toBeLessThan(
      p.indexOf('bd close <bead>'),
    )
  }
  for (const id of ['queue', 'release', 'rollback', 'postmortem']) expect(prompt(id), id).not.toContain(met)
})

test('release.rules holds the runner-loss bullet of lifecycle.rules once', () => {
  const line = lifecycle.rules!.split('\n').find(l => l.startsWith('- Runner loss in CI:'))
  expect(line).toBeDefined()
  expect(release.rules!.split('\n').filter(l => l === line).length).toBe(1)
})

const soakSentence = (needle: string) => {
  const p = prompt('soak')
  const i = p.indexOf(needle)
  expect(i, needle).toBeGreaterThan(-1)
  const start = p.lastIndexOf('. ', i) + 2
  return p.slice(start, p.indexOf('. ', i) + 1)
}

test('3w8o AC1 soak has a deadline rule for unseen own output', () => {
  const dl = soakSentence('fourth such soak')
  for (const t of ['24 hours after deploy', 'whichever comes first']) expect(dl, t).toContain(t)
  const cnt = soakSentence('Soak deadline: count')
  for (const t of [
    'did not see the output',
    '(unsure and blocked reports in the journal)',
    "read the deploy time from deploy's report",
  ])
    expect(cnt, t).toContain(t)
  const ok = soakSentence('At the deadline, if the rollout')
  for (const t of [
    'rollout is complete (ready, no restarts)',
    'logs are clean',
    'nothing regressed',
    'file one follow-up bead and report healthy',
  ])
    expect(ok, t).toContain(t)
  expect(prompt('soak')).not.toMatch(
    /(^|\. )[Aa]fter two unsure soaks in a row with the output still unseen, report blocked/,
  )
})

test('3w8o AC1b past the deadline an unclean rollout reports blocked with a Question', () => {
  const s = soakSentence('If the deadline has passed')
  for (const t of ['not complete or the logs are not clean', 'report blocked', 'its trigger', '`Question:`'])
    expect(s, t).toContain(t)
})

test('3w8o AC2 soak files one verify:live follow-up bead before healthy', () => {
  const p = prompt('soak')
  for (const t of [
    'bd list -l verify:live --status open',
    '-l verify:live --deps discovered-from:<bead>',
    'the output to see, its trigger and the release version',
    'ACn: not checked (not fired yet: filed <id>)',
  ])
    expect(p, t).toContain(t)
  expect(soakSentence('First run'), 'reuse').toContain('use an open bead that names this release')
  expect(soakSentence('Write `ACn'), 'id').toContain('and name the id in the close reason')
  const s = soakSentence('-l verify:live --deps')
  expect(s).toContain('no factory label')
  expect(s).not.toContain('--add-label factory')
  expect(s).not.toContain('-l factory')
  expect(p.indexOf("bd create 'verify live")).toBeLessThan(p.indexOf('bd close <bead>'))
  expect(s).toContain("bd create 'verify live: <output> (<release version>)'")
  expect(s).toContain('--body-file <path>')
  expect(s).toContain('(the file holds the output to see, its trigger and the release version)')
  expect(s).not.toContain('"')
  expect(soakSentence('Put each value in single quotes')).toContain("write each ' in it as '\\''")
})

test('3w8o AC3 must-see-live changes keep the block', () => {
  const p = prompt('soak')
  const cls = soakSentence('Must-see-live:')
  for (const t of [
    'the bead or the plan is security-sensitive',
    'data or schema migration',
    'plan marks an AC must-see-live',
    'a bead comment starts `review#<n> security:`, `check#<n> security:` or `security#<n>`',
  ])
    expect(cls, t).toContain(t)
  expect(soakSentence('If you cannot tell')).toBe('If you cannot tell, the change is must-see-live.')
  const s = soakSentence('the deadline never applies')
  for (const t of ['report blocked', '`Question:`', 'two unsure soaks in a row']) expect(s, t).toContain(t)
  expect(p).toContain('at most twice in a row for a must-see-live change')
})

test('3w8o AC3b any other change reports unsure until the deadline, not blocked', () => {
  const fired = soakSentence('If the change has not fired yet')
  expect(fired).toContain('report unsure')
  expect(fired).not.toContain('report healthy')
  const s = soakSentence('For any other change, report')
  expect(s).toContain('report unsure until the deadline')
  expect(s).not.toContain('report blocked')
  expect(prompt('soak')).toContain('for any other change, until the soak deadline)')
})

test('3w8o AC4 only soak carries the deadline rule', () => {
  for (const id of ['deploy', 'queue', 'release', 'rollback', 'postmortem']) {
    expect(prompt(id), id).not.toContain('verify:live')
    expect(prompt(id), id).not.toContain('Soak deadline')
  }
  for (const [id, node] of Object.entries(lifecycle.nodes))
    expect((node as { prompt?: string }).prompt ?? '', id).not.toContain('verify:live')
  for (const [id, node] of Object.entries(release.nodes))
    if (id !== 'soak') expect((node as { prompt?: string }).prompt ?? '', id).not.toContain('verify:live')
})

test('3w8o AC5 four unsure soaks then healthy need no machine change', () => {
  // green on origin/main too: pins that the prompt rule needs no machine change
  const { visited } = walk(ship, ['ready', 'ready', 'deployed', 'unsure', 'unsure', 'unsure', 'healthy'])
  expect(visited.slice(3)).toEqual(['soak', 'soak', 'soak', 'soak', 'queue'])
})

test('geo6 AC1 deadline evidence', () => {
  for (const sentence of [
    'Put the version, rollout UTC time or its absence, current-inclusive count, and unseen outputs first in every soak report.',
    'For this version since its latest rollout, count prior unsure and blocked soak reports with unseen output, plus this soak once.',
    'Do not count other versions, pre-rollout reports, worker launches, or retries without reports.',
    'The deadline is the fourth such soak or 24 hours after rollout, whichever comes first.',
    'Count 3 before 24 hours stays unsure; count 4 qualifies; exactly 24 hours qualifies at count 1.',
    "Use the rollout report's UTC completion time for this version across all target environments.",
    'Never use cut, merge, or restart time.',
    'Absent, future, or invalid time disables only the time arm; count 4 still qualifies with complete count evidence.',
    'Unknown count cannot satisfy the count arm.',
    'Briefs retain 25 entries and clip summaries to 1500 characters.',
    'Read full history or source bead comments when the brief lacks required evidence.',
  ])
    expect(release.nodes.soak.prompt).toContain(sentence)
})

test('geo6 AC2 risk exceptions', () => {
  for (const sentence of [
    'Classify the whole release from all constituent plans, beads, and review comments.',
    'Only known ordinary risk permits the deadline exception.',
    'Any exceptional constituent denies the exception for the whole release.',
    'A security-sensitive plan or bead makes the release must-see-live.',
    'A data migration makes the release must-see-live.',
    'A schema migration makes the release must-see-live.',
    'An explicit must-see-live AC makes the release must-see-live.',
    'Unknown risk makes the release must-see-live.',
    'A bead comment with a review#<n> security:, check#<n> security:, or security#<n> prefix makes the release must-see-live.',
    'For must-see-live releases, the deadline never applies, even at count 4 or age 24 hours.',
    'After two consecutive unsure soaks with unseen output, including this soak, report blocked with the output, trigger, and a `Question:` line.',
    'For ordinary releases with unseen output, report unsure before the deadline.',
  ])
    expect(release.nodes.soak.prompt).toContain(sentence)
})

test('geo6 AC3 health gate', () => {
  for (const sentence of [
    'Healthy requires own output on the live system unless every deadline exception requirement below holds.',
    'Actual regression always reports regressed to rollback before any deadline exception.',
    'Observed own output retains the normal health path against the baseline.',
    'Deadline-based healthy requires complete rollout in all target environments.',
    'Deadline-based healthy requires the expected version in all target environments.',
    'Deadline-based healthy requires ready targets.',
    'Deadline-based healthy requires no restarts.',
    'Deadline-based healthy requires clean logs.',
    'Deadline-based healthy requires no regression against the baseline.',
    'Absent baseline, unreadable checks, or denied reads prevent healthy; never infer clean health.',
    'At the deadline, incomplete or unknown health reports blocked with evidence and a `Question:` line.',
    'The deadline grants no live access or owner approval.',
    'At the deadline, report healthy with unseen output only after all risk, health, and durable follow-up requirements hold.',
  ])
    expect(release.nodes.soak.prompt).toContain(sentence)
})

test('geo6 AC4 durable follow-up', () => {
  for (const sentence of [
    'Before deadline-based healthy, search `bd list -l verify:live --status open,in_progress,blocked` and read candidate bodies.',
    'Reuse one active bead only when the source release bead matches.',
    'Reuse requires the same release version.',
    'Reuse requires all unseen outputs.',
    'Reuse requires all their triggers.',
    'Reuse requires all target environments.',
    'Closed beads, another source with the same version, or absent outputs do not qualify.',
    "If no match exists, run `bd create 'verify live release output' -t task -p 2 -l verify:live --deps discovered-from:<source bead> --body-file <path>`.",
    'Add no factory or dispatch labels.',
    'The body lists the source bead, version, all unseen outputs, triggers, environments, and deferred checks.',
    'Use --body-file and a plain-word, shell-safe single-quoted title; never interpolate untrusted text into commands.',
    'Confirm the saved bead with `bd show <id>`.',
    'Failed search blocks healthy.',
    'Failed read blocks healthy.',
    'Failed create blocks healthy.',
    'Failed comment blocks healthy.',
    'Absent source bead blocks healthy with a question for the manager.',
    'Before healthy, record the confirmed follow-up ID in the source bead comment.',
    'Before healthy, record the confirmed follow-up ID in the soak summary.',
    'Both records must also name version, rollout time or absence, current-inclusive count, deadline arm, risk, health, outputs, and triggers.',
    'Each deferred check says `not checked (not fired yet: filed <id>)`, never passed.',
    'On retry, inspect this evidence and reuse the qualifying follow-up.',
  ])
    expect(release.nodes.soak.prompt).toContain(sentence)
  expect(release.nodes.soak.prompt).not.toContain('AC ledger')
  expect(release.nodes.soak.prompt).not.toContain('bd close')
})

test('geo6 AC5 scope and routes', () => {
  expect(() => compile(validate(release))).not.toThrow()
  expect(release.nodes.rollout.prompt).toContain(
    'For deployed and unsure reports, the time must be the UTC rollout completion time for this version across all target environments.',
  )
  for (const [id, node] of Object.entries(release.nodes)) {
    if (id !== 'soak') {
      expect(node.prompt, id).not.toContain('verify:live')
      expect(node.prompt, id).not.toContain('deadline exception')
    }
  }
  expect(release.nodes.soak.next).toEqual({
    healthy: 'done',
    unsure: { to: 'soak', delayMin: 15 },
    regressed: 'rollback',
  })
  expect(walk(release, ['unsure', 'unsure', 'unsure', 'healthy'], 'soak').visited).toEqual([
    'soak',
    'soak',
    'soak',
    'soak',
    'done',
  ])
  expect(walk(release, ['regressed'], 'soak').visited).toEqual(['soak', 'rollback'])
  expect(release.nodes.soak.runner).toBe('herdr')
  expect(release.nodes.soak.timeoutMin).toBe(30)
})
