import { expect, test } from 'claude-code/testing'
import { PATROL, manual } from '../hooks/register'

// claude-factory-dgok: untrusted text must not sit in shell double quotes ($(...), backticks and $VAR expand there).
const expectSingleQuoted = (t: string, placeholders: string[]) => {
  const spans = (t.match(/`[^`]*`/g) ?? []).filter(s =>
    /file-elsewhere|decisions propose|decisions answer/.test(s),
  )
  expect(spans.length).toBeGreaterThan(0)
  for (const s of spans) expect(s).not.toContain('"<')
  for (const p of placeholders) expect(spans.join('\n')).toContain(`'<${p}>'`)
  expect(t).toContain("'\\''")
  expect(t).toContain('single quotes')
}

test('the manager manual passes decisions text in single quotes', () => {
  expectSingleQuoted(manual('factory'), ['text'])
})

test('no cli command span in the manual or the patrol holds a double-quoted placeholder', () => {
  for (const t of [manual('factory'), PATROL('factory')]) {
    const spans = (t.match(/`factory [^`]*`/g) ?? []).filter(s => s.includes('<'))
    expect(spans.length).toBeGreaterThan(5)
    for (const s of spans) expect(s).not.toContain('"<')
  }
})

test('memory search and --goal placeholders are single-quoted', () => {
  for (const t of [manual('factory'), PATROL('factory')]) {
    expect(t).not.toMatch(/memory search <|--goal <|memory search "/)
  }
})

const ID_PLACEHOLDERS = new Set([
  'run',
  'outcome',
  'name',
  'repo',
  'rig',
  'bead',
  'key',
  'station',
  'station|done',
  'factory',
  'rig|repo',
  'old note path',
  'source rig',
  'source id',
  'path',
])
const badPlaceholders = (t: string) =>
  (t.match(/`factory [^`]*`/g) ?? []).flatMap(s =>
    (s.replace(/'<[^>]*>'/g, '').match(/<[^>]*>/g) ?? []).filter(p => !ID_PLACEHOLDERS.has(p.slice(1, -1))),
  )

test('every non-ID placeholder in a factory command span is single-quoted', () => {
  for (const t of [manual('factory'), PATROL('factory')]) expect(badPlaceholders(t)).toEqual([])
  expect(badPlaceholders('`factory memory search <query>`')).toEqual(['<query>'])
  expect(badPlaceholders('`factory mail <run> <station> "<text>"`')).toEqual(['<text>'])
  expect(badPlaceholders("`factory show <run> --title '<title>'`")).toEqual([])
})

// claude-factory-2z48: text from a bead, Linear or a worker report reaches file-elsewhere and decisions propose by file
const FILE_OK = new Set(['run', 'rig', 'bead', 'key', 'source rig', 'source id', 'path'])
const fileSpans = (t: string) =>
  (t.match(/`[^`]*`/g) ?? []).filter(s => /file-elsewhere|decisions propose/.test(s))
const fileFormBad = (t: string) =>
  fileSpans(t).flatMap(s =>
    (s.match(/['"]?<[^>]*>['"]?/g) ?? []).filter(
      p => /^['"]/.test(p) || !FILE_OK.has(p.replace(/^<|>$/g, '')),
    ),
  )

test('the checker refuses a quoted or unlisted placeholder and accepts a path', () => {
  expect(fileFormBad("`factory file-elsewhere <rig> --title '<title>'`")).toEqual(["'<title>'"])
  expect(fileFormBad('`factory file-elsewhere <rig> --title "<title>"`')).toEqual(['"<title>"'])
  expect(fileFormBad('`factory file-elsewhere <rig> --title <title>`')).toEqual(['<title>'])
  expect(fileFormBad("`factory decisions propose <key> '<question>'`")).toEqual(["'<question>'"])
  expect(fileFormBad('`factory file-elsewhere <rig> --title-file <path>`')).toEqual([])
})

test('the manual and the patrol pass file-elsewhere and decisions propose text by file', () => {
  for (const t of [manual('factory'), PATROL('factory')]) {
    expect(fileSpans(t).length).toBeGreaterThan(0)
    expect(fileFormBad(t)).toEqual([])
    expect(t).toContain('Write tool')
    expect(t).toContain('`factory home`')
  }
  expect(manual('factory')).toContain('--question-file <path>')
  expect(PATROL('factory')).toContain('--title-file <path>')
})
