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
  utimesSync,
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
const factory = (args: readonly string[], env: Record<string, string> = {}) => {
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

test.each([{ args: ['wiki', 'find', 'acme-3w8o'] }, { args: ['wiki', 'status'] }])(
  'ot1ew wiki busy matrix %p',
  ({ args }) => {
    base()
    const before = readFileSync(join(wiki(), LOCK), 'utf8')
    const gitCalls = join(dir, 'git-calls')
    for (const tool of ['git', 'bd']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' '${tool}' >> '${gitCalls}'\nexit 99\n`)
      chmodSync(join(bin, tool), 0o755)
    }
    mkdirSync(join(home, 'wiki.lock'), { recursive: true })
    const pid = join(home, 'wiki.lock', 'pid')
    writeFileSync(pid, String(process.pid))
    const r = factory(args)
    expect([r.code, r.out, r.err.trim()]).toEqual([1, '', 'wiki: busy'])
    expect(existsSync(gitCalls)).toBe(false)
    expect(ghCalls()).toBe(0)
    expect(readFileSync(join(wiki(), LOCK), 'utf8')).toBe(before)
    expect(readFileSync(pid, 'utf8')).toBe(String(process.pid))
    for (const invalid of [
      ['wiki', 'find'],
      ['wiki', 'status', 'extra'],
    ]) {
      expect(factory(invalid).code).toBe(2)
    }
    expect(factory(args, { FACTORY_RUN: 'r1' }).err).toContain('a worker cannot')
    expect(existsSync(gitCalls)).toBe(false)
  },
)

test('AC9 a worker cannot run find', () => {
  base()
  const r = factory(['wiki', 'find', 'x'], { FACTORY_RUN: 'r1' })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('a worker cannot run factory wiki')
})

// ---- factory wiki status (claude-factory-tx6c.10.2) ----
const bdCalls = join(dir, 'bd-calls')
const bdFail = join(dir, 'bd-fail')
/** a fake bd: it logs its arguments, fails when bdFail exists, else prints the given JSON */
function fakeBd(json: string) {
  writeFileSync(
    join(bin, 'bd'),
    `#!/bin/sh\necho "$*" >> '${bdCalls}'\nif [ -e '${bdFail}' ]; then echo boom >&2; exit 1; fi\nprintf '%s' '${json}'\n`,
  )
  chmodSync(join(bin, 'bd'), 0o755)
  rmSync(bdCalls, { force: true })
  rmSync(bdFail, { force: true })
}
const bdLog = () => (existsSync(bdCalls) ? readFileSync(bdCalls, 'utf8').trim().split('\n') : [])
const status = (env: Record<string, string> = {}) => {
  const r = factory(['wiki', 'status'], env)
  return { ...r, json: r.out ? JSON.parse(r.out) : null }
}
const stamp = (name: string, iso: string) => {
  writeFileSync(join(home, name), '')
  utimesSync(join(home, name), new Date(iso), new Date(iso))
}
const KEYS = ['lastRefresh', 'lastWrite', 'lastGroom', 'groomPr', 'pending', 'flags', 'visibility']
const repoDir = () => join(dir, 'widget-repo')
const rigs = () => {
  mkdirSync(join(repoDir(), '.beads'), { recursive: true })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'widget', repo: repoDir() }]))
}

test('AC6 status with an empty home: all null, flags empty', () => {
  setup(null)
  const r = status()
  expect(r.code).toBe(0)
  expect(Object.keys(r.json)).toEqual(KEYS)
  expect(r.json).toEqual({
    lastRefresh: null,
    lastWrite: null,
    lastGroom: null,
    groomPr: null,
    pending: [],
    flags: [],
    visibility: null,
  })
})

test('AC6 status with a full fixture; AC8 read-only', () => {
  base()
  put('solutions/2026-11/one.md', solution('"One"', '["acme-1"]', '[]'))
  commit()
  fakeBd('[{"id":"acme-1"},{"id":"acme-2"},{"id":"acme-3"}]')
  rigs()
  stamp('wiki-refresh.stamp', '2026-11-05T10:00:00.000Z')
  stamp('wiki-write.stamp', '2026-11-05T11:00:00.000Z')
  stamp('wiki-groom.stamp', '2026-11-05T12:00:00.000Z')
  const state = JSON.stringify({
    written: { 'acme-3': 'x' },
    groomPr: { url: 'https://github.com/acme/wiki/pull/2' },
    visibility: { value: 'PRIVATE', checkedAt: '2026-11-05T00:00:00Z', remote: 'github.com/acme/wiki' },
  })
  writeFileSync(join(home, 'wiki-state.json'), state)
  put('needs-person.md', '# Needs a person\n- `a.md` line 3: bad\tx\n- `b.md` line 4: worse\nnot a flag\n')
  const r = status()
  expect(r.code).toBe(0)
  expect(Object.keys(r.json)).toEqual(KEYS)
  expect(r.json).toEqual({
    lastRefresh: '2026-11-05T10:00:00.000Z',
    lastWrite: '2026-11-05T11:00:00.000Z',
    lastGroom: '2026-11-05T12:00:00.000Z',
    groomPr: { url: 'https://github.com/acme/wiki/pull/2' },
    pending: [{ rig: 'widget', id: 'acme-2' }],
    flags: ['- `a.md` line 3: bad x', '- `b.md` line 4: worse'],
    visibility: 'PRIVATE',
  })
  expect(ghCalls()).toBe(0)
  expect(readFileSync(join(home, 'wiki-state.json'), 'utf8')).toBe(state)
  expect(bdLog().length).toBe(1)
  for (const l of bdLog()) expect(l.startsWith('list --status closed --closed-after ')).toBe(true)
})

test('AC6 a wiki-state.json of null, an array or junk gives nulls', () => {
  setup(null)
  for (const text of ['null', '[]', '{{junk', '{"groomPr":{"url":3},"visibility":{"value":"WEIRD"}}']) {
    writeFileSync(join(home, 'wiki-state.json'), text)
    const r = status()
    expect([text, r.code, r.json.groomPr, r.json.visibility]).toEqual([text, 0, null, null])
  }
})

test('AC8 a failed bd leaves the rig out and exits 0; a symlinked needs-person.md gives no flags', () => {
  base()
  fakeBd('[]')
  rigs()
  writeFileSync(bdFail, '')
  const outside = join(dir, 'secret.md')
  writeFileSync(outside, '- leaked\n')
  symlinkSync(outside, join(home, 'wiki', 'needs-person.md'))
  const r = status()
  expect([r.code, r.json.pending, r.json.flags]).toEqual([0, [], []])
  expect(r.err).toContain('wiki status: rig widget bead list failed')
})

test.each([{ args: ['wiki', 'find', 'acme-3w8o'] }, { args: ['wiki', 'status'] }])(
  'ot1ew wiki lock lifetime and unlocked controls %p',
  ({ args }) => {
    base()
    const realGit = Bun.which('git')!
    const log = join(dir, 'lock-calls')
    const pid = join(home, 'wiki.lock', 'pid')
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\npid=$(cat '${pid}' 2>/dev/null || true)\nheld=no\nif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ! mkdir '${home}/wiki.lock' 2>/dev/null; then held=yes; fi\nprintf '%s:%s\\n' "$pid" "$held" >> '${log}'\nexec '${realGit}' "$@"\n`,
    )
    chmodSync(join(bin, 'git'), 0o755)
    mkdirSync(join(home, 'dream.lock'))
    writeFileSync(join(home, 'dream.lock', 'pid'), String(process.pid))
    const r = factory(args)
    expect(r.code).toBe(0)
    if (args[1] === 'find') expect(r.out).toBe(LINE)
    else expect(JSON.parse(r.out)).toHaveProperty('pending')
    for (const call of readFileSync(log, 'utf8').trim().split('\n')) expect(call).toMatch(/^[1-9][0-9]*:yes$/)
    expect(existsSync(join(home, 'wiki.lock'))).toBe(false)
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 1\n')
    factory(args)
    expect(existsSync(join(home, 'wiki.lock'))).toBe(false)
    expect(factory(args).err).not.toContain('wiki: busy')
  },
)

test('AC9 a worker cannot run status', () => {
  base()
  const r = factory(['wiki', 'status'], { FACTORY_RUN: 'r1' })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain('a worker cannot run factory wiki')
})
