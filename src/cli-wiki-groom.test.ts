// `factory wiki groom` end to end (claude-factory-tx6c.9). Every test spawns bin/factory with a new temp
// FACTORY_HOME, a fake `gh` first on PATH and a fake claude (FACTORY_CLAUDE), so nothing reaches the live home or GitHub.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(realpathSync(tmpdir()), `wiki-groom-${process.pid}`)
const SLOW = { timeout: 90_000 }
const URL_ = 'https://github.com/acme/widget-wiki.git'
const PR = 'https://github.com/acme/widget-wiki/pull/7'
const USAGE = 'usage: factory wiki groom [--dry-run]'
const today = () => new Date().toISOString().slice(0, 10)
let n = 0
let home = ''
let fake = ''
let bare = ''
let repo = ''
let cfg = ''

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const page = (title: string, body = 'text') => `---\nkind: "topic"\ntitle: "${title}"\n---\n${body}\n`
const wiki = () => join(home, 'wiki')
const run = (cmd: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawnSync(cmd, { env: { ...process.env, GIT_CONFIG_GLOBAL: cfg, ...env }, timeout: 50_000 })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const git = (...a: string[]) => {
  const r = run(['git', '-C', wiki(), ...a])
  if (r.code !== 0) throw new Error(`git ${a.join(' ')}: ${r.err}`)
  return r.out.trim()
}
const bareGit = (...a: string[]) => run(['git', '-C', bare, ...a]).out.trim()
const FACTORY_ID = ['-c', 'user.name=factory', '-c', `user.email=factory@${hostname()}`]
const commit = (msg: string, who = FACTORY_ID) => git(...who, 'commit', '-qm', msg)
const read = (p: string) => readFileSync(join(wiki(), p), 'utf8')
const wikiLog = () => (existsSync(join(home, 'wiki.log')) ? readFileSync(join(home, 'wiki.log'), 'utf8') : '')
const state = () => JSON.parse(readFileSync(join(home, 'wiki-state.json'), 'utf8'))
const claudeCalls = () =>
  existsSync(join(fake, 'calls.log')) ? readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n') : []
const ghCalls = () =>
  (existsSync(join(fake, 'gh.log')) ? readFileSync(join(fake, 'gh.log'), 'utf8') : '')
    .split('\x1e')
    .filter(Boolean)
    .map(r => r.split('\x1f').slice(0, -1))
const plan = (text: string) => writeFileSync(join(fake, 'plan'), text)
const apply = (sh: string) => writeFileSync(join(fake, 'apply.sh'), sh)

const PLAN2 = 'merge topics/a.md topics/b.md — same topic\nstale topics/c.md — FOO_BAR is gone\n'
const EDIT3 = 'echo more >> topics/a.md\necho more >> topics/b.md\necho more >> topics/c.md\n'

/** a new home with a rig, a fake gh and claude, and a wiki repo whose origin is a local bare repo, seeded with 3 pages */
function setup() {
  n++
  home = join(dir, `home${n}`)
  fake = join(dir, `fake${n}`)
  bare = join(dir, `bare${n}.git`)
  repo = join(dir, `repo${n}`)
  cfg = join(dir, `cfg${n}`)
  for (const d of [home, fake, repo, join(dir, 'bin')]) mkdirSync(d, { recursive: true })
  run(['git', 'init', '-q', repo])
  run(['git', 'init', '-q', '--bare', '-b', 'main', bare])
  writeFileSync(cfg, `[url "${bare}"]\n\tinsteadOf = ${URL_}\n`)
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'acme', repo, factory: join(dir, 'f.ts') }]))
  writeFileSync(
    join(dir, 'bin', 'gh'),
    `#!/bin/sh
F="$FAKE_DIR"
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\036'; } >> "$F/gh.log"
case "$1 $2" in
"repo view") cat "$F/vis" 2>/dev/null || echo PRIVATE ;;
"api --hostname") [ "$3" = "\${WANT_HOST:-github.com}" ] && case "$4" in repos/acme/widget-wiki/pulls/[0-9]*) [ -f "$F/prstate" ] && cat "$F/prstate" ;; esac ;;
"pr create") echo ${PR} ;;
"pr list") echo ;;
esac
`,
  )
  writeFileSync(
    join(dir, 'bin', 'claude'),
    `#!/bin/sh
F="$FAKE_DIR"
n=$(( $(cat "$F/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$F/n"
printf '%s|%s|%s\\n' "$(pwd)" "$(git symbolic-ref HEAD)" "$*" >> "$F/calls.log"
cat > "$F/stdin$n"
tools=""; prev=""
for a in "$@"; do [ "$prev" = --tools ] && tools="$a"; prev="$a"; done
case "$tools" in
*Edit*) sh "$F/apply.sh" ;;
*) [ -f "$F/plan.exit" ] && exit "$(cat "$F/plan.exit")"; cat "$F/plan" ;;
esac
`,
  )
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  chmodSync(join(dir, 'bin', 'claude'), 0o755)
  expect(factory(['wiki', 'init', '--remote', URL_]).code).toBe(0)
  for (const [p, t] of [
    ['topics/a.md', page('A')],
    ['topics/b.md', page('B')],
    ['topics/c.md', page('C', 'uses FOO_BAR')],
  ] as const) {
    mkdirSync(join(wiki(), 'topics'), { recursive: true })
    writeFileSync(join(wiki(), p), t)
  }
  git('add', '-A')
  commit('seed')
  git('push', '-q', URL_, 'HEAD:main')
  plan(PLAN2)
  apply(EDIT3)
}

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_WIKI_REMOTE, ...laptop } = process.env
  return run([CLI, ...args], {
    ...laptop,
    FACTORY_HOME: home,
    PATH: `${join(dir, 'bin')}:${laptop.PATH}`,
    FACTORY_SELF_UPDATE: '0',
    FACTORY_NO_KICK: '1',
    FAKE_DIR: fake,
    FACTORY_CLAUDE: join(dir, 'bin', 'claude'),
    ...env,
  })
}
const groom = (args: string[] = [], env: Record<string, string> = {}) =>
  factory(['wiki', 'groom', ...args], env)
const branches = () => git('branch', '--list', 'groom/*')
const creates = () => ghCalls().filter(c => c[0] === 'pr' && c[1] === 'create')

test(
  'AC1 AC5 a groom pass opens a PR with the plan as body and leaves main alone',
  () => {
    setup()
    const mainBefore = git('rev-parse', 'main')
    apply(
      `grep -q 'wiki groom: plan merge topics/a.md topics/b.md' "$FACTORY_HOME/wiki.log" && grep -q 'wiki groom: plan stale topics/c.md' "$FACTORY_HOME/wiki.log" && touch "$FAKE_DIR/fr010"\n${EDIT3}`,
    )
    const r = groom()
    expect(r.code).toBe(0)
    expect(r.out).toContain(`wiki groom: PR ${PR} with 2 actions`)
    expect(wikiLog()).toContain(`wiki groom: PR ${PR} with 2 actions`)
    const calls = claudeCalls()
    expect(calls).toHaveLength(2)
    const br = `groom/${today()}`
    expect(bareGit('rev-parse', 'main')).toBe(mainBefore)
    expect(git('rev-parse', 'main')).toBe(mainBefore)
    expect(bareGit('log', '-1', '--format=%ae|%s', br)).toStartWith(
      `factory@${hostname()}|wiki groom: 2 actions`,
    )
    expect(bareGit('rev-list', '--count', `main..${br}`)).toBe('1')
    expect(bareGit('diff', '--name-only', `main..${br}`).split('\n').sort()).toEqual([
      'topics/a.md',
      'topics/b.md',
      'topics/c.md',
    ])
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(git('status', '--porcelain')).toBe('')
    expect(branches()).toBe('')
    const c = creates()
    expect(c).toHaveLength(1)
    const a = c[0]!
    expect(a[a.indexOf('--repo') + 1]).toBe('github.com/acme/widget-wiki')
    expect(a[a.indexOf('--base') + 1]).toBe('main')
    expect(a[a.indexOf('--head') + 1]).toBe(br)
    expect(a[a.indexOf('--body') + 1]).toBe(
      PLAN2.trim()
        .split('\n')
        .map(l => `    ${l}`)
        .join('\n'),
    )
    expect(state().groomPr.url).toBe(PR)
    expect(state().groomPr.branch).toBe(br)
    expect(ghCalls().some(c => c.includes('merge'))).toBe(false)
    // AC5: argv, cwd, branch, FR-010 order and the apply stdin
    const [planCall, applyCall] = calls as [string, string]
    for (const call of calls) {
      const [cwd, head, argv] = call.split('|') as [string, string, string]
      expect(cwd).toBe(wiki())
      expect(head).toBe(`refs/heads/${br}`)
      expect(argv).toContain('-p')
      expect(argv).toContain('--strict-mcp-config')
      expect(argv).toContain('--setting-sources user')
      const settings = JSON.parse(argv.slice(argv.indexOf('--settings ') + '--settings '.length))
      expect(settings.permissions.deny).toContain('Edit(./.git/**)')
      expect(settings.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false')
      expect(argv.indexOf('--settings ')).toBeGreaterThan(argv.indexOf('--tools'))
    }
    expect(planCall).toContain('--permission-mode default')
    expect(planCall).toContain('--tools Read,Glob,Grep ')
    expect(planCall).toContain(`--add-dir ${repo}`)
    expect(applyCall).toContain('--permission-mode acceptEdits')
    expect(applyCall).toContain('--tools Read,Glob,Grep,Edit,Write ')
    expect(applyCall).not.toContain('--add-dir')
    expect(applyCall).not.toContain('Bash')
    expect(wikiLog()).toContain('wiki groom: plan merge topics/a.md topics/b.md')
    expect(wikiLog()).toContain('wiki groom: plan stale topics/c.md')
    expect(existsSync(join(fake, 'fr010'))).toBe(true)
    expect(readFileSync(join(fake, 'stdin2'), 'utf8').trimEnd().endsWith(PLAN2.trim())).toBe(true)
    expect(wikiLog()).not.toContain('FOO_BAR')
  },
  SLOW,
)

test(
  'AC2 a second pass skips while the PR is open',
  () => {
    setup()
    expect(groom().code).toBe(0)
    writeFileSync(join(fake, 'prstate'), 'open\n')
    const refs = bareGit('for-each-ref')
    const stampBefore = Bun.file(join(home, 'wiki-groom.stamp')).lastModified
    const r = groom()
    expect(r.code).toBe(0)
    expect(wikiLog()).toContain(`wiki groom: skipped, PR ${PR} open`)
    expect(claudeCalls()).toHaveLength(2)
    expect(creates()).toHaveLength(1)
    expect(bareGit('for-each-ref')).toBe(refs)
    expect(Bun.file(join(home, 'wiki-groom.stamp')).lastModified).toBe(stampBefore)
  },
  SLOW,
)

test(
  'AC2 the PR state read names the remote host',
  () => {
    setup()
    const ghe = 'https://ghe.acme.test/acme/widget-wiki.git'
    writeFileSync(cfg, `[url "${bare}"]\n\tinsteadOf = ${ghe}\n`)
    git('remote', 'set-url', 'origin', ghe)
    const pr = 'https://ghe.acme.test/acme/widget-wiki/pull/4'
    writeFileSync(
      join(home, 'wiki-state.json'),
      JSON.stringify({ ...state(), groomPr: { url: pr, branch: 'groom/x' } }),
    )
    writeFileSync(join(fake, 'prstate'), 'open\n')
    expect(groom([], { WANT_HOST: 'ghe.acme.test' }).code).toBe(0)
    expect(wikiLog()).toContain(`wiki groom: skipped, PR ${pr} open`)
  },
  SLOW,
)

test(
  'AC2 a merged or closed PR clears groomPr and runs a full pass',
  () => {
    for (const s of ['closed']) {
      setup()
      writeFileSync(
        join(home, 'wiki-state.json'),
        JSON.stringify({ ...state(), groomPr: { url: PR.replace('7', '3'), branch: 'groom/x' } }),
      )
      writeFileSync(join(fake, 'prstate'), s)
      expect(groom().code).toBe(0)
      expect(claudeCalls()).toHaveLength(2)
      expect(creates()).toHaveLength(1)
      expect(state().groomPr.url).toBe(PR)
    }
  },
  SLOW,
)

test(
  'AC2 an unknown PR state or a bad stored value fails closed',
  () => {
    const rows: [string, string | null, string][] = [
      [PR, null, 'state unknown, skipped'],
      [PR, 'weird', 'state unknown, skipped'],
      ['https://github.com/acme/other/pull/1', 'open', 'stored PR is not valid, skipped'],
      ['--repo=x', 'open', 'stored PR is not valid, skipped'],
      ['https://github.com/acme/widget-wiki/pull/0', 'open', 'stored PR is not valid, skipped'],
      [PR.replace('github.com/acme', 'GitHub.com/Acme'), 'open', 'skipped, PR'],
    ]
    for (const [url, st, line] of rows) {
      setup()
      writeFileSync(join(home, 'wiki-state.json'), JSON.stringify({ ...state(), groomPr: { url } }))
      if (st) writeFileSync(join(fake, 'prstate'), st)
      expect(groom().code).toBe(0)
      expect(wikiLog()).toContain(line)
      expect(claudeCalls()).toHaveLength(0)
      if (line.includes('not valid')) expect(ghCalls().filter(c => c[0] === 'api')).toHaveLength(0)
    }
  },
  SLOW,
)

test(
  'AC3 a path outside the plan is reverted',
  () => {
    setup()
    factory(['wiki', 'refresh'])
    git('push', '-q', URL_, 'HEAD:main')
    plan('rewrite topics/a.md — x\n')
    apply(`echo more >> topics/a.md
echo more >> topics/b.md
printf '%s\\n' '---' 'kind: "topic"' 'title: "N"' '---' x > topics/new.md
echo more >> rigs/acme.md
echo '- flag' >> needs-person.md
mkdir -p .claude && echo '{}' > .claude/settings.json
echo '*' > topics/.gitignore
cp topics/new.md topics/hidden.md
printf x > "topics/bad
name.md"
`)
    const r = groom()
    expect(r.code).toBe(0)
    const br = `groom/${today()}`
    expect(bareGit('diff', '--name-only', `main..${br}`)).toBe('topics/a.md')
    const log = wikiLog()
    for (const p of ['topics/b.md', 'topics/new.md', 'topics/hidden.md', 'rigs/acme.md', 'needs-person.md'])
      expect(log).toContain(`wiki groom: ${p} is not in the plan, reverted`)
    expect(log.split('wiki groom: a path not in the plan, reverted').length - 1).toBe(3)
    expect(log).not.toContain('.claude/settings.json')
    expect(log).not.toContain('bad\nname')
    expect(git('status', '--porcelain', '--ignored')).toBe('')
    for (const p of ['topics/new.md', 'topics/hidden.md', 'topics/.gitignore', '.claude'])
      expect(existsSync(join(wiki(), p))).toBe(false)
  },
  SLOW,
)

test(
  'AC4 a dry run prints the plan and changes nothing',
  () => {
    setup()
    const mainBefore = git('rev-parse', 'main')
    const r = groom(['--dry-run'])
    expect(r.code).toBe(0)
    expect(r.out).toBe(PLAN2)
    expect(claudeCalls()).toHaveLength(1)
    expect(claudeCalls()[0]).toContain('--tools Read,Glob,Grep ')
    expect(branches()).toBe('')
    expect(bareGit('branch', '--list', 'groom/*')).toBe('')
    expect(ghCalls().filter(c => c[0] === 'pr' || c[0] === 'api')).toHaveLength(0)
    expect(existsSync(join(home, 'wiki-groom.stamp'))).toBe(false)
    expect(git('rev-parse', 'main')).toBe(mainBefore)
    expect(git('status', '--porcelain')).toBe('')
    const lines = Array.from({ length: 16 }, (_, i) => `stale topics/p${i}.md — old`).join('\n')
    plan(lines)
    expect(groom(['--dry-run']).out.trim().split('\n')).toHaveLength(15)
    expect(groom(['--dry-run'], { FACTORY_WIKI_GROOM_CAP: '2' }).out.trim().split('\n')).toHaveLength(2)
  },
  SLOW,
)

test(
  'AC6 the pass stops before the agent',
  () => {
    setup()
    git('config', 'user.name', 'x')
    writeFileSync(join(wiki(), 'topics/a.md'), page('A', 'edited'))
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('not clean or not on main, skipped')
    expect(read('topics/a.md')).toContain('edited')
    git('checkout', '-q', '.')
    writeFileSync(join(wiki(), 'topics/u.md'), page('U'))
    groom()
    expect(existsSync(join(wiki(), 'topics/u.md'))).toBe(true)
    rmSync(join(wiki(), 'topics/u.md'))
    git('checkout', '-q', '-b', 'x')
    groom()
    expect(wikiLog().split('not clean or not on main, skipped').length - 1).toBe(3)
    expect(claudeCalls()).toHaveLength(0)
    git('checkout', '-q', 'main')
    git('branch', '-q', '-D', 'x')
    // public remote
    const st = state()
    delete st.visibility
    writeFileSync(join(home, 'wiki-state.json'), JSON.stringify(st))
    writeFileSync(join(fake, 'vis'), 'PUBLIC')
    groom()
    expect(wikiLog()).toContain('wiki: remote is public, push refused')
    expect(claudeCalls()).toHaveLength(0)
    // no origin
    git('remote', 'remove', 'origin')
    groom()
    expect(wikiLog()).toContain('wiki groom: no remote, skipped')
    expect(claudeCalls()).toHaveLength(0)
  },
  SLOW,
)

test(
  'AC6 a plan call with no valid line or a failed plan call stops the pass',
  () => {
    setup()
    plan('I think we should tidy up.\n')
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('wiki groom: no actions')
    expect(claudeCalls()).toHaveLength(1)
    writeFileSync(join(fake, 'plan.exit'), '1')
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('wiki groom: plan call failed (exit 1)')
    expect(claudeCalls()).toHaveLength(2)
    expect(creates()).toHaveLength(0)
    expect(bareGit('branch', '--list', 'groom/*')).toBe('')
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(branches()).toBe('')
  },
  SLOW,
)

test(
  'AC7 a HEAD move in the apply call commits nothing',
  () => {
    setup()
    const mainBefore = git('rev-parse', 'main')
    apply(
      `echo more >> topics/a.md\ngit update-ref "$(git symbolic-ref HEAD)" "$(git -c user.name=x -c user.email=x@x commit-tree -m evil 'HEAD^{tree}' -p HEAD)"\n`,
    )
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('HEAD moved in the pass, nothing committed')
    expect(creates()).toHaveLength(0)
    expect(bareGit('branch', '--list', 'groom/*')).toBe('')
    expect(git('rev-parse', 'main')).toBe(mainBefore)
  },
  SLOW,
)

test(
  'AC7 a changed person line keeps the page and flags it',
  () => {
    setup()
    writeFileSync(join(wiki(), 'topics/a.md'), page('A', 'person line'))
    git('add', '-A')
    commit('person', ['-c', 'user.name=p', '-c', 'user.email=person@acme.example'])
    git('push', '-q', URL_, 'HEAD:main')
    const before = read('topics/a.md')
    plan('rewrite topics/a.md — x\nrewrite topics/b.md — y\n')
    apply(`sed -i 's/person line/changed/' topics/a.md\necho more >> topics/b.md\n`)
    expect(groom().code).toBe(0)
    const br = `groom/${today()}`
    expect(bareGit('diff', '--name-only', `main..${br}`).split('\n').sort()).toEqual([
      'needs-person.md',
      'topics/b.md',
    ])
    expect(bareGit('show', `${br}:needs-person.md`)).toContain('topics/a.md')
    expect(bareGit('show', `${br}:topics/a.md`)).toBe(before.trimEnd())
  },
  SLOW,
)

test(
  'AC7 a secret shape keeps one page, and commits nothing when it was the only page',
  () => {
    setup()
    const secret = `ghp_${'a'.repeat(36)}`
    plan('rewrite topics/a.md — x\nrewrite topics/b.md — y\n')
    apply(`echo ${secret} >> topics/a.md\necho more >> topics/b.md\n`)
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('wiki: secret shape in topics/a.md, page kept at last version')
    expect(bareGit('diff', '--name-only', `main..groom/${today()}`)).toBe('topics/b.md')
    setup()
    plan('rewrite topics/a.md — x\n')
    apply(`echo ${secret} >> topics/a.md\n`)
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('no change, no PR')
    expect(creates()).toHaveLength(0)
    expect(bareGit('branch', '--list', 'groom/*')).toBe('')
  },
  SLOW,
)

test(
  'AC7 a nested repo made by the agent is never committed',
  () => {
    setup()
    plan('rewrite topics/a.md — x\n')
    apply(
      `echo more >> topics/a.md\ngit init -q topics/x\ngit -C topics/x -c user.name=x -c user.email=x@x commit -q --allow-empty -m n\n`,
    )
    expect(groom().code).toBe(0)
    const br = `groom/${today()}`
    const files = bareGit('ls-tree', '-r', '--name-only', br)
    if (files) expect(files).not.toContain('topics/x')
    expect(existsSync(join(wiki(), 'topics/x'))).toBe(false)
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(git('status', '--porcelain')).toBe('')
  },
  SLOW,
)

test(
  'AC8 a merged groom PR reaches main by refresh, and a revert restores the pages',
  () => {
    setup()
    const texts = ['a', 'b', 'c'].map(x => read(`topics/${x}.md`))
    expect(groom().code).toBe(0)
    const br = `groom/${today()}`
    const scratch = join(dir, 'scratch')
    expect(run(['git', 'clone', '-q', bare, scratch]).code).toBe(0)
    const id = ['-c', 'user.name=p', '-c', 'user.email=person@acme.example']
    expect(
      run(['git', '-C', scratch, ...id, 'merge', '-q', '--no-ff', '-m', 'merge groom', `origin/${br}`]).code,
    ).toBe(0)
    expect(run(['git', '-C', scratch, 'push', '-q', 'origin', 'HEAD:main']).code).toBe(0)
    expect(factory(['wiki', 'refresh']).code).toBe(0)
    const merge = git('log', '--merges', '-1', '--format=%H')
    expect(merge).not.toBe('')
    expect(git('rev-parse', 'main')).toBe(bareGit('rev-parse', 'main'))
    git(...id, 'revert', '-m', '1', '--no-edit', merge)
    expect(['a', 'b', 'c'].map(x => read(`topics/${x}.md`))).toEqual(texts)
  },
  SLOW,
)

test(
  'AC8 a left-over groom checkout is cleaned by the next pass',
  () => {
    setup()
    git('checkout', '-q', '-b', 'groom/x')
    writeFileSync(join(wiki(), 'topics/a.md'), page('A', 'left'))
    git('add', '-A')
    commit('left')
    const bareMain = bareGit('rev-parse', 'main')
    expect(factory(['wiki', 'refresh']).code).toBe(0)
    expect(wikiLog()).toContain('wiki: checkout not on main, refresh skipped')
    expect(bareGit('rev-parse', 'main')).toBe(bareMain)
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('wiki groom: left-over groom checkout, back on main')
    expect(branches()).toBe('')
    expect(claudeCalls()).toHaveLength(2)
  },
  SLOW,
)

test(
  'AC8 a dirty left-over groom checkout is kept',
  () => {
    setup()
    git('checkout', '-q', '-b', 'groom/x')
    writeFileSync(join(wiki(), 'topics/u.md'), page('U'))
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('left-over groom checkout not clean, skipped')
    expect(claudeCalls()).toHaveLength(0)
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/groom/x')
    expect(existsSync(join(wiki(), 'topics/u.md'))).toBe(true)
  },
  SLOW,
)

test(
  'AC8 an ignored file that origin/main does not ignore stays',
  () => {
    setup()
    writeFileSync(join(wiki(), '.gitignore'), '*.local\n')
    git('add', '-A')
    commit('ignore')
    writeFileSync(join(wiki(), 'notes.local'), 'mine')
    expect(groom().code).toBe(0)
    expect(wikiLog()).toContain('untracked files on the groom branch, skipped')
    expect(claudeCalls()).toHaveLength(0)
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(read('notes.local')).toBe('mine')
  },
  SLOW,
)

test(
  'AC11 a bad form is a usage error and a held lock is busy',
  () => {
    setup()
    for (const a of [['x'], ['--dry-run', 'x'], ['--force']]) {
      const r = groom(a)
      expect(r.code).toBe(2)
      expect(r.err).toContain(USAGE)
    }
    expect(claudeCalls()).toHaveLength(0)
    expect(existsSync(join(home, 'wiki.lock'))).toBe(false)
    const w = groom([], { FACTORY_OUTBOX: join(dir, 'out'), FACTORY_FROM: 'x/y' })
    expect(w.code).not.toBe(0)
    const p = groom([], { FACTORY_PATROL: '1' })
    expect(p.code).not.toBe(0)
    expect(claudeCalls()).toHaveLength(0)
  },
  SLOW,
)

test.skipIf(process.getuid?.() === 0)(
  'AC3 a path that cannot be reverted stops the pass',
  () => {
    setup()
    plan('rewrite topics/a.md — x\n')
    apply('echo more >> topics/a.md\nmkdir topics/ro\necho x > topics/ro/y.md\nchmod 555 topics/ro\n')
    try {
      expect(groom().code).toBe(0)
      expect(wikiLog()).toContain('wiki groom: revert failed, nothing committed')
      expect(creates()).toHaveLength(0)
      expect(bareGit('branch', '--list', 'groom/*')).toBe('')
    } finally {
      run(['chmod', '-R', 'u+w', join(wiki(), 'topics')])
    }
  },
  SLOW,
)

// claude-factory-96ks: the repo config of wiki/.git must not redirect a push or run code
const evilRepo = () => {
  const e = join(dir, `evil${n}.git`)
  run(['git', 'init', '-q', '--bare', '-b', 'main', e])
  return e
}

test(
  'AC5 96ks groom stops before the plan call when the repo config has a key outside the allow-list',
  () => {
    setup()
    git('config', `url.${evilRepo()}.insteadOf`, URL_)
    const gh0 = ghCalls().length
    const r = groom()
    expect(r.code).toBe(0)
    expect(wikiLog()).toContain('wiki groom: repo config not allowed, skipped')
    expect(claudeCalls()).toEqual([])
    expect(ghCalls().length).toBe(gh0)
    expect(bareGit('branch', '--list', 'groom/*')).toBe('')
    expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
  },
  SLOW,
)

for (const exit of [0, 1]) {
  test(
    `AC6 96ks a groom apply that writes the repo config and exits ${exit} commits and pushes nothing`,
    () => {
      setup()
      const e = evilRepo()
      const marker = join(dir, `marker${n}`)
      apply(
        `echo more >> topics/a.md\necho '* filter=zq' > .gitattributes\nprintf '[url "${e}"]\\n\\tinsteadOf = ${URL_}\\n[filter "zq"]\\n\\tsmudge = sh -c "echo f >> ${marker}; cat"\\n' >> .git/config\nexit ${exit}\n`,
      )
      const r = groom()
      expect(r.code).toBe(0)
      // f1zc: the .git guard runs first, puts the config back and lets the cleanup finish
      expect(wikiLog()).toContain('wiki groom: .git changed in the pass, nothing committed')
      expect(git('rev-list', '--count', 'refs/remotes/origin/main..HEAD')).toBe('0')
      expect(bareGit('branch', '--list', 'groom/*')).toBe('')
      expect(run(['git', '-C', e, 'branch', '--list', 'groom/*']).out.trim()).toBe('')
      expect(creates()).toHaveLength(0)
      expect(existsSync(join(home, 'wiki-state.json')) && 'groomPr' in state()).toBe(false)
      expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
      expect(existsSync(marker)).toBe(false)
      expect(readFileSync(join(wiki(), '.git', 'config'), 'utf8')).not.toContain('insteadOf')
    },
    SLOW,
  )
}

// claude-factory-f1zc: the apply pass must not leave a .git change or a nested repo that runs a command
const SCRIPT = () => join(dir, 'mark.sh')
const MARKER = () => join(dir, 'MARKER')
const FSMON = () => `printf '[core]\\n\\tfsmonitor = ${SCRIPT()}\\n' >> .git/config\n`
const NESTED = () =>
  [
    'mkdir -p topics/sub/g/objects/info topics/sub/g/refs/heads',
    `printf 'gitdir: ./g\\n' > topics/sub/.git`,
    `printf '%s\\n' "${wiki()}/.git/objects" > topics/sub/g/objects/info/alternates`,
    'git rev-parse HEAD > topics/sub/g/HEAD',
    `printf '[core]\\n\\trepositoryformatversion = 0\\n\\tfsmonitor = ${SCRIPT()}\\n' > topics/sub/g/config`,
    'echo hi > topics/sub/f.md',
    '',
  ].join('\n')
const markScript = () => {
  writeFileSync(SCRIPT(), `#!/bin/sh\ntouch '${MARKER()}'\n`)
  chmodSync(SCRIPT(), 0o755)
}
const CHANGED = 'wiki groom: .git changed in the pass, nothing committed'
const groomed = () => {
  expect(existsSync(MARKER())).toBe(false)
  expect(creates()).toEqual([])
  expect(wikiLog()).toContain(CHANGED)
  expect(git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
}

test(
  'AC6a a config write in the apply pass is undone and nothing is committed',
  () => {
    setup()
    markScript()
    const before = join(fake, 'config.before')
    apply(`cp .git/config "${before}"\n${EDIT3}${FSMON()}`)
    expect(groom().code).toBe(0)
    // the cleanup then drops the groom branch section, so the bytes differ only by that
    expect(readFileSync(join(wiki(), '.git', 'config'), 'utf8')).not.toContain('fsmonitor')
    expect(readFileSync(before, 'utf8')).not.toContain('fsmonitor')
    groomed()
  },
  SLOW,
)

test(
  'AC6b a nested repo from the apply pass is removed',
  () => {
    setup()
    markScript()
    apply(EDIT3 + NESTED())
    expect(groom().code).toBe(0)
    expect(existsSync(join(wiki(), 'topics', 'sub', '.git'))).toBe(false)
    groomed()
  },
  SLOW,
)

test(
  'AC6c a .git that becomes a file fences the wiki',
  () => {
    setup()
    markScript()
    const shim = join(dir, 'shim')
    const glog = join(dir, 'git.log')
    mkdirSync(shim, { recursive: true })
    writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$*" >> '${glog}'\nexec '${Bun.which('git')}' "$@"\n`)
    chmodSync(join(shim, 'git'), 0o755)
    const PATH = `${shim}:${join(dir, 'bin')}:${process.env.PATH}`
    apply(
      `mv .git .g\nprintf 'gitdir: .g\\n' > .git\nprintf '[core]\\n\\tfsmonitor = ${SCRIPT()}\\n' >> .g/config\necho PASS-END >> '${glog}'\n`,
    )
    expect(groom([], { PATH }).code).toBe(0)
    expect(wikiLog()).toContain(
      'wiki groom: .git changed in the pass, restore failed, git fenced, nothing committed',
    )
    expect(wikiLog()).toContain('wiki groom: cleanup failed, checkout left on groom/')
    expect(existsSync(join(home, 'wiki.fenced'))).toBe(true)
    const lines = readFileSync(glog, 'utf8').split('\n')
    expect(lines.slice(lines.indexOf('PASS-END') + 1).filter(l => l.includes(wiki()))).toEqual([])
    const n = readFileSync(glog, 'utf8').length
    groom([], { PATH })
    expect(readFileSync(glog, 'utf8').slice(n)).not.toContain(wiki())
    expect(existsSync(MARKER())).toBe(false)
    expect(creates()).toEqual([])
  },
  SLOW,
)

test(
  'AC6d a failed apply call that also wrote config is still undone',
  () => {
    setup()
    markScript()
    apply(`${FSMON()}exit 1\n`)
    expect(groom().code).toBe(0)
    groomed()
    expect(wikiLog()).not.toContain('apply call failed')
  },
  SLOW,
)
