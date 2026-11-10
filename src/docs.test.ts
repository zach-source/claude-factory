// docs/console.md must have one subsection per console tab, with the right key, no section for a
// removed tab, and every image link resolving to a real file. Parses TABS out of
// mod/hooks/views.tsx as text, so a future tab change (add, remove, rename, rekey) fails this test
// structurally, without the test itself ever naming a removed tab's label.
import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

const docFiles = () => [
  join(root, 'README.md'),
  ...readdirSync(join(root, 'docs'))
    .filter(f => f.endsWith('.md'))
    .map(f => join(root, 'docs', f)),
]

test('README.md and docs/*.md name no deleted script', () => {
  for (const f of docFiles()) {
    const text = readFileSync(f, 'utf8')
    expect(text).not.toContain('bin/factory' + '-up')
    expect(text).not.toContain('push' + '-worker')
    expect(text).not.toContain('bin/' + 'up')
  }
})

test('no doc line tells the person to edit rigs.json or devenv.json by hand', () => {
  for (const f of docFiles())
    for (const line of readFileSync(f, 'utf8').split('\n'))
      if (/rigs\.json|devenv\.json/.test(line)) expect(line).not.toMatch(/by hand|\bedit(s|ed)?\b/i)
})

test('README.md names each new command', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const c of [
    'factory up',
    'factory settings set',
    'devenv.builder',
    'factory image build',
    'factory token',
    'rig set',
    'rig show',
    'rig env set',
    'rig env unset',
    'rig egress add',
    'rig egress rm',
    'rig beads-remote set',
    'rig beads-remote clear',
    'rig history',
    'rig undo',
  ])
    expect(readme).toContain(c)
})

test('the settings usage line names the devenv keys', () => {
  const line = readFileSync(join(root, 'src/cli.ts'), 'utf8')
    .split('\n')
    .find(l => l.startsWith('  settings [list]'))
  expect(line).toContain('devenv.builder')
})

test('docs/server.md names worker routes, each owner step, both modes and the way back; README links it', () => {
  const text = readFileSync(join(root, 'docs/server.md'), 'utf8')
  for (const s of [
    'S2',
    'dm-g14',
    'S8',
    'SVID',
    'FACTORY_SERVER',
    'port 8444',
    'PVC',
    'person CA',
    'Local mode',
    'Server mode',
    'The way back',
  ])
    expect(text).toContain(s)
  expect(text).toContain('report, mail and progress')
  expect(text).toContain('--worker-port 8443 --worker-key <path>')
  expect(text).not.toContain('no worker API route today')
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('docs/server.md')
})
