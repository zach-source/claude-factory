import { expect, test } from 'bun:test'
import { decide, lastSession, managerLine, withResume } from './managerhost'

test('herdr down restarts everything, a live herdr with no pane restarts the manager only', () => {
  expect(decide({ herdrUp: false, panes: 0 })).toBe('restart-all')
  expect(decide({ herdrUp: true, panes: 0 })).toBe('start-manager')
  expect(decide({ herdrUp: true, panes: 1 })).toBe('none')
})

test('a restart resumes the newest known session and replaces an old --resume', () => {
  expect(withResume(['--model', 'x'])).toEqual(['--model', 'x'])
  expect(withResume(['--model', 'x'], 's2')).toEqual(['--model', 'x', '--resume', 's2'])
  expect(withResume(['-r', 's1', '--model', 'x'], 's2')).toEqual(['--model', 'x', '--resume', 's2'])
  expect(lastSession(JSON.stringify([{ session: 's1' }, { session: 's2' }]))).toBe('s2')
  expect(lastSession('[]')).toBeUndefined()
  expect(lastSession('not json')).toBeUndefined()
})

test('the pane line quotes what the shell would split', () => {
  expect(managerLine(['--model', 'a b'], 's')).toBe("factory manager --model 'a b' --resume s")
})
