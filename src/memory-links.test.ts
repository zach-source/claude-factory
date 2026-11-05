// claude-factory-eqxi: a symlink in the memory store is never read and a dream removes it
import { expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coreNotes,
  corpus,
  dropLinks,
  formatLong,
  inboxCount,
  noteExists,
  outline,
  search,
  walk,
  appendStore,
  readStore,
  use,
  writeStore,
  tryRead,
  skills,
  skillSources,
  skillsDir,
  pendingSkills,
  installSkill,
} from './memory'

const MARKER = 'zqsecret-eqxi'
const linkStore = () => {
  const root = join(tmpdir(), `memory-links-${process.pid}-${Math.random().toString(36).slice(2)}`)
  const dir = join(root, 'mem')
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  mkdirSync(join(dir, 'topic'), { recursive: true })
  const secret = join(root, 'secret')
  writeFileSync(secret, `---\nsummary: ${MARKER}\n---\n- ${MARKER}\n${MARKER}\n`)
  return { root, dir, secret }
}

test('dropLinks removes every kind of link and keeps files, targets and .git links', () => {
  const { root, dir, secret } = linkStore()
  const real = join(root, 'realdir')
  mkdirSync(real)
  writeFileSync(join(real, 'a.md'), MARKER)
  mkdirSync(join(dir, 'topic', 'sub'))
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, 'inbox', 'x.md'), 'plain')
  symlinkSync(secret, join(dir, 'inbox', 'y.md'))
  symlinkSync(secret, join(dir, 'inbox', 'noext'))
  symlinkSync(secret, join(dir, '.index.json'))
  symlinkSync(real, join(dir, 'topic', 'linkdir'))
  symlinkSync('/nonexistent', join(dir, 'topic', 'sub', 'dangle.md'))
  symlinkSync(secret, join(dir, '.git', 'keep'))
  const out = dropLinks(dir)
  expect(out.map(l => l.path).sort()).toEqual(
    ['.index.json', 'inbox/noext', 'inbox/y.md', 'topic/linkdir', 'topic/sub/dangle.md'].sort(),
  )
  expect(out.find(l => l.path === 'inbox/y.md')!.target).toBe(secret)
  for (const p of ['inbox/y.md', 'inbox/noext', '.index.json', 'topic/linkdir', 'topic/sub/dangle.md'])
    expect(() => lstatSync(join(dir, p))).toThrow()
  expect(readFileSync(join(dir, 'inbox', 'x.md'), 'utf8')).toBe('plain')
  expect(readFileSync(secret, 'utf8')).toContain(MARKER)
  expect(readFileSync(join(real, 'a.md'), 'utf8')).toBe(MARKER)
  expect(lstatSync(join(dir, '.git', 'keep')).isSymbolicLink()).toBe(true)
  expect(dropLinks(dir)).toEqual([])
  rmSync(root, { recursive: true, force: true })
})

test('a link to a secret gives no text from walk, corpus, outline, coreNotes, search, inboxCount, noteExists', async () => {
  const { root, dir, secret } = linkStore()
  symlinkSync(secret, join(dir, 'inbox', 'y.md'))
  const longSecret = join(root, 'long-secret')
  writeFileSync(longSecret, formatLong([{ id: 'bd-lock', summary: MARKER, body: MARKER }]))
  symlinkSync(longSecret, join(dir, 'topic', 'LONG.md'))
  symlinkSync(secret, join(dir, 'topic', 'README.md'))
  symlinkSync(secret, join(dir, 'CORE.md'))
  const w = walk(dir)
  expect(JSON.stringify([...w.notes, ...w.topics.values()])).not.toContain(MARKER)
  expect(w.notes.some(n => n.path.includes('y.md'))).toBe(false)
  expect(corpus(dir)).not.toContain(MARKER)
  expect(JSON.stringify(outline(dir))).not.toContain(MARKER)
  expect(JSON.stringify(coreNotes(dir))).not.toContain(MARKER)
  expect(JSON.stringify(await search(dir, 'zqsecret'))).not.toContain(MARKER)
  expect(JSON.stringify(await search(dir, 'zqsecret', { core: false }))).not.toContain(MARKER)
  expect(inboxCount(dir)).toBe(0)
  expect(noteExists(dir, 'inbox/y.md')).toBe(false)
  expect(noteExists(dir, 'topic/LONG.md#bd-lock')).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('regular notes, README and CORE.md are still read', async () => {
  const { root, dir } = linkStore()
  writeFileSync(join(dir, 'inbox', 'x.md'), '---\nsummary: zqplain note\n---\nbody\n')
  writeFileSync(join(dir, 'topic', 'README.md'), '---\nsummary: zqplain topic\n---\nbody\n')
  writeFileSync(join(dir, 'CORE.md'), '# CORE\n\n- zqplain core fact\n')
  expect(inboxCount(dir)).toBe(1)
  expect(walk(dir).topics.has('topic')).toBe(true)
  expect(corpus(dir)).toContain('zqplain core fact')
  expect(JSON.stringify(outline(dir))).toContain('zqplain core fact')
  expect(coreNotes(dir).length).toBe(1)
  expect(noteExists(dir, 'inbox/x.md')).toBe(true)
  expect(JSON.stringify(await search(dir, 'zqplain'))).toContain('zqplain')
  rmSync(root, { recursive: true, force: true })
})

test('store helpers throw on a link and leave the target alone; a regular file works', () => {
  const { root, dir, secret } = linkStore()
  const before = readFileSync(secret, 'utf8')
  const link = join(dir, 'inbox', 'z.md')
  symlinkSync(secret, link)
  expect(() => readStore(link, 'utf8')).toThrow(/ELOOP/)
  expect(() => writeStore(link, 'x')).toThrow(/ELOOP/)
  expect(() => appendStore(link, 'x')).toThrow(/ELOOP/)
  expect(readFileSync(secret, 'utf8')).toBe(before)
  const plain = join(dir, 'inbox', 'p.md')
  writeStore(plain, 'a')
  appendStore(plain, 'b')
  expect(readStore(plain, 'utf8')).toBe('ab')
  rmSync(root, { recursive: true, force: true })
})

test('a writer with a link at its path throws and the target stays unchanged', () => {
  const { root, dir, secret } = linkStore()
  const before = readFileSync(secret, 'utf8')
  symlinkSync(secret, join(dir, '.usage.jsonl'))
  expect(() => use(dir, ['topic/a.md'], 'helped')).toThrow(/ELOOP/)
  expect(readFileSync(secret, 'utf8')).toBe(before)
  rmSync(root, { recursive: true, force: true })
})

test('writeStore truncates a longer file', () => {
  const { root, dir } = linkStore()
  const f = join(dir, 'inbox', 't.md')
  writeStore(f, 'a long text of many bytes')
  writeStore(f, 'short')
  expect(readFileSync(f, 'utf8')).toBe('short')
  rmSync(root, { recursive: true, force: true })
})

test('tryRead gives null on a link or a missing file and rethrows other errors', () => {
  const { root, dir, secret } = linkStore()
  const link = join(dir, 'inbox', 'z.md')
  symlinkSync(secret, link)
  expect(tryRead(link)).toBeNull()
  expect(tryRead(join(dir, 'inbox', 'missing.md'))).toBeNull()
  expect(() => tryRead(join(dir, 'inbox'))).toThrow(/EISDIR/)
  rmSync(root, { recursive: true, force: true })
})

test('skills skips a linked SKILL.md; installSkill copies no link', () => {
  const { root, dir, secret } = linkStore()
  const src = join(skillSources(dir), 'a')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'SKILL.md'), 'description: real\n')
  symlinkSync(secret, join(src, 'leak.md'))
  const b = join(skillSources(dir), 'b')
  mkdirSync(b, { recursive: true })
  symlinkSync(secret, join(b, 'SKILL.md'))
  expect(skills(dir)).toEqual([{ name: 'a', description: 'real' }])
  mkdirSync(skillsDir(dir), { recursive: true })
  expect(pendingSkills(dir).some(p => p.name === 'a')).toBe(true)
  installSkill(dir, 'a')
  expect(existsSync(join(skillsDir(dir), 'a', 'SKILL.md'))).toBe(true)
  expect(existsSync(join(skillsDir(dir), 'a', 'leak.md'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})
