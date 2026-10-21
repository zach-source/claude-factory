import { expect, test } from 'bun:test'
import { clusterKey, filingActor } from './filing-guard'

test('filingActor reads run and station from a factory created_by only', () => {
  expect(filingActor('factory/acme-r1/review')).toEqual({ run: 'acme-r1', station: 'review' })
  expect(filingActor('factory')).toEqual({})
  for (const c of ['factory-bot', 'factoryx', 'a person', '', undefined])
    expect(filingActor(c)).toBeUndefined()
})

test('clusterKey takes the title before the first : or (, else the first two words', () => {
  expect(clusterKey({ id: 'a', title: 'Worker-hook: x' })).toBe('worker-hook')
  expect(clusterKey({ id: 'a', title: 'widget (y)' })).toBe('widget')
  expect(clusterKey({ id: 'a', title: 'a (b: c)' })).toBe('a')
  expect(clusterKey({ id: 'a', title: 'Fix the flaky test' })).toBe('fix-the')
  expect(clusterKey({ id: 'a', title: ': foo bar' })).toBe('foo-bar')
  expect(clusterKey({ id: 'a', title: '' })).toBe('untitled')
  expect(clusterKey({ id: 'a' })).toBe('untitled')
})

test('clusterKey prefers the parent, from the field or the id', () => {
  expect(clusterKey({ id: 'x', parent: 'acme-9', title: 'Other: y' })).toBe('acme-9')
  expect(clusterKey({ id: 'acme-9.3', title: 'Other: y' })).toBe('acme-9')
})
