// `factory wiki write` end to end (claude-factory-tx6c.7). Every test spawns bin/factory with a new temp
// FACTORY_HOME and fake `bd`, `gh` and agent programs first on PATH, so nothing reaches a live service.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(realpathSync(tmpdir()), `wiki-write-${process.pid}`)
const slow = (name: string, fn: () => void) => test(name, fn, 60_000)
let n = 0
let home = ''
let data = ''
let repo = ''

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const key = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_')

/** a new home, one rig `acme` on github.com/acme/widget with a .beads dir, a wiki, and the three fakes */
function setup() {
  home = join(dir, `home${++n}`)
  data = join(dir, `data${n}`)
  repo = join(dir, `repo${n}`)
  const bin = join(dir, `bin${n}`)
  for (const d of [home, data, repo, bin, join(data, 'pages')]) mkdirSync(d, { recursive: true })
  mkdirSync(join(repo, '.beads'))
  Bun.spawnSync(['git', '-C', repo, 'init', '-q'])
  Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git'])
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'acme', repo, factory: join(dir, 'f.ts') }]))
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`)
    chmodSync(join(bin, name), 0o755)
  }
  fake(
    'bd',
    `prev=''
for a in "$@"; do
  if [ "$prev" = show ]; then cat '${data}/bead-'"$a"'.json' 2>/dev/null || echo null; exit 0; fi
  if [ "$prev" = comments ]; then echo '[]'; exit 0; fi
  [ "$a" = list ] && { cat '${data}/list.json'; exit 0; }
  prev="$a"
done
echo null
`,
  )
  fake(
    'gh',
    `if [ "$1" = repo ]; then echo PRIVATE; exit 0; fi
echo "$*" >> '${data}/gh-calls'
f='${data}/gh-'$(printf '%s' "$2" | sed 's/[^A-Za-z0-9]/_/g')
if [ -f "$f" ]; then cat "$f"; else echo 'not found' >&2; exit 1; fi
`,
  )
  const agent = `echo "$PWD" > '${data}/agent-cwd'
echo "$*" > '${data}/agent-args'
echo "$CODEX_HOME" > '${data}/agent-codexhome'
[ -f '${home}/wiki-write.stamp' ] && echo yes > '${data}/agent-stamp'
cat > '${data}/agent-prompt'
printf '%s\\n' "$@" > '${data}/agent-argv'
env > '${data}/agent-env'
echo x >> '${data}/agent-runs'
if [ -f '${data}/agent-hang' ]; then exec sleep 30; fi
if [ -f '${data}/agent-commit' ]; then git -c user.name=x -c user.email=x@example.com commit --allow-empty -qm moved; fi
if [ -f '${data}/agent-exit' ]; then echo failed >&2; exit 3; fi
if [ -f '${data}/agent-edit' ]; then sed -i 's/Text\\./Changed./' solutions/2026-10/person.md; fi
for f in '${data}'/pages/solutions/*/*.md; do
  id=$(basename "$f" .md | sed 's/^fix-//')
  if grep -q "\\"id\\": \\"$id\\"" '${data}/agent-prompt'; then
    mkdir -p "solutions/$(basename "$(dirname "$f")")"
    cp "$f" "solutions/$(basename "$(dirname "$f")")/"
  fi
done
`
  fake('agent', agent)
  fake('codex', agent)
  const env = { ...process.env, FACTORY_HOME: home }
  expect(
    Bun.spawnSync([CLI, 'wiki', 'init'], { env: { ...env, FACTORY_NO_KICK: '1', FACTORY_SELF_UPDATE: '0' } })
      .exitCode,
  ).toBe(0)
  return bin
}

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_WIKI_REMOTE, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${join(dir, `bin${n}`)}:${laptop.PATH}`,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_NO_KICK: '1',
      FACTORY_CLAUDE: join(dir, `bin${n}`, 'agent'),
      ...env,
    },
    timeout: 50_000,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const wiki = () => join(home, 'wiki')
const git = (...args: string[]) => {
  const p = Bun.spawnSync(['git', '-C', wiki(), ...args])
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}
const state = () =>
  existsSync(join(home, 'wiki-state.json'))
    ? JSON.parse(readFileSync(join(home, 'wiki-state.json'), 'utf8'))
    : {}
const runs = () =>
  existsSync(join(data, 'agent-runs'))
    ? readFileSync(join(data, 'agent-runs'), 'utf8').split('\n').length - 1
    : 0
const prompt = () => readFileSync(join(data, 'agent-prompt'), 'utf8')
const wikiLog = () => (existsSync(join(home, 'wiki.log')) ? readFileSync(join(home, 'wiki.log'), 'utf8') : '')

const closed = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Fix ${id}`,
  status: 'closed',
  close_reason: 'done',
  closed_at: new Date().toISOString(),
  ...extra,
})
const pr = (num: number, title: string, files: string[], merged = true) => {
  writeFileSync(
    join(data, `gh-${key(`repos/acme/widget/pulls/${num}`)}`),
    JSON.stringify({
      number: num,
      html_url: `https://github.com/acme/widget/pull/${num}`,
      title,
      body: 'body',
      state: 'closed',
      merged_at: merged ? '2026-11-01T00:00:00Z' : null,
    }),
  )
  writeFileSync(
    join(data, `gh-${key(`repos/acme/widget/pulls/${num}/files?per_page=100`)}`),
    JSON.stringify(files.map(filename => ({ filename }))),
  )
  return {
    number: num,
    html_url: `https://github.com/acme/widget/pull/${num}`,
    title,
    merged_at: '2026-11-01T00:00:00Z',
    head: { ref: `b${num}` },
    base: { ref: 'main' },
  }
}
/** list.json for closedSince, the bead files for show, and the closed-PR list the search reads */
function seed(beads: ReturnType<typeof closed>[], listed: unknown[] = []) {
  writeFileSync(join(data, 'list.json'), JSON.stringify(beads.map(b => ({ id: b.id, title: b.title }))))
  for (const b of beads) writeFileSync(join(data, `bead-${b.id}.json`), JSON.stringify([b]))
  writeFileSync(
    join(
      data,
      `gh-${key('repos/acme/widget/pulls?state=closed&sort=created&direction=desc&per_page=100&page=1')}`,
    ),
    JSON.stringify(listed),
  )
}
const SECTIONS = ['Problem', 'Cause', 'Change', 'Options rejected', 'Verification', 'Still open', 'Links']
const page = (bead: string, prUrl: string, sections = SECTIONS) =>
  `---\nkind: "solution"\ntitle: "Fix ${bead}"\nrigs: ["acme"]\ntopics: ["wiki"]\nbeads: ["${bead}"]\nprs: ["${prUrl}"]\ncause: "proven"\nstatus: "current"\nupdated: "2026-11-08T00:00:00Z"\n---\n# Fix ${bead}\n\n${sections.map(s => `## ${s}\n\nText.\n`).join('\n')}`
const stage = (path: string, text: string) => {
  mkdirSync(join(data, 'pages', path, '..'), { recursive: true })
  writeFileSync(join(data, 'pages', path), text)
}
const PR5 = 'https://github.com/acme/widget/pull/5'

/** acme-1 closed with a merged code PR named in ship_pr metadata */
function one() {
  setup()
  seed([closed('acme-1', { metadata: { ship_pr: PR5 } })])
  pr(5, 'acme-1: fix it', ['src/a.ts'])
  stage('solutions/2026-11/fix-acme-1.md', page('acme-1', PR5))
}

slow('write AC1 arguments and dry run', () => {
  one()
  for (const a of [
    ['--bogus'],
    ['--dry-run', '--dry-run'],
    ['--bead'],
    ['--bead', '--dry-run'],
    ['--bead', 'a b'],
    ['--bead', 'x', 'extra'],
    ['extra'],
    ['--bead', 'x', '--bead', 'y'],
  ]) {
    const r = factory(['wiki', 'write', ...a])
    expect([a, r.code]).toEqual([a, 2])
    expect(r.err).toContain('usage: factory wiki write [--dry-run] [--bead <id>]')
  }
  expect(runs()).toBe(0)
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.code).toBe(0)
  expect(r.out).toContain('acme-1')
  expect(r.out).toContain(PR5)
  expect(runs()).toBe(0)
  expect(existsSync(join(home, 'wiki-write.stamp'))).toBe(false)
  expect(state().written).toBeUndefined()
  expect(git('rev-list', '--count', 'HEAD')).toBe('1')
})

slow('write AC1 a held lock says busy and a missing wiki is not made', () => {
  one()
  mkdirSync(join(home, 'wiki.lock'))
  writeFileSync(join(home, 'wiki.lock', 'pid'), String(process.pid))
  expect(factory(['wiki', 'write']).out).toContain('wiki: busy')
  rmSync(join(home, 'wiki.lock'), { recursive: true })
  rmSync(wiki(), { recursive: true })
  expect(factory(['wiki', 'write']).out).toContain('wiki: not set up')
  expect(existsSync(wiki())).toBe(false)
})

slow('write AC3 AC4 AC7 a run commits a 7 section page, records it and does not write it twice', () => {
  one()
  const r = factory(['wiki', 'write'])
  expect(r.code).toBe(0)
  expect(r.out).toContain('wiki write: 1 pages from 1 beads; 0 waiting')
  expect(readFileSync(join(data, 'agent-cwd'), 'utf8').trim()).toBe(wiki())
  const args = readFileSync(join(data, 'agent-args'), 'utf8')
  expect(args).toContain('-p --permission-mode acceptEdits')
  expect(args).toContain('--allowedTools Read Write Edit Glob Grep Bash(git mv:*) Bash(git rm:*)')
  expect(prompt()).toContain('acme-1')
  expect(prompt()).toContain(PR5)
  expect(existsSync(join(home, 'wiki-write.stamp'))).toBe(true)
  expect(git('log', '-1', '--format=%s')).toStartWith('wiki write:')
  expect(Object.keys(state().written)).toEqual(['acme-1'])
  expect(typeof state().lastWriteAt).toBe('string')
  expect(runs()).toBe(1)
  factory(['wiki', 'write'])
  expect(runs()).toBe(1)
  // a lost state file does not make the agent write the committed page again
  rmSync(join(home, 'wiki-state.json'))
  factory(['wiki', 'write'])
  expect(runs()).toBe(1)
  expect(Object.keys(state().written ?? {})).toEqual(['acme-1'])
})

slow('write AC4 AC5 a failing page stays out of the commit and its bead stays eligible', () => {
  setup()
  seed([
    closed('acme-1', { metadata: { ship_pr: PR5 } }),
    closed('acme-2', { metadata: { ship_pr: 'https://github.com/acme/widget/pull/6' } }),
  ])
  pr(5, 'acme-1: fix it', ['src/a.ts'])
  pr(6, 'acme-2: fix it', ['src/b.ts'])
  stage('solutions/2026-11/fix-acme-1.md', page('acme-1', PR5))
  stage(
    'solutions/2026-11/fix-acme-2.md',
    page('acme-2', 'https://github.com/acme/widget/pull/6', SECTIONS.slice(0, 3)),
  )
  const before = state()
  factory(['wiki', 'write'])
  expect(Object.keys(state().written)).toEqual(['acme-1'])
  expect(git('ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('fix-acme-2')
  expect(wikiLog()).toContain('missing section')
  // the global timestamp stays back: acme-2 is not done
  expect(state().lastWriteAt).toBe(before.lastWriteAt)
  stage('solutions/2026-11/fix-acme-2.md', page('acme-2', 'https://github.com/acme/widget/pull/6'))
  factory(['wiki', 'write'])
  expect(Object.keys(state().written).sort()).toEqual(['acme-1', 'acme-2'])
  expect(typeof state().lastWriteAt).toBe('string')
})

slow('write AC2 a code PR and a docs release PR keep both links; docs only is skipped', () => {
  setup()
  seed(
    [closed('acme-3', { metadata: { ship_pr: PR5 } }), closed('acme-4')],
    [pr(7, 'acme-3 release notes', ['CHANGELOG.md']), pr(8, 'acme-4: docs', ['docs/a.md'])],
  )
  pr(5, 'acme-3: fix it', ['src/a.ts'])
  stage('solutions/2026-11/fix-acme-3.md', page('acme-3', PR5))
  const dry = factory(['wiki', 'write', '--dry-run'])
  expect(dry.out).toContain('acme-3')
  expect(dry.out).not.toContain('acme-4')
  factory(['wiki', 'write'])
  expect(prompt()).toContain(PR5)
  expect(prompt()).toContain('https://github.com/acme/widget/pull/7')
})

slow('write AC2 an unmerged PR in ship_pr and a foreign URL make no group', () => {
  setup()
  seed([
    closed('acme-1', { metadata: { ship_pr: PR5 } }),
    closed('acme-2', { metadata: { ship_pr: 'https://github.com/evil/widget/pull/1' } }),
  ])
  pr(5, 'acme-1: fix it', ['src/a.ts'], false)
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.out).not.toContain('acme-1')
  expect(r.out).not.toContain('acme-2')
  expect(r.out).toContain('1 waiting')
  const calls = readFileSync(join(data, 'gh-calls'), 'utf8')
  expect(calls).not.toContain('evil')
  expect(calls).not.toMatch(/pulls\/1$/m)
})

slow('write AC3 a failing agent keeps the stamp and commits and records nothing', () => {
  one()
  writeFileSync(join(data, 'agent-exit'), '')
  const r = factory(['wiki', 'write'])
  expect(r.out).toContain('agent failed')
  expect(existsSync(join(home, 'wiki-write.stamp'))).toBe(true)
  expect(git('rev-list', '--count', 'HEAD')).toBe('1')
  expect(state().written).toBeUndefined()
  expect(wikiLog()).toContain('wiki write: agent exit 3')
  expect(existsSync(join(home, 'wiki.lock'))).toBe(false)
})

slow('write AC2 a file list of 100 files may be cut off, so the bead waits', () => {
  setup()
  seed([closed('acme-1', { metadata: { ship_pr: PR5 } })])
  pr(
    5,
    'acme-1: fix it',
    Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`),
  )
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.out).not.toContain('group:')
  expect(r.out).toContain('1 waiting')
})

slow('write AC3 a bad codex model name makes no agent call', () => {
  one()
  const r = factory(['wiki', 'write'], { FACTORY_DREAM_CODEX: '-bad model' })
  expect(r.out + r.err).toContain('FACTORY_DREAM_CODEX is not a model name')
  expect(runs()).toBe(0)
})

slow('write AC5 21 groups with cap 20: 20 are written and the timestamp stays back', () => {
  setup()
  const beads = Array.from({ length: 21 }, (_, i) =>
    closed(`acme-${i + 1}`, { metadata: { ship_pr: `https://github.com/acme/widget/pull/${i + 10}` } }),
  )
  seed(beads)
  beads.forEach((b, i) => {
    pr(i + 10, `${b.id}: fix`, ['src/a.ts'])
    stage(`solutions/2026-11/fix-${b.id}.md`, page(b.id, `https://github.com/acme/widget/pull/${i + 10}`))
  })
  const dry = factory(['wiki', 'write', '--dry-run'], { FACTORY_WIKI_WRITE_CAP: '20' })
  expect(
    dry.out
      .trim()
      .split('\n')
      .filter(l => l.startsWith('group')).length,
  ).toBe(20)
  factory(['wiki', 'write'], { FACTORY_WIKI_WRITE_CAP: '20' })
  expect(Object.keys(state().written).length).toBe(20)
  expect(state().lastWriteAt).toBeUndefined()
  factory(['wiki', 'write'], { FACTORY_WIKI_WRITE_CAP: '20' })
  expect(Object.keys(state().written).length).toBe(21)
  expect(typeof state().lastWriteAt).toBe('string')
})

slow('write AC5 --bead selects one old bead and leaves lastWriteAt alone', () => {
  one()
  writeFileSync(
    join(home, 'wiki-state.json'),
    JSON.stringify({ lastWriteAt: '2030-01-01T00:00:00.000Z', keep: 1 }),
  )
  const r = factory(['wiki', 'write', '--bead', 'acme-1'])
  expect(r.out).toContain('1 pages')
  expect(state().lastWriteAt).toBe('2030-01-01T00:00:00.000Z')
  expect(state().keep).toBe(1)
  expect(Object.keys(state().written)).toEqual(['acme-1'])
})

slow('write AC7 the log holds no source secret', () => {
  setup()
  const secret = 'ghp_' + 'a'.repeat(36)
  seed([closed('acme-1', { metadata: { ship_pr: PR5 }, close_reason: `token ${secret}` })])
  pr(5, 'acme-1: fix it', ['src/a.ts'])
  factory(['wiki', 'write'])
  expect(prompt()).not.toContain(secret)
  expect(wikiLog()).not.toContain(secret)
})

slow('write AC3 the source bound defers groups and keeps the timestamp back', () => {
  setup()
  const beads = Array.from({ length: 40 }, (_, i) =>
    closed(`acme-${i + 1}`, {
      metadata: { ship_pr: `https://github.com/acme/widget/pull/${i + 10}` },
      close_reason: 'x'.repeat(9000),
    }),
  )
  seed(beads)
  beads.forEach((b, i) => pr(i + 10, `${b.id}: fix`, ['src/a.ts']))
  const r = factory(['wiki', 'write', '--dry-run'], { FACTORY_WIKI_WRITE_CAP: '100' })
  const groups = r.out.split('\n').filter(l => l.startsWith('group')).length
  expect(groups).toBeGreaterThan(0)
  expect(groups).toBeLessThan(40)
  expect(r.out).toContain(`${40 - groups} waiting`)
})

slow('write AC4 a change to a person line restores the page and adds a flag', () => {
  one()
  const person = page('acme-0', 'https://github.com/acme/widget/pull/4')
  mkdirSync(join(wiki(), 'solutions', '2026-10'), { recursive: true })
  writeFileSync(join(wiki(), 'solutions', '2026-10', 'person.md'), person)
  git('add', '-A')
  git('-c', 'user.name=person', '-c', 'user.email=person@example.com', 'commit', '-qm', 'person page')
  writeFileSync(join(data, 'agent-edit'), '')
  factory(['wiki', 'write'])
  expect(readFileSync(join(wiki(), 'solutions', '2026-10', 'person.md'), 'utf8')).toBe(person)
  expect(wikiLog()).toContain("person's line in solutions/2026-10/person.md")
  expect(git('ls-tree', '-r', '--name-only', 'HEAD')).toContain('needs-person.md')
})

slow('write AC5 a commit failure leaves progress unchanged and the next pass retries', () => {
  one()
  const hook = join(wiki(), '.git', 'hooks', 'pre-commit')
  mkdirSync(join(hook, '..'), { recursive: true })
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
  const r = factory(['wiki', 'write'])
  expect(r.out).toContain('commit failed')
  expect(state().written).toBeUndefined()
  expect(state().lastWriteAt).toBeUndefined()
  rmSync(hook)
  factory(['wiki', 'write'])
  expect(Object.keys(state().written)).toEqual(['acme-1'])
})

slow('write AC3 the stamp is written before the agent runs, and the agent gets settings', () => {
  one()
  factory(['wiki', 'write'])
  expect(existsSync(join(data, 'agent-stamp'))).toBe(true)
  expect(readFileSync(join(data, 'agent-args'), 'utf8')).toContain('--settings {')
})

slow('write AC3 a codex run uses the sandbox flags, the note and its own CODEX_HOME', () => {
  one()
  const codex = join(dir, `bin${n}`, 'codex')
  const r = factory(['wiki', 'write'], { FACTORY_DREAM_CODEX: 'gpt-x', FACTORY_CODEX: codex })
  expect(r.out).toContain('wiki write: 1 pages from 1 beads; 0 waiting')
  const args = readFileSync(join(data, 'agent-args'), 'utf8')
  expect(args).toContain('exec -s workspace-write -c approval_policy="never"')
  expect(args).toContain('sandbox_workspace_write.network_access=false')
  expect(args).toContain(`-C ${wiki()} -m gpt-x -`)
  expect(readFileSync(join(data, 'agent-codexhome'), 'utf8').trim()).toBe(join(home, 'codex-wiki'))
  expect(prompt()).toContain('git mv and git rm fail')
  expect(Object.keys(state().written)).toEqual(['acme-1'])
})

slow('write AC3 the claude run gets the exact settings and tool list', () => {
  one()
  factory(['wiki', 'write'])
  const argv = readFileSync(join(data, 'agent-argv'), 'utf8').split('\n')
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!)
  expect(settings.permissions).toEqual({ deny: ['Edit(./.git/**)'] })
  expect(settings.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
  expect(argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--allowedTools') + 8)).toEqual([
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'Bash(git mv:*)',
    'Bash(git rm:*)',
  ])
})

slow('write AC3 a codex run keeps only the allowed env and both tmp exclusions', () => {
  one()
  const codex = join(dir, `bin${n}`, 'codex')
  factory(['wiki', 'write'], {
    FACTORY_DREAM_CODEX: 'gpt-x',
    FACTORY_CODEX: codex,
    GITHUB_TOKEN: 'zqsecret',
  })
  const argv = readFileSync(join(data, 'agent-argv'), 'utf8')
  expect(argv).toContain('sandbox_workspace_write.exclude_slash_tmp=true')
  expect(argv).toContain('sandbox_workspace_write.exclude_tmpdir_env_var=true')
  const keys = readFileSync(join(data, 'agent-env'), 'utf8')
    .split('\n')
    .map(l => l.split('=')[0])
    .filter(k => k && !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k))
  expect(keys.sort()).toEqual(
    ['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TERM'].filter(k => k === 'CODEX_HOME' || keys.includes(k)).sort(),
  )
  expect(keys).not.toContain('GITHUB_TOKEN')
})

slow('write AC3 a timed out agent leaves the stamp, frees the lock, commits and records nothing', () => {
  one()
  writeFileSync(join(data, 'agent-hang'), '')
  const before = git('rev-parse', 'HEAD')
  const r = factory(['wiki', 'write'], { FACTORY_WIKI_AGENT_MS: '1500' })
  expect(r.out).toContain('agent failed')
  expect(existsSync(join(home, 'wiki-write.stamp'))).toBe(true)
  expect(existsSync(join(home, 'wiki.lock'))).toBe(false)
  expect(git('rev-parse', 'HEAD')).toBe(before)
  expect(state().written).toBeUndefined()
  expect(state().lastWriteAt).toBeUndefined()
})

slow('write AC3 a codex run refuses a wiki that holds .codex', () => {
  one()
  mkdirSync(join(wiki(), '.codex'))
  const codex = join(dir, `bin${n}`, 'codex')
  const r = factory(['wiki', 'write'], { FACTORY_DREAM_CODEX: 'gpt-x', FACTORY_CODEX: codex })
  expect(r.out).toContain('refused')
  expect(runs()).toBe(0)
  expect(state().written).toBeUndefined()
})

slow('write AC4 a HEAD that moved in the pass commits and records nothing', () => {
  one()
  writeFileSync(join(data, 'agent-commit'), '')
  const r = factory(['wiki', 'write'])
  expect(r.out).toContain('the guard refused')
  expect(wikiLog()).toContain('HEAD moved in the pass')
  expect(state().written).toBeUndefined()
  expect(state().lastWriteAt).toBeUndefined()
})

slow('write AC5 a failed push keeps the commit, and the next pass pushes it', () => {
  one()
  const url = 'https://github.com/acme/widget-wiki.git'
  const b = join(dir, `bare${n}.git`)
  const cfg = join(dir, `cfg${n}`)
  writeFileSync(cfg, `[url "${b}"]\n\tinsteadOf = ${url}\n`)
  git('remote', 'add', 'origin', url)
  const env = { GIT_CONFIG_GLOBAL: cfg }
  factory(['wiki', 'write'], env)
  expect(wikiLog()).toContain('wiki: push failed')
  expect(Object.keys(state().written)).toEqual(['acme-1'])
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', b])
  factory(['wiki', 'write'], env)
  expect(runs()).toBe(1)
  expect(Bun.spawnSync(['git', '-C', b, 'rev-parse', 'main']).stdout.toString().trim()).toBe(
    git('rev-parse', 'HEAD'),
  )
})

slow('write AC1 a tracked page changed in the worktree does not finish its bead', () => {
  one()
  mkdirSync(join(wiki(), 'solutions', '2026-10'), { recursive: true })
  const old = page('acme-0', 'https://github.com/acme/widget/pull/4')
  writeFileSync(join(wiki(), 'solutions', '2026-10', 'old.md'), old)
  git('add', '-A')
  git('-c', 'user.name=person', '-c', 'user.email=person@example.com', 'commit', '-qm', 'old page')
  writeFileSync(join(wiki(), 'solutions', '2026-10', 'old.md'), old.replace('"acme-0"', '"acme-1"'))
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.out).toContain('group: acme-1')
})

slow('write AC1 a committed page for a PR is the existing page, also after an agent failure', () => {
  one()
  mkdirSync(join(wiki(), 'solutions', '2026-10'), { recursive: true })
  writeFileSync(join(wiki(), 'solutions', '2026-10', 'old.md'), page('acme-0', PR5))
  git('add', '-A')
  git('-c', 'user.name=person', '-c', 'user.email=person@example.com', 'commit', '-qm', 'old page')
  writeFileSync(join(data, 'agent-exit'), '')
  factory(['wiki', 'write'])
  expect(prompt()).toContain('"existingPage": "solutions/2026-10/old.md"')
  expect(state().written).toBeUndefined()
  rmSync(join(data, 'agent-exit'))
  writeFileSync(join(wiki(), 'solutions', '2026-10', 'old.md'), 'dirty\n')
  factory(['wiki', 'write'])
  expect(prompt()).toContain('"existingPage": "solutions/2026-10/old.md"')
})

slow('write AC2 a package.json patch never reaches the prompt', () => {
  setup()
  seed([closed('acme-1', { metadata: { ship_pr: PR5 } })])
  pr(5, 'acme-1: fix it', ['package.json'])
  writeFileSync(
    join(data, `gh-${key('repos/acme/widget/pulls/5/files?per_page=100')}`),
    JSON.stringify([{ filename: 'package.json', patch: '+  "scripts": "SECRETPATCH"' }]),
  )
  stage('solutions/2026-11/fix-acme-1.md', page('acme-1', PR5))
  factory(['wiki', 'write'])
  expect(prompt()).toContain('package.json')
  expect(prompt()).not.toContain('SECRETPATCH')
})

slow('write AC2 a long source text is cut in the prompt', () => {
  setup()
  seed([closed('acme-1', { metadata: { ship_pr: PR5 }, close_reason: 'y'.repeat(9000) })])
  pr(5, 'acme-1: fix it', ['src/a.ts'])
  factory(['wiki', 'write'])
  expect(prompt()).toContain('[truncated]')
  expect(prompt()).not.toContain('y'.repeat(8300))
})

slow('write AC2 an incomplete forge or bead reply keeps the bead waiting', () => {
  setup()
  seed(
    [
      closed('acme-1'),
      closed('acme-2', { metadata: { ship_pr: 'https://github.com/acme/widget/pull/6' } }),
      closed('acme-3'),
    ],
    [pr(9, 'acme-1: fix it', ['src/a.ts'])],
  )
  pr(6, 'acme-2: fix it', ['src/b.ts'])
  writeFileSync(join(data, `gh-${key('repos/acme/widget/pulls/9')}`), '{}')
  writeFileSync(join(data, `gh-${key('repos/acme/widget/pulls/6/files?per_page=100')}`), '[]')
  rmSync(join(data, 'bead-acme-3.json'))
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.out).not.toContain('group:')
  expect(r.out).toContain('0 groups from 0 beads; 3 waiting')
})

slow('write AC3 a group that stays too big after the cuts keeps its bead waiting', () => {
  setup()
  const listed = Array.from({ length: 20 }, (_, i) => {
    const l = pr(i + 20, `acme-1: part ${i}`, [])
    writeFileSync(
      join(data, `gh-${key(`repos/acme/widget/pulls/${i + 20}/files?per_page=100`)}`),
      JSON.stringify(Array.from({ length: 99 }, (_, j) => ({ filename: `src/${'d'.repeat(600)}${j}.ts` }))),
    )
    return l
  })
  seed([closed('acme-1')], listed)
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.out).not.toContain('group:')
  expect(r.out).toContain('0 groups from 0 beads; 1 waiting')
})

slow('write AC3 the count holds the completed beads only', () => {
  setup()
  seed([
    closed('acme-1', { metadata: { ship_pr: PR5 } }),
    closed('acme-2', { metadata: { ship_pr: 'https://github.com/acme/widget/pull/6' } }),
  ])
  pr(5, 'acme-1: fix it', ['src/a.ts'])
  pr(6, 'acme-2: fix it', ['src/b.ts'])
  stage('solutions/2026-11/fix-acme-1.md', page('acme-1', PR5))
  stage(
    'solutions/2026-11/fix-acme-2.md',
    page('acme-2', 'https://github.com/acme/widget/pull/6', SECTIONS.slice(0, 3)),
  )
  expect(factory(['wiki', 'write']).out).toContain('wiki write: 1 pages from 1 beads; 1 waiting')
})

slow('write AC2 the release PR record keeps its title and body in the prompt', () => {
  setup()
  seed([closed('acme-3', { metadata: { ship_pr: PR5 } })], [pr(7, 'acme-3 release notes', ['CHANGELOG.md'])])
  pr(5, 'acme-3: fix it', ['src/a.ts'])
  factory(['wiki', 'write'])
  expect(prompt()).toContain('"title": "acme-3 release notes"')
})

slow('write AC2 a merged_at that is not a string or null keeps the bead waiting', () => {
  setup()
  seed(
    [closed('acme-1'), closed('acme-2', { metadata: { ship_pr: 'https://github.com/acme/widget/pull/6' } })],
    [pr(9, 'acme-1: fix it', ['src/a.ts'])],
  )
  pr(6, 'acme-2: fix it', ['src/b.ts'])
  for (const n of [9, 6]) {
    const f = join(data, `gh-${key(`repos/acme/widget/pulls/${n}`)}`)
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), merged_at: 42 }))
  }
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.out).toContain('0 groups from 0 beads; 2 waiting')
})

slow('write AC3 202 beads on one PR stay waiting whole, never cut to 200', () => {
  setup()
  seed(Array.from({ length: 202 }, (_, i) => closed(`acme-${i + 1}`, { metadata: { ship_pr: PR5 } })))
  pr(5, 'acme-1: fix it', ['src/a.ts'])
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.out).not.toContain('group:')
  expect(r.out).toContain('0 groups from 0 beads; 202 waiting')
})

const LIST = () =>
  join(data, `gh-${key('repos/acme/widget/pulls?state=closed&sort=created&direction=desc&per_page=100&page=1')}`)
const OLD = '2026-11-01T00:00:00Z'

slow('write AC2 a malformed GitHub list row keeps the older bead pending', () => {
  setup()
  seed([closed('acme-1', { closed_at: OLD }), closed('acme-2')], [pr(9, 'acme-2: fix it', ['src/a.ts'])])
  writeFileSync(LIST(), JSON.stringify([{}]))
  const r = factory(['wiki', 'write', '--dry-run'])
  expect(r.out).toContain('0 groups from 0 beads; 2 waiting')
  writeFileSync(LIST(), JSON.stringify([pr(8, 'acme-1: fix it', ['src/b.ts'])]))
  expect(factory(['wiki', 'write', '--dry-run']).out).toContain('acme-1')
})

slow('write AC2 a malformed GitLab reply or failed short id read keeps the bead pending', () => {
  setup()
  Bun.spawnSync(['git', '-C', repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/acme/widget.git'])
  seed([closed('acme-abc1.2')])
  const bin = join(dir, `bin${n}`)
  const glab = (body: string) => {
    writeFileSync(join(bin, 'glab'), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, 'glab'), 0o755)
  }
  for (const body of [
    'echo "{}"',
    'echo "not json"',
    'echo "[{}]"',
    'case "$*" in *search=acme-abc1.2*) echo "[]";; *) echo "{}";; esac',
    'case "$*" in *search=acme-abc1.2*) echo "[]";; *) echo failed >&2; exit 1;; esac',
  ]) {
    glab(body)
    const r = factory(['wiki', 'write', '--dry-run'])
    expect([body, r.out]).toEqual([body, expect.stringContaining('0 groups from 0 beads; 1 waiting')])
  }
})
