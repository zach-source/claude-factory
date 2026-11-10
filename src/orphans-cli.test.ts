// The orphan pass through `factory beads` (claude-factory-pff5.4). A fake gh lists one green draft PR on
// the branch of an aborted run. Pass 1 forks it to review. Pass 2 forks nothing. A new head SHA forks again.
import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const root = join(realpathSync(tmpdir()), `orphans-cli-${process.pid}`)
const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const URL = 'https://github.com/acme/widget/pull/7'
// each test has its own dir: a detached beads pass that `start` or `abort` kicks may outlive the test
let dir = ''
let count = 0
const home = () => join(dir, 'home')
const bin = () => join(dir, 'bin')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home(),
      FACTORY_REPAIRS_LOG: join(home(), 'repairs.jsonl'),
      FACTORY_NO_KICK: '1',
      PATH: `${bin()}:${laptop.PATH}`,
      FACTORY_HERDR: join(bin(), 'herdr'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
      FACTORY_SELF_UPDATE: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
    },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

const script = (name: string, lines: string[]) => {
  writeFileSync(join(bin(), name), ['#!/bin/sh', ...lines].join('\n'))
  chmodSync(join(bin(), name), 0o755)
}

/** wait until no detached beads pass holds the lock, so a pass under test is the only one */
const settle = () => {
  for (let i = 0; i < 100 && existsSync(join(home(), 'beads.lock')); i++) Bun.sleepSync(100)
}

/** a rig with a GitHub origin and one aborted run (the orphan's source); returns the run id */
function setup(origin = 'https://github.com/acme/widget.git') {
  dir = join(root, String(count++))
  mkdirSync(bin(), { recursive: true })
  mkdirSync(join(dir, 'claude-config'), { recursive: true })
  writeFileSync(join(dir, 'claude-config', '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home(), { recursive: true })
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.beads'), { recursive: true })
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a])
  git('init', '-q')
  git('remote', 'add', 'origin', origin)
  git('commit', '--allow-empty', '-q', '-m', 'init')
  script('bd', [
    'case "$1" in',
    "  config) printf '%s' 'acme';;",
    `  show) printf '%s' '[{"id":"acme-1","title":"t","status":"open"}]';;`,
    '  create) echo acme-fork;;',
    "  ready|list|children) printf '%s' '[]';;",
    '  *) exit 0;;',
    'esac',
  ])
  script('herdr', [
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${join(dir, 'wt')}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ])
  script('gh', ['exit 1'])
  const def = join(dir, 'tiny.json')
  writeFileSync(
    def,
    JSON.stringify({
      name: 'tiny',
      start: 'work',
      nodes: {
        work: { prompt: 'Do it.', next: { ok: 'review' } },
        review: { prompt: 'Review it.', next: { ok: 'done' } },
      },
    }),
  )
  writeFileSync(join(home(), 'rigs.json'), JSON.stringify([{ name: 'a', repo, factory: def }]))
  writeFileSync(join(home(), 'labels.stamp'), '')
  expect(factory(['start', def, repo, 'acme-1']).code).toBe(0)
  const src = readdirSync(join(home(), 'runs'))[0]!
  expect(factory(['abort', src]).code).toBe(0)
  expect(factory(['tick']).code).toBe(0) // the tick applies the ABORT
  settle()
  return src
}

/** a fake gh: the open pulls hold one green draft on the source run's branch, at the head in sha.txt */
function fakeGh(src: string, sha: string) {
  writeFileSync(join(dir, 'sha.txt'), sha)
  const pulls = JSON.stringify([
    {
      number: 7,
      html_url: URL,
      state: 'open',
      draft: true,
      head: { ref: `factory/${src}`, sha: 'SHA', repo: { full_name: 'acme/widget' } },
      base: { ref: 'main', repo: { full_name: 'acme/widget' } },
      labels: [],
    },
  ])
  script('gh', [
    'case "$*" in',
    `  *check-runs*) printf '%s' '{"check_runs":[{"status":"completed","conclusion":"success"}]}';;`,
    `  "api -X"*) echo "$*" >> "${join(dir, 'writes.txt')}";;`,
    `  *"pulls/7/reviews"*|*"issues/7/comments"*) printf '%s' '[]';;`,
    `  "api repos/acme/widget/pulls/7") printf '%s' '{"state":"open","draft":true,"mergeable":true,"head":{"sha":"x"}}';;`,
    `  *"/status"*) printf '%s' '{"statuses":[]}';;`,
    `  "api "*"state=open"*) printf '%s' '${pulls}' | sed "s/SHA/$(cat "${join(dir, 'sha.txt')}")/";;`,
    '  *) exit 0;;',
    'esac',
  ])
}

const runIds = () => readdirSync(join(home(), 'runs'))
const read = (name: string) => JSON.parse(readFileSync(join(home(), name), 'utf8'))
const pass = () => {
  rmSync(join(home(), 'orphans.stamp'), { force: true })
  expect(factory(['beads']).code).toBe(0)
  settle()
}

test('AC1, AC3, AC8, AC9: pass 1 forks the green orphan to review; pass 2 forks nothing; a new SHA forks again', () => {
  const src = setup()
  fakeGh(src, SHA1)
  pass()
  expect(runIds()).toHaveLength(2)
  const rec = read('orphan-forks.json')[URL]
  expect(rec).toMatchObject({ sha: SHA1, from: src })
  expect(rec.run).toBe(runIds().find(id => id !== src))
  factory(['tick']) // the next tick applies the fork's GOTO and MAIL
  const forked = read(`runs/${rec.run}/state.json`).snapshot
  expect(JSON.stringify(forked.value)).toContain('review')
  const mail = forked.context.mail.review
  expect(mail.map((m: { from: string }) => m.from)).toEqual(['factory'])
  expect(mail[0].text).toContain(SHA1)
  expect(mail[0].text).toContain(URL)
  expect(read('orphans.json')).toEqual([])

  pass()
  expect(runIds()).toHaveLength(2)

  // the first fork is live: abort it, so the new head has no live owner
  for (const id of runIds()) factory(['abort', id])
  factory(['tick'])
  settle()
  fakeGh(src, SHA2)
  pass()
  expect(runIds()).toHaveLength(3)
  expect(read('orphan-forks.json')[URL].sha).toBe(SHA2)
})

test('AC9: an unreadable orphan-forks.json forks nothing and shows an error row; a fresh stamp skips the pass', () => {
  const src = setup()
  fakeGh(src, SHA1)
  writeFileSync(join(home(), 'orphan-forks.json'), '{not json')
  pass()
  expect(runIds()).toHaveLength(1)
  expect(read('orphans.json')[0].error).toContain('orphan-forks.json is unreadable')
  writeFileSync(join(home(), 'orphan-forks.json'), '{}')
  expect(factory(['beads']).code).toBe(0) // orphans.stamp from the last pass is fresh
  settle()
  expect(runIds()).toHaveLength(1)
})

test('a failed fork shows an error row with the URL, and a second pass forks nothing', () => {
  const src = setup()
  fakeGh(src, SHA1)
  // the source factory loses its review station, so the fork fails
  writeFileSync(
    join(home(), 'runs', src, 'factory.json'),
    JSON.stringify({
      name: 'tiny',
      start: 'work',
      nodes: { work: { prompt: 'Do it.', next: { ok: 'done' } } },
    }),
  )
  pass()
  expect(runIds()).toHaveLength(1)
  const rows = read('orphans.json')
  expect(rows).toHaveLength(1)
  expect(rows[0].error).toContain(URL)
  expect(rows[0].error).toContain('fork failed')
  pass()
  expect(runIds()).toHaveLength(1)
  expect(read('orphans.json')).toHaveLength(1)
})

test('a failed orphan-forks.json write shows a record failed row, not the generic fork failed row', () => {
  const src = setup()
  fakeGh(src, SHA1)
  mkdirSync(join(home(), 'orphan-forks.json.tmp')) // the atomic write cannot open its temp file
  pass()
  expect(runIds()).toHaveLength(1)
  const rows = read('orphans.json')
  expect(rows).toHaveLength(1)
  expect(rows[0].error).toContain(URL)
  expect(rows[0].error).toContain('record failed')
  expect(rows[0].error).not.toContain('fork failed or not recorded')
})

test('failed-fork rows match by exact URL: pull/37 and pull/378 each get a row', () => {
  const src = setup()
  const base = 'https://github.com/acme/widget/pull/'
  const pull = (n: number) => ({
    number: n,
    html_url: `${base}${n}`,
    state: 'open',
    draft: true,
    head: { ref: `factory/${src}`, sha: SHA1, repo: { full_name: 'acme/widget' } },
    base: { ref: 'main', repo: { full_name: 'acme/widget' } },
    labels: [],
  })
  // the longer URL comes first: a substring match on it would hide the row for pull/37
  writeFileSync(join(dir, 'pulls.json'), JSON.stringify([pull(378), pull(37)]))
  script('gh', [
    'case "$*" in',
    `  "api "*"state=open"*) cat "${join(dir, 'pulls.json')}";;`,
    '  *) exit 0;;',
    'esac',
  ])
  const rec = (n: number) => [`${base}${n}`, { sha: SHA1, run: '', from: src, at: 'now' }]
  writeFileSync(join(home(), 'orphan-forks.json'), JSON.stringify(Object.fromEntries([rec(378), rec(37)])))
  pass()
  const rows = read('orphans.json')
  expect(rows).toHaveLength(2)
  expect(rows.map((r: { error: string }) => r.error).join('\n')).toContain(`${base}37:`)
})

test('a full rig keeps its failed-fork row and says to check for a review run', () => {
  const src = setup()
  fakeGh(src, SHA1)
  const rigs = JSON.parse(readFileSync(join(home(), 'rigs.json'), 'utf8'))
  rigs[0].maxRuns = 0
  writeFileSync(join(home(), 'rigs.json'), JSON.stringify(rigs))
  writeFileSync(
    join(home(), 'orphan-forks.json'),
    JSON.stringify({ [URL]: { sha: SHA1, run: '', from: src, at: 'now' } }),
  )
  pass()
  const rows = read('orphans.json')
  expect(rows).toHaveLength(1)
  expect(rows[0].error).toContain('fork failed or not recorded')
  expect(rows[0].error).toContain('check for a review run')
})

test('AC8: a stopped factory skips the pass; resume lets it fork', () => {
  const src = setup()
  fakeGh(src, SHA1)
  expect(factory(['stop']).code).toBe(0)
  pass()
  expect(runIds()).toHaveLength(1)
  expect(existsSync(join(home(), 'orphan-forks.json'))).toBe(false)
  expect(factory(['resume']).code).toBe(0)
  pass()
  expect(runIds()).toHaveLength(2)
})

const MR_URL = 'https://gitlab.com/acme/widget/-/merge_requests/7'
type MrOpts = {
  status?: string
  pipelineSha?: string
  draft?: boolean
  srcProject?: number
  branch?: string
  listExit?: number
  approval?: string
  approvalExit?: number
  detail?: string
  detailExit?: number
  mergeStatus?: string
  labels?: string[]
  following?: boolean
}

/** a fake glab: the opened MRs hold one draft on the source run's branch; every call is logged to glab.calls */
function fakeGlab(src: string, sha: string, o: MrOpts = {}) {
  const mr = {
    iid: 7,
    state: 'opened',
    web_url: MR_URL,
    sha,
    draft: o.draft ?? true,
    source_branch: o.branch ?? `factory/${src}`,
    target_branch: 'main',
    source_project_id: o.srcProject ?? 5,
    target_project_id: 5,
    head_pipeline: { sha: o.pipelineSha ?? sha, status: o.status ?? 'success' },
    detailed_merge_status: o.mergeStatus ?? 'draft_status',
    has_conflicts: false,
    labels: o.labels ?? [],
  }
  script('glab', [
    `echo "$*" >> "${join(dir, 'glab.calls')}"`,
    'case "$*" in',
    `  *merge_requests?state=opened*) ${o.listExit ? `exit ${o.listExit}` : `printf '%s' '${JSON.stringify(o.following ? [mr, { ...mr, iid: 8, web_url: MR_URL.replace('/7', '/8') }] : [mr])}'`};;`,
    `  "api --hostname gitlab.com projects/acme%2Fwidget/merge_requests/7/approvals") ${o.approvalExit ? `exit ${o.approvalExit}` : `printf '%s' '${o.approval ?? '{"approved":false}'}'`};;`,
    `  "api --hostname gitlab.com projects/acme%2Fwidget/merge_requests/7") ${o.detailExit ? `exit ${o.detailExit}` : `printf '%s' '${o.detail ?? JSON.stringify(mr)}'`};;`,
    `  "api --hostname gitlab.com projects/acme%2Fwidget/merge_requests/8/approvals") printf '%s' '{"approved":false}';;`,
    `  "api --hostname gitlab.com projects/acme%2Fwidget/merge_requests/8") printf '%s' '${JSON.stringify(mr)}';;`,
    '  "mr update"*|"mr note"*|"mr close"*) exit 0;;',
    '  *) exit 1;;',
    'esac',
  ])
  script('gh', [`touch "${join(dir, 'gh.marker')}"`, 'exit 1'])
}

test('AC5, AC9: a GitLab rig forks the green draft MR once, with glab only on its own host', () => {
  const src = setup('https://gitlab.com/acme/widget.git')
  fakeGlab(src, SHA1)
  pass()
  expect(runIds()).toHaveLength(2)
  expect(read('orphan-forks.json')[MR_URL]).toMatchObject({ sha: SHA1, from: src })
  factory(['tick'])
  const rec = read('orphan-forks.json')[MR_URL]
  const mail = read(`runs/${rec.run}/state.json`).snapshot.context.mail.review
  expect(mail.map((m: { from: string }) => m.from)).toEqual(['factory'])
  expect(mail[0].text).toContain(SHA1)
  expect(mail[0].text).toContain(MR_URL)
  expect(read('orphans.json')).toEqual([])
  const calls = readFileSync(join(dir, 'glab.calls'), 'utf8').trim().split('\n')
  expect(calls.length).toBeGreaterThan(1)
  for (const c of calls) expect(c).toContain('--hostname gitlab.com')
  pass()
  expect(runIds()).toHaveLength(2)
  expect(existsSync(join(dir, 'gh.marker'))).toBe(false)
})

function closedBead(status: string, reason = '') {
  script('bd', [
    'case "$1" in',
    "  config) printf '%s' 'acme';;",
    `  show) printf '%s' '${JSON.stringify([{ id: 'acme-1', title: 't', status, close_reason: reason }])}';;`,
    "  ready|list|children|human) printf '%s' '[]';;",
    '  *) exit 0;;',
    'esac',
  ])
}

const repairMr = (src: string, iid = 7) => ({
  iid,
  state: 'opened',
  web_url: `https://gitlab.com/acme/sub/widget/-/merge_requests/${iid}`,
  source_branch: `factory/${src}`,
})

function repairFixture(src: string, pages: { out: string; code?: number }[], otherRig = false) {
  const repo = join(dir, 'repo')
  expect(
    Bun.spawnSync([
      'git',
      '-C',
      repo,
      'remote',
      'set-url',
      'origin',
      'https://gitlab.com/acme/sub/widget.git',
    ]).exitCode,
  ).toBe(0)
  if (otherRig) {
    const other = join(dir, 'other')
    mkdirSync(join(other, '.beads'), { recursive: true })
    expect(Bun.spawnSync(['git', '-C', other, 'init', '-q']).exitCode).toBe(0)
    expect(
      Bun.spawnSync(['git', '-C', other, 'remote', 'add', 'origin', 'https://gitlab.com/acme/other.git'])
        .exitCode,
    ).toBe(0)
    const configured = read('rigs.json')
    configured.push({ ...configured[0], name: 'b', repo: other })
    writeFileSync(join(home(), 'rigs.json'), JSON.stringify(configured))
  }
  const all = [
    { id: 'acme-1', title: 'parent', status: 'open' },
    { id: 'acme-1.1', title: 'child', status: 'closed', parent: 'acme-1' },
  ]
  script('bd', [
    `echo "$*" >> "${join(dir, 'bd.calls')}"`,
    'case "$*" in',
    `  "list --all --brief --json -n 0"*) printf '%s' '${JSON.stringify(all)}';;`,
    `  "show "*) printf '%s' '${JSON.stringify([all[0]])}';;`,
    "  config*) printf '%s' 'acme';;",
    "  *) printf '%s' '[]';;",
    'esac',
  ])
  script('glab', [
    `echo "$*" >> "${join(dir, 'glab.calls')}"`,
    'case "$*" in',
    `  "api --hostname gitlab.com projects/acme%2Fother/merge_requests?state=opened&per_page=100&page=1") printf '%s' '[]';;`,
    ...pages.map(
      (page, i) =>
        `  "api --hostname gitlab.com projects/acme%2Fsub%2Fwidget/merge_requests?state=opened&per_page=100&page=${i + 1}") ${page.code ? `exit ${page.code}` : `printf '%s' '${page.out}'`};;`,
    ),
    "  *labels=*) printf '%s' '[]';;",
    '  *) exit 1;;',
    'esac',
  ])
  script('gh', [`touch "${join(dir, 'gh.marker')}"`, 'exit 1'])
  writeFileSync(join(home(), 'orphans.stamp'), '')
  rmSync(join(home(), 'labels.stamp'), { force: true })
}

for (const draft of [true, false])
  test(`6r645 AC1: GitLab MR draft=${draft} on a later page holds the repair parent`, () => {
    const src = setup('https://gitlab.com/acme/widget.git')
    const first = Array.from({ length: 100 }, (_, i) => repairMr('unknown', i + 10))
    repairFixture(src, [
      { out: JSON.stringify(first) },
      { out: JSON.stringify([{ ...repairMr(src), draft }]) },
    ])
    pass()
    expect(readFileSync(join(dir, 'bd.calls'), 'utf8')).not.toContain('close acme-1')
    const calls = readFileSync(join(dir, 'glab.calls'), 'utf8')
    expect(calls).toContain('state=opened&per_page=100&page=1')
    expect(calls).toContain('state=opened&per_page=100&page=2')
    expect(calls).not.toContain('/approvals')
    expect(existsSync(join(dir, 'gh.marker'))).toBe(false)
  })

const badLists = [
  { out: '', code: 1 },
  ...[
    '{',
    'null',
    '{}',
    'false',
    '[null]',
    ...[
      { iid: 0 },
      { iid: 1.5 },
      { iid: '7' },
      { web_url: '' },
      { web_url: 'https://gitlab.com/other/widget/-/merge_requests/7' },
      { web_url: 'https://other.gitlab.com/acme/sub/widget/-/merge_requests/7' },
      { web_url: 'https://gitlab.com/acme/sub/widget/-/merge_requests/8' },
      { source_branch: '' },
      { source_branch: 1 },
      { state: 'merged' },
    ].map(over => JSON.stringify([{ ...repairMr('unknown'), ...over }])),
  ].map(out => ({ out })),
]
for (const [index, bad] of badLists.entries())
  test(`6r645 AC2: invalid GitLab list ${index} prevents repair effects`, () => {
    const src = setup('https://gitlab.com/acme/widget.git')
    repairFixture(src, [
      { out: JSON.stringify(Array.from({ length: 100 }, (_, i) => repairMr('unknown', i + 10))) },
      bad,
    ])
    pass()
    expect(readFileSync(join(dir, 'bd.calls'), 'utf8')).not.toContain('close acme-1')
    expect(existsSync(join(dir, 'gh.marker'))).toBe(false)
  })

test('6r645 AC2: a valid empty GitLab list permits the normal parent repair', () => {
  const src = setup('https://gitlab.com/acme/widget.git')
  repairFixture(src, [{ out: '[]' }])
  pass()
  expect(readFileSync(join(dir, 'bd.calls'), 'utf8')).toContain('close acme-1')
})

test('6r645 AC2: an unreadable rig does not stop a valid rig repair', () => {
  const src = setup('https://gitlab.com/acme/widget.git')
  repairFixture(src, [{ out: '{' }], true)
  pass()
  const calls = readFileSync(join(dir, 'bd.calls'), 'utf8')
  expect(calls.match(/close acme-1 /g)).toHaveLength(1)
  const log = readFileSync(join(home(), 'repairs.jsonl'), 'utf8')
  expect(log).toContain('"rig":"b"')
  expect(log).not.toContain('"rig":"a"')
})

for (const status of ['closed', 'deferred']) {
  for (const labels of [[], ['owner']]) {
    test(`6r645 AC3: approved GitLab ${status} bead holds with labels ${labels}`, () => {
      const src = setup('https://gitlab.com/acme/widget.git')
      closedBead(status)
      fakeGlab(src, SHA1, { approval: '{"approved":true}', mergeStatus: 'requested_changes', labels })
      pass()
      const calls = readFileSync(join(dir, 'glab.calls'), 'utf8')
      expect(calls).toContain('api --hostname gitlab.com projects/acme%2Fwidget/merge_requests/7/approvals')
      expect(calls).not.toContain('mr close')
      expect(calls.includes('mr update 7 --label owner')).toBe(labels.length === 0)
      expect(runIds()).toHaveLength(1)
      expect(read('orphans.json')[0].error).toContain('held for the person: approved')
      expect(existsSync(join(dir, 'gh.marker'))).toBe(false)
    })
  }
  test(`6r645 AC3: unapproved GitLab ${status} bead permits the close`, () => {
    const src = setup('https://gitlab.com/acme/widget.git')
    closedBead(status)
    fakeGlab(src, SHA1)
    pass()
    expect(readFileSync(join(dir, 'glab.calls'), 'utf8')).toContain('mr close 7')
    expect(runIds()).toHaveLength(1)
  })
}

test('6r645 AC3: automatic parent close holds without an approval read', () => {
  const src = setup('https://gitlab.com/acme/widget.git')
  closedBead('closed', 'every child is closed')
  fakeGlab(src, SHA1)
  pass()
  const calls = readFileSync(join(dir, 'glab.calls'), 'utf8')
  expect(calls).not.toContain('/approvals')
  expect(calls).not.toContain('mr close')
  expect(read('orphans.json')[0].error).toContain('held for the person: every child is closed')
})

const unreadableViews: MrOpts[] = [
  { detailExit: 1 },
  { detail: '{' },
  { detail: 'null' },
  { detail: '[]' },
  { approvalExit: 1 },
  ...['{', 'null', '[]', 'false', '{}', ...['"false"', '"true"', '0', '1'].map(v => `{"approved":${v}}`)].map(
    approval => ({ approval }),
  ),
]
for (const [index, opts] of unreadableViews.entries())
  test(`6r645 AC4: unreadable GitLab view ${index} permits no effect`, () => {
    const src = setup('https://gitlab.com/acme/widget.git')
    closedBead('closed')
    fakeGlab(src, SHA1, { ...opts, following: true })
    pass()
    const calls = readFileSync(join(dir, 'glab.calls'), 'utf8')
    expect(calls).not.toContain('mr close 7')
    expect(calls).toContain('mr close 8')
    expect(calls).not.toContain('mr update')
    expect(runIds()).toHaveLength(1)
    expect(existsSync(join(home(), 'orphan-forks.json'))).toBe(false)
  })

test('AC6: a GitLab MR that is not green, not a draft, from a fork or off factory/ forks nothing', () => {
  const rows: (MrOpts | ((src: string) => MrOpts))[] = [
    { status: 'failed' },
    { status: 'running' },
    { pipelineSha: SHA2 },
    { draft: false },
    { srcProject: 9 },
    src => ({ branch: `feat/${src}` }),
  ]
  for (const row of rows) {
    const src = setup('https://gitlab.com/acme/widget.git')
    fakeGlab(src, SHA1, typeof row === 'function' ? row(src) : row)
    pass()
    expect(runIds()).toHaveLength(1)
  }
})

test('AC7: a failed glab listing shows one error row and makes no checks call', () => {
  const src = setup('https://gitlab.com/acme/widget.git')
  fakeGlab(src, SHA1, { listExit: 1 })
  pass()
  expect(runIds()).toHaveLength(1)
  expect(read('orphans.json')).toEqual([{ id: 'rig:a', error: 'orphans: glab api merge_requests failed' }])
  const calls = readFileSync(join(dir, 'glab.calls'), 'utf8').trim().split('\n')
  expect(calls.filter(c => c.includes('merge_requests/7'))).toEqual([])
})

test('AC8: a rig with neither a GitHub nor a GitLab origin is skipped without any forge call', () => {
  const src = setup('https://example.com/acme/widget.git')
  fakeGlab(src, SHA1)
  script('gh', [`touch "${join(dir, 'gh.marker')}"`, 'exit 1'])
  pass()
  expect(runIds()).toHaveLength(1)
  expect(read('orphans.json')).toEqual([])
  expect(existsSync(join(dir, 'gh.marker'))).toBe(false)
  // glab auth status only tells the forge of a host; no API call may follow
  expect(readFileSync(join(dir, 'glab.calls'), 'utf8')).not.toContain('api')
})

test('e2xe: a closed bead closes the orphan draft with a comment; the PR gets no fork', () => {
  const src = setup()
  fakeGh(src, SHA1)
  script('bd', [
    'case "$1" in',
    "  config) printf '%s' 'acme';;",
    `  show) printf '%s' '[{"id":"acme-1","title":"t","status":"closed"}]';;`,
    "  ready|list|children) printf '%s' '[]';;",
    '  *) exit 0;;',
    'esac',
  ])
  pass()
  expect(runIds()).toHaveLength(1)
  const writes = readFileSync(join(dir, 'writes.txt'), 'utf8')
  expect(writes).toContain('issues/7/comments')
  expect(writes).toContain(src)
  expect(writes).toContain('pulls/7 -f state=closed')
})
