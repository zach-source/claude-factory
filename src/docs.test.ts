// docs/console.md must have one subsection per console tab, with the right key, no section for a
// removed tab, and every image link resolving to a real file. Parses TABS out of
// mod/hooks/views.tsx as text, so a future tab change (add, remove, rename, rekey) fails this test
// structurally, without the test itself ever naming a removed tab's label.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dir, '..')
const viewsSrc = readFileSync(join(root, 'mod/hooks/views.tsx'), 'utf8')
const docsPath = join(root, 'docs/console.md')

function tabs() {
  const out: { label: string; key: string }[] = []
  const re = /\['(\w+)', '([^']+)', '(\d)'\]/g
  for (const m of viewsSrc.matchAll(re)) out.push({ label: m[2]!, key: m[3]! })
  return out
}

test('TABS has at least the 6 known tabs', () => {
  expect(tabs().length).toBeGreaterThanOrEqual(6)
})

test('docs/console.md has one "## <Label> (key <n>)" heading per TABS entry, no more, no fewer', () => {
  expect(existsSync(docsPath)).toBe(true)
  const text = readFileSync(docsPath, 'utf8')
  const headingRe = /^## (.+) \(key (\d)\)$/gm
  const found = [...text.matchAll(headingRe)].map(m => ({ label: m[1]!, key: m[2]! }))
  const expected = tabs()
  expect(found.length).toBe(expected.length)
  for (const e of expected) expect(found).toContainEqual(e)
  for (const f of found) expect(expected).toContainEqual(f)
})

test('every image link in docs/console.md resolves to a file that exists', () => {
  const text = readFileSync(docsPath, 'utf8')
  const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g
  const links = [...text.matchAll(imgRe)].map(m => m[1]!)
  expect(links.length).toBeGreaterThan(0)
  for (const link of links) expect(existsSync(join(dirname(docsPath), link))).toBe(true)
})

test('README.md links docs/console.md', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  expect(readme).toContain('docs/console.md')
})
