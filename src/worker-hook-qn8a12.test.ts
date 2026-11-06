import { expect, test } from 'bun:test'
import { denyReason, type HookGate } from './worker-hook'

// claude-factory-qn8a.12: xargs in a find exec slot fills the start path of a nested find with stdin text.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', ['acme'], GATE)

const denyRows = [
  'find . -exec xargs -I% find % -delete \\;',
  'find . -exec xargs -J% find % -delete \\;',
  'find . -exec xargs --replace=% find % -delete \\;',
  'find . -exec xargs -I% find -L % -delete \\;',
  'find . -exec xargs -I% sudo find % -delete \\;',
  'echo / | find . -exec xargs -I% find % -delete \\;',
  'find . -execdir xargs -I% find % -delete \\;',
  'find . -ok xargs -I% find % -delete \\;',
  'find . -exec sudo xargs -I% find % -delete \\;',
  'find . -exec xargs find -delete \\;',
  'find . -exec xargs -I% find % -delete +',
  'find . -exec >f xargs -I% find % -delete \\;',
  'find . -exec xargs -I% find % -de* \\;',
]
const allowRows = [
  'find . -exec xargs -I% ls % \\;',
  'find . -exec xargs -I% find % -print \\;',
  'find . -exec find . -delete \\;',
  'find . -delete',
  'find . -name x -exec xargs -I% echo % \\;',
  'find . -exec find % -delete \\;',
]

test.each(denyRows)('denies %s', c => {
  expect(run(c)).toBeTruthy()
})
test.each(allowRows)('allows %s', c => {
  expect(run(c)).toBeUndefined()
})
test('many exec words stay fast', () => {
  const t = performance.now()
  run('find . ' + '-exec xargs '.repeat(20000) + '-delete')
  expect(performance.now() - t).toBeLessThan(50)
})
