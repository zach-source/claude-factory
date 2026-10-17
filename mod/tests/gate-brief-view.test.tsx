import { expect, test } from 'claude-code/testing'
import { briefContext, interviewPrompt, interviews } from '../hooks/view'
import type { FactoryRun } from '../types'

const run = (gate?: { question: string; outcomes: string[]; brief?: string }): FactoryRun => ({
  id: 'r1',
  rig: 'api',
  node: 'release',
  sub: 'working',
  since: 10,
  gate,
  agent: undefined,
})

test('briefContext is "" with no brief, and "Brief: " plus the redacted first line with one', () => {
  expect(briefContext(undefined)).toBe('')
  expect(briefContext('line one\nline two')).toBe('Brief: line one')
  // line() collapses the runs of whitespace that redact() leaves behind where it removed the URL and the SHA
  expect(briefContext('See https://example.com/pr/9 and a1b2c3d4e5f6 for detail\nmore')).toBe(
    'Brief: See and for detail',
  )
})

test("interviews() fills a gate item's context and details from gate.brief, redacting only context", () => {
  const noBrief = interviews([run({ question: 'Ship it?', outcomes: ['ship', 'hold'] })])
  expect(noBrief).toHaveLength(1)
  expect(noBrief[0]!.context).toBe('')
  expect(noBrief[0]!.details).toBe('')
  expect(noBrief[0]!.needsProposal).toBe(false)

  const brief = 'PR #9 at https://example.com/pr/9, CI green\nverify: clean\nreview: approved, no findings'
  const withBrief = interviews([run({ question: 'Ship it?', outcomes: ['ship', 'hold'], brief })])
  expect(withBrief[0]!.context).toBe('Brief: PR #9 at CI green') // the URL is gone from the one-line context
  expect(withBrief[0]!.details).toBe(brief) // the full brief, URL kept, behind the details toggle
})

test('a gate item never reaches interviewPrompt, brief or no brief', () => {
  const withBrief = interviews([run({ question: 'Ship it?', outcomes: ['ship', 'hold'], brief: 'ok' })])
  const noBrief = interviews([run({ question: 'Ship it?', outcomes: ['ship', 'hold'] })])
  expect(interviewPrompt(withBrief)).toBeNull()
  expect(interviewPrompt(noBrief)).toBeNull()
})
