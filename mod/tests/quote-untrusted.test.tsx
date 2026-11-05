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
  expectSingleQuoted(manual('factory'), ['question', 'label: effect | label: effect', 'sentence', 'text'])
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

test('the patrol passes file-elsewhere text in single quotes', () => {
  expectSingleQuoted(PATROL('factory'), ['title', 'description'])
})
