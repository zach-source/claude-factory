// `factory wiki find` (claude-factory-tx6c.10). Every test spawns bin/factory with a new temp FACTORY_HOME and
// a fake `gh` first on PATH. The wiki repo is plain git: no `wiki init`, so no gh call.
import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(realpathSync(tmpdir()), `wiki-find-${process.pid}`)
let n = 0
let home = ''
const bin = join(dir, 'bin')
const calls = join(dir, 'gh-calls')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(origin: string | null = 'git@github.com:acme/wiki.git') {
  home = join(dir, `home${++n}`)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${calls}'\nprintf 'PRIVATE\\n'\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  rmSync(calls, { force: true })
  mkdirSync(wiki(), { recursive: true })
  git('init', '-q', '-b', 'main')
  if (origin) git('remote', 'add', 'origin', origin)
}
const ghCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0)
const wiki = () => join(home, 'wiki')
const git = (...args: string[]) => {
  const p = Bun.spawnSync(['git', '-C', wiki(), ...args])
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}
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

const SECTIONS = ['Problem', 'Cause', 'Change', 'Options rejected', 'Verification', 'Still open', 'Links']
/** a valid solution page; `title` is raw YAML text */
const solution = (
  title: string,
  beads = '["acme-3w8o"]',
  prs = '["https://github.com/acme/widget/pull/591"]',
) =>
  `---\nkind: "solution"\ntitle: ${title}\nrigs: ["widget"]\ntopics: ["locks"]\nbeads: ${beads}\nprs: ${prs}\ncause: "proven"\n---\n` +
  SECTIONS.map(s => `## ${s}\n\nneedle text\n`).join('\n')
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(wiki(), path)), { recursive: true })
  writeFileSync(join(wiki(), path), text)
}
const commit = () => {
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x')
}
const LOCK = 'solutions/2026-11/lock.md'
const LINE = `${LOCK}\tFix the widget lock\thttps://github.com/acme/wiki/blob/main/${LOCK}\n`
const base = () => {
  setup()
  put(LOCK, solution('"Fix the widget lock"'))
  commit()
}
const USAGE = 'usage: factory wiki find <bead|pr|word>'

test('AC1 find by bead id: exact entry only', () => {
  base()
  const r = factory(['wiki', 'find', 'acme-3w8o'])
  expect([r.code, r.out]).toEqual([0, LINE])
  for (const q of ['acme-3w8', 'acme-3w8o.1', 'ACME-3W8O']) {
    const x = factory(['wiki', 'find', q])
    expect([q, x.code, x.out]).toEqual([q, 1, ''])
  }
  expect(ghCalls()).toBe(0)
})

test('AC2 find by PR number or URL: a /pull/<n> suffix only', () => {
  base()
  for (const q of ['591', 'https://github.com/acme/widget/pull/591']) {
    const r = factory(['wiki', 'find', q])
    expect([q, r.code, r.out]).toEqual([q, 0, LINE])
  }
  for (const q of ['59', '5911', '0591', '#591']) {
    const r = factory(['wiki', 'find', q])
    expect([q, r.code, r.out]).toEqual([q, 1, ''])
  }
})

test('AC3 find by word: title only, any case, sorted by path', () => {
  base()
  put('solutions/2026-10/queue.md', solution('"Widget queue"', '["acme-1"]', '[]'))
  commit()
  for (const q of ['widget', 'WIDGET']) {
    const r = factory(['wiki', 'find', q])
    expect(r.code).toBe(0)
    expect(
      r.out
        .split('\n')
        .filter(Boolean)
        .map(l => l.split('\t')[0]),
    ).toEqual(['solutions/2026-10/queue.md', LOCK])
  }
  const body = factory(['wiki', 'find', 'needle'])
  expect([body.code, body.out]).toEqual([1, ''])
})

test('AC4 errors: no match, no wiki, usage; init usage stays', () => {
  base()
  const none = factory(['wiki', 'find', 'nomatch'])
  expect([none.code, none.out]).toEqual([1, ''])
  for (const args of [
    ['wiki', 'find'],
    ['wiki', 'find', 'a', 'b'],
  ]) {
    const r = factory(args)
    expect([r.code, r.err]).toEqual([2, `${USAGE}\n`])
  }
  rmSync(join(wiki(), '.git'), { recursive: true })
  const r = factory(['wiki', 'find', 'x'])
  expect([r.code, r.out, r.err.trim()]).toEqual([1, '', 'wiki: not set up: run factory wiki init'])
  expect(factory(['wiki']).err).toContain('usage: factory wiki init [--remote <url>]')
})

test('AC5 find reads only safe pages', () => {
  setup()
  put(LOCK, solution('"Fix the widget lock"'))
  put('solutions/2026-11/bad.md', 'no frontmatter acme-3w8o\n')
  put('solutions/2026-11/link.md', 'x')
  linkSync(join(wiki(), LOCK), join(wiki(), 'solutions/2026-11/hard.md'))
  commit()
  const outside = join(dir, 'outside.md')
  writeFileSync(outside, solution('"Outside widget"'))
  rmSync(join(wiki(), 'solutions/2026-11/link.md'))
  symlinkSync(outside, join(wiki(), 'solutions/2026-11/link.md'))
  put('solutions/2026-11/untracked.md', solution('"Untracked widget"'))
  // lock.md and hard.md share one inode: find refuses both
  let r = factory(['wiki', 'find', 'widget'])
  expect([r.code, r.out]).toEqual([1, ''])
  rmSync(join(wiki(), 'solutions/2026-11/hard.md'))
  r = factory(['wiki', 'find', 'widget'])
  expect([r.code, r.out]).toEqual([0, LINE])
  expect(ghCalls()).toBe(0)
})

test('AC5 control chars in a title become spaces; no origin gives an empty third column', () => {
  setup(null)
  put(LOCK, solution('"A\\tB\\u001bC widget"'))
  commit()
  const r = factory(['wiki', 'find', 'widget'])
  expect([r.code, r.out]).toEqual([0, `${LOCK}\tA B C widget\t\n`])
  git('remote', 'add', 'origin', 'file:///srv/wiki.git')
  expect(factory(['wiki', 'find', 'widget']).out).toBe(`${LOCK}\tA B C widget\t\n`)
  expect(ghCalls()).toBe(0)
})

test('AC7 find takes no wiki.lock', () => {
  base()
  mkdirSync(join(home, 'wiki.lock'), { recursive: true })
  const pid = join(home, 'wiki.lock', 'pid')
  writeFileSync(pid, String(process.pid))
  const r = factory(['wiki', 'find', 'acme-3w8o'])
  expect([r.code, r.out]).toEqual([0, LINE])
  expect(readFileSync(pid, 'utf8')).toBe(String(process.pid))
})

test('AC9 a worker cannot run find', () => {
  base()
  const r = factory(['wiki', 'find', 'x'], { FACTORY_RUN: 'r1' })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('a worker cannot run factory wiki')
})
