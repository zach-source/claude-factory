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
    `echo "$*" >> '${data}/gh-calls'
f='${data}/gh-'$(printf '%s' "$2" | sed 's/[^A-Za-z0-9]/_/g')
if [ -f "$f" ]; then cat "$f"; else echo 'not found' >&2; exit 1; fi
`,
  )
  fake(
    'agent',
    `echo "$PWD" > '${data}/agent-cwd'
echo "$*" > '${data}/agent-args'
cat > '${data}/agent-prompt'
echo x >> '${data}/agent-runs'
if [ -f '${data}/agent-exit' ]; then echo failed >&2; exit 3; fi
if [ -f '${data}/agent-edit' ]; then sed -i 's/Text\\./Changed./' solutions/2026-10/person.md; fi
for f in '${data}'/pages/solutions/*/*.md; do
  id=$(basename "$f" .md | sed 's/^fix-//')
  if grep -q "\\"id\\": \\"$id\\"" '${data}/agent-prompt'; then
    mkdir -p "solutions/$(basename "$(dirname "$f")")"
    cp "$f" "solutions/$(basename "$(dirname "$f")")/"
  fi
done
`,
  )
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
