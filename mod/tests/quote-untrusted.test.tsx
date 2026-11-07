import { expect, test } from 'claude-code/testing'
import { manual } from '../hooks/register'
import { badPlaceholders, fileFormBad, fileSpans, placeholderSpans } from './quote-checks'

// The patrol step file gets the same checks in src/steps.test.ts (the mod tests cannot read src/steps/).
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

test('no cli command span in the manual holds a double-quoted placeholder', () => {
  const spans = placeholderSpans(manual('factory'))
  expect(spans.length).toBeGreaterThan(5)
  for (const s of spans) expect(s).not.toContain('"<')
})

test('memory search and --goal placeholders are single-quoted', () => {
  expect(manual('factory')).not.toMatch(/memory search <|--goal <|memory search "/)
})

test('every non-ID placeholder in a factory command span is single-quoted', () => {
  expect(badPlaceholders(manual('factory'))).toEqual([])
  expect(badPlaceholders('`factory memory search <query>`')).toEqual(['<query>'])
  expect(badPlaceholders('`factory mail <run> <station> "<text>"`')).toEqual(['<text>'])
  expect(badPlaceholders("`factory show <run> --title '<title>'`")).toEqual([])
})

// claude-factory-2z48: text from a bead, Linear or a worker report reaches file-elsewhere and decisions propose by file
test('the checker refuses a quoted or unlisted placeholder and accepts a path', () => {
  expect(fileFormBad("`factory file-elsewhere <rig> --title '<title>'`")).toEqual(["'<title>'"])
  expect(fileFormBad('`factory file-elsewhere <rig> --title "<title>"`')).toEqual(['"<title>"'])
  expect(fileFormBad('`factory file-elsewhere <rig> --title <title>`')).toEqual(['<title>'])
  expect(fileFormBad("`factory decisions propose <key> '<question>'`")).toEqual(["'<question>'"])
  expect(fileFormBad('`factory file-elsewhere <rig> --title-file <path>`')).toEqual([])
})

test('the manual passes file-elsewhere and decisions propose text by file', () => {
  const t = manual('factory')
  expect(fileSpans(t).length).toBeGreaterThan(0)
  expect(fileFormBad(t)).toEqual([])
  expect(t).toMatch(/never put (them|the question, options and context) in the command/)
  expect(t).toContain('Write tool')
  expect(t).toContain('`factory home`')
  expect(t).toContain('--question-file <path>')
})
