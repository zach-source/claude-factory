// `factory wiki init`, commitWiki and pushWiki end to end (claude-factory-tx6c.2). Every test spawns bin/factory
// with a new temp FACTORY_HOME and a fake `gh` first on PATH, so nothing reaches the live home or GitHub.
import { afterEach, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPages } from './wiki'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(realpathSync(tmpdir()), `wiki-${process.pid}`)
let n = 0
let home = ''
const bin = join(dir, 'bin')
const calls = join(dir, 'gh-calls')
const TOKEN = `ghp_${'zq'.repeat(18)}`

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** a new home and a fake gh: `visibility` is its answer, or `exit1` to fail, or junk text */
function setup(visibility = 'PRIVATE') {
  home = join(dir, `home${++n}`)
  mkdirSync(bin, { recursive: true })
  const body = visibility === 'exit1' ? 'exit 1' : `printf '%s\\n' '${visibility}'`
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${calls}'\n${body}\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  rmSync(calls, { force: true })
}
const ghCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0)

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_WIKI_REMOTE, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${bin}:${laptop.PATH}`,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_NO_KICK: '1',
      ...env,
    },
    timeout: 30_000,
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const wiki = () => join(home, 'wiki')
const git = (...args: string[]) => {
  const p = Bun.spawnSync(['git', '-C', wiki(), ...args])
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}
const commits = () => Number(git('rev-list', '--count', 'HEAD'))
const wikiLog = () => (existsSync(join(home, 'wiki.log')) ? readFileSync(join(home, 'wiki.log'), 'utf8') : '')
const page = (kind: string, title: string) =>
  `---\nkind: ${kind}\ntitle: ${JSON.stringify(title)}\n---\nbody\n`

const USAGE = 'usage: factory wiki init [--remote <url>]'

test('AC1 a remote outside the grammar exits 2, makes no repo and calls no gh', () => {
  for (const url of [
    'https://u:zq@github.com/acme/w',
    '/srv/wiki.git',
    'file:///srv/w',
    'ext::sh -c x',
    '-uhttps://x',
    'https://github.com/acme/w/extra',
    'git@github.com:acme/../w',
    'https://github.com/acme/w\nx',
    'http://github.com/acme/w',
  ]) {
    setup()
    const r = factory(['wiki', 'init', '--remote', url])
    expect([url, r.code]).toEqual([url, 2])
    expect(r.err).toContain(USAGE)
    expect(existsSync(wiki())).toBe(false)
    expect(ghCalls()).toBe(0)
  }
  setup()
  const r = factory(['wiki', 'init'], { FACTORY_WIKI_REMOTE: 'https://u:zq@github.com/acme/w' })
  expect(r.code).toBe(2)
  expect(existsSync(wiki())).toBe(false)
})

test('AC2 init without a remote seeds the repo and makes one commit', () => {
  setup()
  const r = factory(['wiki', 'init'])
  expect(r.code).toBe(0)
  expect(existsSync(join(wiki(), '.git'))).toBe(true)
  expect(commits()).toBe(1)
  expect(git('log', '-1', '--format=%s')).toBe('wiki init: seed index and glossary')
  expect(readFileSync(join(wiki(), 'index.md'), 'utf8')).toContain('kind: "index"')
  const glossary = readFileSync(join(wiki(), 'glossary.md'), 'utf8')
  expect(glossary).toContain('kind: "glossary"')
  for (const t of ['station', 'soak', 'rig', 'ship lane', 'bead', 'run']) expect(glossary).toContain(t)
  expect(Bun.spawnSync(['git', '-C', wiki(), 'config', '--get', 'remote.origin.url']).exitCode).toBe(1)
  expect(ghCalls()).toBe(0)
  // a second init changes nothing, and keeps a page a person committed
  writeFileSync(join(wiki(), 'index.md'), page('index', 'mine'))
  git('add', '-A')
  Bun.spawnSync(['git', '-C', wiki(), '-c', 'user.name=p', '-c', 'user.email=p@x.test', 'commit', '-qm', 'p'])
  const before = commits()
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(commits()).toBe(before)
  expect(readFileSync(join(wiki(), 'index.md'), 'utf8')).toContain('mine')
})

test('AC3 commits carry the factory identity whatever the environment says', () => {
  setup()
  const cfg = join(dir, 'gitconfig')
  writeFileSync(cfg, '[commit]\n\tgpgsign = true\n')
  const env = {
    GIT_CONFIG_GLOBAL: cfg,
    GIT_AUTHOR_NAME: 'zq-person',
    GIT_COMMITTER_EMAIL: 'zq@person.test',
  }
  expect(factory(['wiki', 'init'], env).code).toBe(0)
  expect(git('log', '--format=%an <%ae>|%cn <%ce>')).toBe(
    `factory <factory@${hostname()}>|factory <factory@${hostname()}>`,
  )
})

test('AC4 a page that fails the scan goes back to its last version', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  const base = commits()
  mkdirSync(join(wiki(), 'solutions'))
  writeFileSync(join(wiki(), 'index.md'), `${page('index', 'Index')}${TOKEN}\n`)
  writeFileSync(join(wiki(), 'solutions', 'x.md'), `${page('topic', 'X')}${TOKEN}\n`)
  writeFileSync(join(wiki(), 'bad-kind.md'), page('nope', 'Y'))
  writeFileSync(join(wiki(), 'big.md'), `${page('topic', 'Big')}${'a'.repeat(70_000)}\n`)
  writeFileSync(join(wiki(), 'good.md'), page('topic', 'Good'))
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(commits()).toBe(base + 1)
  expect(git('show', 'HEAD:index.md')).not.toContain('ghp_')
  expect(readFileSync(join(wiki(), 'index.md'), 'utf8')).not.toContain('ghp_')
  const files = git('ls-files').split('\n')
  expect(files).toContain('good.md')
  for (const f of ['solutions/x.md', 'bad-kind.md', 'big.md']) expect(files).not.toContain(f)
  expect(existsSync(join(wiki(), 'solutions', 'x.md'))).toBe(true)
  const log = wikiLog()
  expect(log).toContain('wiki: secret shape in index.md, page kept at last version')
  expect(log).toContain('wiki: secret shape in solutions/x.md, page kept at last version')
  expect(log).toContain('wiki: kind: invalid in bad-kind.md, page kept at last version')
  expect(log).toContain('in big.md, page kept at last version')
  expect(log).not.toContain('ghp_')
})

test('AC4 a type change is scanned, and a token with a bad kind logs the secret line', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  writeFileSync(join(wiki(), 'link.md'), page('topic', 'Link'))
  expect(factory(['wiki', 'init']).code).toBe(0)
  const base = commits()
  writeFileSync(join(wiki(), 'real.txt'), `${TOKEN}\n`)
  unlinkSync(join(wiki(), 'link.md'))
  symlinkSync('real.txt', join(wiki(), 'link.md'))
  writeFileSync(join(wiki(), 'both.md'), `${page('nope', 'B')}${TOKEN}\n`)
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(commits()).toBe(base)
  expect(git('ls-files').split('\n')).not.toContain('both.md')
  expect(git('ls-tree', 'HEAD', 'link.md')).toContain('100644')
  const log = wikiLog()
  expect(log).toContain('in link.md, page kept at last version')
  expect(log).toContain('wiki: secret shape in both.md, page kept at last version')
})

test('AC4 a bad path is refused with no path text', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  const base = commits()
  writeFileSync(join(wiki(), '.hidden.md'), page('topic', 'H'))
  writeFileSync(join(wiki(), 'a\nb.md'), page('topic', 'N'))
  writeFileSync(join(wiki(), 'note.txt'), 'x')
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(commits()).toBe(base)
  expect(wikiLog().match(/wiki: bad page path, page kept at last version/g)?.length).toBe(3)
  expect(wikiLog()).not.toContain('hidden')
})

test('AC9 a held wiki.lock prints busy, exits 0 and makes nothing', () => {
  setup()
  mkdirSync(join(home, 'wiki.lock'), { recursive: true })
  writeFileSync(join(home, 'wiki.lock', 'pid'), String(process.pid))
  const r = factory(['wiki', 'init'])
  expect(r.code).toBe(0)
  expect(r.out + r.err).toContain('wiki: busy')
  expect(existsSync(wiki())).toBe(false)
  expect(ghCalls()).toBe(0)
})

test('AC9 the lock is released after a refusal', () => {
  setup('PUBLIC')
  const url = 'https://github.com/acme/widget-wiki.git'
  expect(factory(['wiki', 'init', '--remote', url]).code).toBe(1)
  const r = factory(['wiki', 'init', '--remote', url])
  expect(r.code).toBe(1)
  expect(r.out + r.err).not.toContain('wiki: busy')
})

test('AC10 usage', () => {
  setup()
  for (const a of [['wiki'], ['wiki', 'nope'], ['wiki', 'init', 'extra']]) {
    const r = factory(a)
    expect([a, r.code]).toEqual([a, 2])
    expect(r.err).toContain(USAGE)
  }
  const pt = factory(['wiki', 'init'], { FACTORY_PATROL: '1' })
  expect(pt.code).not.toBe(0)
  expect(pt.err).toContain('a patrol cannot run factory wiki')
  expect(existsSync(wiki())).toBe(false)
  const w = factory(['wiki', 'init'], { FACTORY_OUTBOX: join(dir, 'out'), FACTORY_FROM: 'x/y' })
  expect(w.code).not.toBe(0)
  expect(existsSync(wiki())).toBe(false)
})

const URL_ = 'https://github.com/acme/widget-wiki.git'
/** a bare repo that answers for URL_, through a global git config (insteadOf), as src/gc-worktrees-cli.test.ts does */
function bare() {
  const b = join(dir, `bare${n}.git`)
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', b])
  const cfg = join(dir, `cfg${n}`)
  writeFileSync(cfg, `[url "${b}"]\n\tinsteadOf = ${URL_}\n`)
  return { b, env: { GIT_CONFIG_GLOBAL: cfg } }
}
const mainOf = (b: string) => Bun.spawnSync(['git', '-C', b, 'rev-parse', '--verify', '-q', 'main'])
const state = () => JSON.parse(readFileSync(join(home, 'wiki-state.json'), 'utf8'))
const noOrigin = () =>
  Bun.spawnSync(['git', '-C', wiki(), 'config', '--get', 'remote.origin.url']).exitCode === 1

test('AC8 PRIVATE and INTERNAL remotes: origin is set and main is pushed', () => {
  for (const vis of ['PRIVATE', 'INTERNAL']) {
    setup(vis)
    const { b, env } = bare()
    expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(0)
    expect(mainOf(b).stdout.toString().trim()).toBe(git('rev-parse', 'HEAD'))
    expect(git('config', '--get', 'remote.origin.url')).toBe(URL_)
    expect(ghCalls()).toBe(1)
    expect(state().visibility.value).toBe(vis)
    // the env remote does the same, and init reads the visibility again
    expect(factory(['wiki', 'init'], { ...env, FACTORY_WIKI_REMOTE: URL_ }).code).toBe(0)
    expect(ghCalls()).toBe(2)
  }
})

test('AC8 a PUBLIC remote exits 1, sets no origin and pushes nothing', () => {
  setup('PUBLIC')
  const { b, env } = bare()
  const r = factory(['wiki', 'init', '--remote', URL_], env)
  expect(r.code).toBe(1)
  expect(r.err).toContain('wiki: remote is public, push refused')
  expect(wikiLog()).toContain('wiki: remote is public, push refused')
  expect(noOrigin()).toBe(true)
  expect(mainOf(b).exitCode).not.toBe(0)
  expect(commits()).toBe(1)
})

test('AC6 an unknown visibility refuses, caches nothing and exits 1', () => {
  for (const vis of ['exit1', 'maybe']) {
    setup(vis)
    const { b, env } = bare()
    expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(1)
    expect(wikiLog()).toContain('wiki: remote visibility unknown, push refused')
    expect(existsSync(join(home, 'wiki-state.json'))).toBe(false)
    expect(noOrigin()).toBe(true)
    expect(mainOf(b).exitCode).not.toBe(0)
  }
})

/** a driver for the exported pushWiki(), run on the temp home in a child process */
function pushPass(env: Record<string, string>) {
  const script = join(dir, 'push.ts')
  writeFileSync(
    script,
    `import { pushWiki } from '${join(import.meta.dir, 'cli')}'\nprocess.exit(pushWiki() ? 0 : 1)\n`,
  )
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  return Bun.spawnSync(['bun', script, 'noop'], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${bin}:${laptop.PATH}`,
      FACTORY_NO_KICK: '1',
      FACTORY_SELF_UPDATE: '0',
      ...env,
    },
    stderr: 'pipe',
  })
}

test('AC6 and AC7 pushWiki reads the visibility once in 24 h and pushes only a checked URL', () => {
  setup('PRIVATE')
  const { b, env } = bare()
  expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(0)
  expect(ghCalls()).toBe(1)
  writeFileSync(join(wiki(), 'next.md'), page('topic', 'Next'))
  expect(factory(['wiki', 'init'], env).code).toBe(0) // commits next.md, no remote arg: no push
  expect(pushPass(env).exitCode).toBe(0)
  expect(ghCalls()).toBe(1) // the cache answered
  expect(mainOf(b).stdout.toString().trim()).toBe(git('rev-parse', 'HEAD'))
  // an old check reads again
  const s = state()
  s.visibility.checkedAt = new Date(Date.now() - 25 * 3600_000).toISOString()
  s.other = 1
  writeFileSync(join(home, 'wiki-state.json'), JSON.stringify(s))
  expect(pushPass(env).exitCode).toBe(0)
  expect(ghCalls()).toBe(2)
  expect(state().other).toBe(1)
  // a check dated in the future reads again
  s.visibility.checkedAt = new Date(Date.now() + 3600_000).toISOString()
  writeFileSync(join(home, 'wiki-state.json'), JSON.stringify(s))
  expect(pushPass(env).exitCode).toBe(0)
  expect(ghCalls()).toBe(3)
  // a cache for another remote reads again
  s.visibility.remote = 'github.com/acme/other'
  writeFileSync(join(home, 'wiki-state.json'), JSON.stringify(s))
  pushPass(env)
  expect(ghCalls()).toBe(4)
})

test('AC7 pushWiki refuses an origin outside the grammar, with no gh call and no push', () => {
  setup('PRIVATE')
  const { b, env } = bare()
  expect(factory(['wiki', 'init'], env).code).toBe(0)
  git('remote', 'add', 'origin', b)
  expect(pushPass(env).exitCode).toBe(1)
  expect(wikiLog()).toContain('wiki: remote not allowed, push refused')
  expect(ghCalls()).toBe(0)
  expect(mainOf(b).exitCode).not.toBe(0)
})

test('AC6 and AC7 pushWiki refuses a PUBLIC, junk or failed visibility and pushes nothing', () => {
  for (const [vis, line, cached] of [
    ['PUBLIC', 'wiki: remote is public, push refused', true],
    ['maybe', 'wiki: remote visibility unknown, push refused', false],
    ['exit1', 'wiki: remote visibility unknown, push refused', false],
  ] as const) {
    setup(vis)
    const { b, env } = bare()
    expect(factory(['wiki', 'init'], env).code).toBe(0)
    git('remote', 'add', 'origin', URL_)
    expect(pushPass(env).exitCode).toBe(1)
    expect(wikiLog()).toContain(line)
    expect(ghCalls()).toBe(1)
    expect(mainOf(b).exitCode).not.toBe(0)
    expect(existsSync(join(home, 'wiki-state.json'))).toBe(cached)
  }
})

test('AC7 pushWiki with no origin does nothing', () => {
  setup('PRIVATE')
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(pushPass({}).exitCode).toBe(1)
  expect(ghCalls()).toBe(0)
})

test('AC7 pushWiki ignores a pushurl set by hand', () => {
  setup('PRIVATE')
  const { b, env } = bare()
  expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(0)
  const evil = join(dir, 'evil.git')
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', evil])
  git('config', 'remote.origin.pushurl', evil)
  writeFileSync(join(wiki(), 'more.md'), page('topic', 'More'))
  expect(factory(['wiki', 'init'], env).code).toBe(0)
  expect(pushPass(env).exitCode).toBe(0)
  expect(mainOf(b).stdout.toString().trim()).toBe(git('rev-parse', 'HEAD'))
  expect(mainOf(evil).exitCode).not.toBe(0)
})

test('AC7 a failed push is journaled with its exit code only', () => {
  setup('PRIVATE')
  const { b, env } = bare()
  expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(0)
  rmSync(b, { recursive: true, force: true })
  expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(1)
  expect(wikiLog()).toMatch(/wiki: push failed \(exit \d+\)\n/)
})

test('AC4 a nested repo and a symlink to a valid page are refused by mode, and nothing is committed', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  const base = commits()
  Bun.spawnSync(['git', 'init', '-q', join(wiki(), 'sub.md')])
  Bun.spawnSync([
    'git',
    '-C',
    join(wiki(), 'sub.md'),
    '-c',
    'user.name=p',
    '-c',
    'user.email=p@x.test',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'p',
  ])
  writeFileSync(join(wiki(), 'real.txt'), page('topic', 'Real'))
  symlinkSync('real.txt', join(wiki(), 'link.md'))
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(commits()).toBe(base)
  expect(git('ls-files').split('\n')).not.toContain('sub.md')
  expect(git('ls-files').split('\n')).not.toContain('link.md')
  expect(wikiLog().match(/bad file mode in /g)?.length).toBe(2)
})

test('AC3 author and committer config keys do not change the factory identity', () => {
  setup()
  const cfg = join(dir, 'gitconfig2')
  writeFileSync(
    cfg,
    '[author]\n\tname = zq-person\n\temail = zq@person.test\n[committer]\n\tname = zq-person\n\temail = zq@person.test\n',
  )
  expect(factory(['wiki', 'init'], { GIT_CONFIG_GLOBAL: cfg }).code).toBe(0)
  expect(git('log', '--format=%an <%ae>|%cn <%ce>')).toBe(
    `factory <factory@${hostname()}>|factory <factory@${hostname()}>`,
  )
})

test('AC2 init in a home that is a git repo makes the wiki its own repo and leaves the parent alone', () => {
  setup('PRIVATE')
  mkdirSync(home, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', home])
  writeFileSync(join(home, 'secret.txt'), 'zq\n')
  mkdirSync(join(wiki(), '.git'), { recursive: true }) // an empty .git is not a repo
  const { b, env } = bare()
  expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(0)
  expect(realpathSync(git('rev-parse', '--show-toplevel'))).toBe(realpathSync(wiki()))
  expect(Bun.spawnSync(['git', '-C', home, 'rev-parse', '--verify', '-q', 'HEAD']).exitCode).not.toBe(0)
  expect(Bun.spawnSync(['git', '-C', home, 'config', '--get', 'remote.origin.url']).exitCode).toBe(1)
  const pushed = Bun.spawnSync(['git', '-C', b, 'ls-tree', '-r', '--name-only', 'main']).stdout.toString()
  expect(pushed).not.toContain('secret.txt')
  expect(pushed).toContain('index.md')
})

test('AC6 a wiki-state.json that holds null does not stop a later pass', () => {
  setup('PRIVATE')
  const { b, env } = bare()
  expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(0)
  writeFileSync(join(home, 'wiki-state.json'), 'null')
  expect(pushPass(env).exitCode).toBe(0)
  expect(mainOf(b).exitCode).toBe(0)
  expect(state().visibility.value).toBe('PRIVATE')
})

/** a person commit in the wiki */
const person = (msg: string) => {
  git('add', '-A')
  git('-c', 'user.name=p', '-c', 'user.email=person@acme.example', 'commit', '-qm', msg)
}
/** a driver for the blame guard: `before` saves the blame, `after` runs keepPersonLines() then commitWiki() */
function guardPass(mode: 'before' | 'after') {
  const script = join(dir, 'guard.ts')
  const saved = join(dir, 'blame.json')
  writeFileSync(
    script,
    `import { commitWiki, keepPersonLines, wikiBlame } from '${join(import.meta.dir, 'cli')}'
import { readFileSync, writeFileSync } from 'node:fs'
const saved = '${saved}'
if (process.argv[2] === 'before') {
  const b = wikiBlame()
  if (!b) process.exit(3)
  writeFileSync(saved, JSON.stringify([...b]))
} else {
  const ok = keepPersonLines(new Map(JSON.parse(readFileSync(saved, 'utf8'))), 'the pass tidied it')
  if (!ok) process.exit(4)
  commitWiki('write', 'pass')
}
`,
  )
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  return Bun.spawnSync(['bun', script, mode], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_NO_KICK: '1', FACTORY_SELF_UPDATE: '0' },
    stderr: 'pipe',
  })
}
const at = (path: string) => Bun.spawnSync(['git', '-C', wiki(), 'show', `HEAD:${path}`]).stdout.toString()

test('AC4 a pass that changes a person line is put back and flagged; the rest of the pass is kept', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  const mine = readFileSync(join(wiki(), 'glossary.md'), 'utf8').replace(
    'one tracked task in bd',
    'my own words',
  )
  writeFileSync(join(wiki(), 'glossary.md'), mine)
  mkdirSync(join(wiki(), 'rigs'))
  writeFileSync(join(wiki(), 'rigs', 'acme.md'), `${page('topic', 'Acme')}person line\n`)
  person('mine')
  expect(guardPass('before').exitCode).toBe(0)
  writeFileSync(join(wiki(), 'glossary.md'), mine.replace('my own words', 'agent words'))
  writeFileSync(join(wiki(), 'rigs', 'acme.md'), `${page('topic', 'Acme')}agent line\n`)
  writeFileSync(join(wiki(), 'index.md'), page('index', 'New index'))
  writeFileSync(join(wiki(), 'b.md'), page('topic', 'B'))
  expect(guardPass('after').exitCode).toBe(0)
  expect(at('glossary.md')).toBe(mine)
  expect(readFileSync(join(wiki(), 'glossary.md'), 'utf8')).toBe(mine)
  expect(at('needs-person.md')).toContain('kind: "index"')
  expect(at('needs-person.md')).toMatch(/- `glossary.md` line \d+: the pass tidied it\n/)
  expect(at('needs-person.md')).not.toContain('index.md')
  expect(wikiLog()).toContain("wiki: person's line in glossary.md, page kept, flagged")
  expect(at('b.md')).toContain('title: "B"')
  expect(at('index.md')).toContain('New index')
  expect(at('rigs/acme.md')).toContain('agent line')
})

test('AC4 a pass that deletes a page with a person line gets it back; factory-only changes raise no flag', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  const mine = readFileSync(join(wiki(), 'glossary.md'), 'utf8').replace(
    'one tracked task in bd',
    'my own words',
  )
  writeFileSync(join(wiki(), 'glossary.md'), mine)
  person('mine')
  expect(guardPass('before').exitCode).toBe(0)
  rmSync(join(wiki(), 'glossary.md'))
  writeFileSync(join(wiki(), 'index.md'), page('index', 'New index'))
  expect(guardPass('after').exitCode).toBe(0)
  expect(at('glossary.md')).toBe(mine)
  expect(at('needs-person.md')).toContain('`glossary.md`')
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(guardPass('before').exitCode).toBe(0)
  writeFileSync(join(wiki(), 'index.md'), page('index', 'New index'))
  expect(guardPass('after').exitCode).toBe(0)
  expect(at('index.md')).toContain('New index')
  expect(existsSync(join(wiki(), 'needs-person.md'))).toBe(false)
})

test('AC5 a page that a person deleted is not made again; other paths and edits still commit', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  mkdirSync(join(wiki(), 'solutions', '2026-11'), { recursive: true })
  mkdirSync(join(wiki(), 'rigs'))
  writeFileSync(join(wiki(), 'solutions', '2026-11', 'a.md'), page('topic', 'A'))
  writeFileSync(join(wiki(), 'solutions', '2026-11', 'f.md'), page('topic', 'F'))
  writeFileSync(join(wiki(), 'solutions', '2026-11', 'back.md'), page('topic', 'Back'))
  writeFileSync(join(wiki(), 'rigs', 'acme.md'), page('topic', 'Acme'))
  expect(factory(['wiki', 'init']).code).toBe(0)
  git('rm', '-q', 'solutions/2026-11/a.md', 'solutions/2026-11/back.md', 'rigs/acme.md')
  git('-c', 'user.name=p', '-c', 'user.email=person@acme.example', 'commit', '-qm', 'del')
  git('rm', '-q', 'solutions/2026-11/f.md')
  git('-c', 'user.name=factory', `-c`, `user.email=factory@${hostname()}`, 'commit', '-qm', 'factory del')
  mkdirSync(join(wiki(), 'solutions', '2026-11'), { recursive: true })
  mkdirSync(join(wiki(), 'rigs'), { recursive: true })
  writeFileSync(join(wiki(), 'solutions', '2026-11', 'back.md'), page('topic', 'Back'))
  person('back')
  writeFileSync(join(wiki(), 'solutions', '2026-11', 'a.md'), page('topic', 'A again'))
  writeFileSync(join(wiki(), 'solutions', '2026-11', 'f.md'), page('topic', 'F again'))
  writeFileSync(join(wiki(), 'rigs', 'acme.md'), page('topic', 'Acme again'))
  writeFileSync(join(wiki(), 'b.md'), page('topic', 'B'))
  writeFileSync(join(wiki(), 'index.md'), page('index', 'Edited'))
  expect(factory(['wiki', 'init']).code).toBe(0)
  const files = git('ls-files').split('\n')
  expect(files).not.toContain('solutions/2026-11/a.md')
  expect(files).toEqual(
    expect.arrayContaining(['b.md', 'solutions/2026-11/f.md', 'rigs/acme.md', 'solutions/2026-11/back.md']),
  )
  expect(at('index.md')).toContain('Edited')
  expect(wikiLog()).toContain('wiki: tombstoned path solutions/2026-11/a.md, page not made again')
  const t = state().tombstones
  expect(t.map((x: { path: string }) => x.path)).toEqual(['solutions/2026-11/a.md'])
  expect(Date.parse(t[0].at)).toBe(
    Date.parse(git('log', '-1', '--format=%aI', '--diff-filter=D', '--', 'solutions/2026-11/a.md')),
  )
})

test('AC1 --remote wins over FACTORY_WIKI_REMOTE', () => {
  setup('PRIVATE')
  const { env } = bare()
  const other = 'https://github.com/acme/other-wiki.git'
  expect(factory(['wiki', 'init', '--remote', URL_], { ...env, FACTORY_WIKI_REMOTE: other }).code).toBe(0)
  expect(git('config', '--get', 'remote.origin.url')).toBe(URL_)
})

test('AC2 scanPages finds nothing in the seed pages', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  for (const f of ['index.md', 'glossary.md'])
    expect(scanPages([{ path: f, text: readFileSync(join(wiki(), f), 'utf8') }])).toEqual([])
})

test('AC6 the gh argv names the repo and asks for visibility', () => {
  setup('PRIVATE')
  const { env } = bare()
  expect(factory(['wiki', 'init', '--remote', URL_], env).code).toBe(0)
  expect(readFileSync(calls, 'utf8').trim()).toBe(
    'repo view github.com/acme/widget-wiki --json visibility --jq .visibility',
  )
})

test('AC4 a staged delete of a page commits the delete', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  writeFileSync(join(wiki(), 'gone.md'), page('topic', 'Gone'))
  expect(factory(['wiki', 'init']).code).toBe(0)
  const base = commits()
  unlinkSync(join(wiki(), 'gone.md'))
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(commits()).toBe(base + 1)
  expect(git('ls-files').split('\n')).not.toContain('gone.md')
})

test('AC4 a refused rename does not commit the delete of the old path', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  writeFileSync(join(wiki(), 'old.md'), `${page('topic', 'Old')}${'line of text\n'.repeat(40)}`)
  expect(factory(['wiki', 'init']).code).toBe(0)
  const base = commits()
  renameSync(join(wiki(), 'old.md'), join(wiki(), 'new.md'))
  appendFileSync(join(wiki(), 'new.md'), `${TOKEN}\n`)
  expect(factory(['wiki', 'init']).code).toBe(0)
  expect(commits()).toBe(base)
  expect(git('ls-files').split('\n')).toContain('old.md')
  expect(git('ls-files').split('\n')).not.toContain('new.md')
  expect(existsSync(join(wiki(), 'old.md'))).toBe(true)
})

/** run the exported commitWiki() in a child on the temp home; `shim` puts a git wrapper first on PATH */
function commitPass(summary: string, shim = '') {
  const script = join(dir, 'commit.ts')
  writeFileSync(
    script,
    `import { commitWiki } from '${join(import.meta.dir, 'cli')}'\nprocess.exit(commitWiki('p', ${JSON.stringify(summary)}) ? 0 : 1)\n`,
  )
  const sbin = join(dir, 'shim')
  mkdirSync(sbin, { recursive: true })
  if (shim) {
    const real = Bun.which('git')
    writeFileSync(join(sbin, 'git'), `#!/bin/sh\n${shim}\nexec '${real}' "$@"\n`)
    chmodSync(join(sbin, 'git'), 0o755)
  }
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  return Bun.spawnSync(['bun', script, 'noop'], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${sbin}:${bin}:${laptop.PATH}`,
      FACTORY_NO_KICK: '1',
      FACTORY_SELF_UPDATE: '0',
    },
    stderr: 'pipe',
  })
}

test('AC3 a long summary is cut in the commit message', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  writeFileSync(join(wiki(), 'a.md'), page('topic', 'A'))
  expect(commitPass(`${'s'.repeat(500)}\nsecond line`).exitCode).toBe(0)
  expect(git('log', '-1', '--format=%s')).toBe(`wiki p: ${'s'.repeat(200)}`)
})

test('commitWiki makes no commit when diff --cached --quiet fails with exit 128', () => {
  setup()
  expect(factory(['wiki', 'init']).code).toBe(0)
  const base = commits()
  writeFileSync(join(wiki(), 'a.md'), page('topic', 'A'))
  const r = commitPass('x', 'case "$*" in *"diff --cached --quiet") exit 128;; esac')
  expect(r.exitCode).toBe(1)
  expect(commits()).toBe(base)
})
