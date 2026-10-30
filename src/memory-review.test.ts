// claude-factory-ag2.1: the reviewer's store helpers: stable keys, the pending list, a strict answer parse.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReview, pendingReviews, reviewItems, reviewKey, skillSources, skillsDir } from './memory'

const dir = join(tmpdir(), `memory-review-${process.pid}`)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const skill = (root: string, name: string, text: string) => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), text)
}
const proposal = (name: string, status: string, change: string) => {
  mkdirSync(join(dir, '.proposals'), { recursive: true })
  writeFileSync(
    join(dir, '.proposals', `${name}.md`),
    `---\nrung: core\ntarget: CORE.md\nstatus: ${status}\n---\n${change}\n`,
  )
}
const fence = (o: unknown) => `text\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n`

test('reviewKey: kind, name and 12 hex of the text hash; other text, other key', () => {
  const k = reviewKey('skill', 'a', 'x')
  expect(k).toMatch(/^skill:a:[0-9a-f]{12}$/)
  expect(reviewKey('skill', 'a', 'x')).toBe(k)
  expect(reviewKey('skill', 'a', 'y')).not.toBe(k)
})

test('pendingReviews: a new, changed and reaped skill and a pending proposal; reviewed keys are left out', () => {
  rmSync(dir, { recursive: true, force: true })
  skill(skillSources(dir), 'new-one', '---\ndescription: n\n---\nbody\n')
  skill(skillSources(dir), 'chg', '---\ndescription: c\n---\nv2\n')
  skill(skillsDir(dir), 'chg', '---\ndescription: c\n---\nv1\n')
  skill(skillsDir(dir), 'gone', '---\ndescription: g\n---\nold\n')
  skill(skillSources(dir), 'same', 's')
  skill(skillsDir(dir), 'same', 's')
  proposal('p1', 'pending', 'Run prettier.')
  proposal('p2', 'installed', 'Done already.')
  const items = reviewItems(dir)
  expect(items.map(i => `${i.kind}:${i.name}`)).toEqual([
    'skill:chg',
    'skill:gone',
    'skill:new-one',
    'proposal:p1',
  ])
  expect(items.map(i => i.change)).toEqual(['changed', 'reaped', 'new', 'pending'])
  expect(items[0]!.text).toContain('v2')
  const store = { [items[0]!.key]: { recommendation: 'reject' as const, why: 'w', at: 't' } }
  expect(pendingReviews(dir, store).map(i => i.key)).toEqual(items.slice(1).map(i => i.key))
  // a skill whose text changes gets a new key, so a new review
  skill(skillSources(dir), 'chg', '---\ndescription: c\n---\nv3\n')
  expect(pendingReviews(dir, store).length).toBe(4)
})

test('parseReview: the last fenced json block, strict', () => {
  expect(parseReview(fence({ recommendation: 'install', why: 'Useful.' }))).toEqual({
    recommendation: 'install',
    why: 'Useful.',
  })
  expect(
    parseReview(
      fence({ recommendation: 'install', why: 'a' }) + fence({ recommendation: 'reject', why: 'b' }),
    ),
  ).toEqual({ recommendation: 'reject', why: 'b' })
  expect(parseReview(fence({ recommendation: 'reject', why: 'x'.repeat(400) })).why).toHaveLength(300)
  expect(parseReview(fence({ recommendation: 'reject', why: 'a\nb\r\n\tc' })).why).toBe('a b c')
})

test.each([
  ['no fence', '{"recommendation":"install","why":"x"}'],
  ['Install', fence({ recommendation: 'Install', why: 'x' })],
  ['approve', fence({ recommendation: 'approve', why: 'x' })],
  ['why missing', fence({ recommendation: 'install' })],
  ['why empty', fence({ recommendation: 'install', why: '   ' })],
  ['why a number', fence({ recommendation: 'install', why: 3 })],
  ['bad json', '```json\n{nope\n```'],
  ['an array', '```json\n["install"]\n```'],
])('parseReview refuses: %s', (_n, answer) => {
  expect(() => parseReview(answer)).toThrow()
})
