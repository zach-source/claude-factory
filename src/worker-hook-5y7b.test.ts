// claude-factory-5y7b: the hook denies a factory word followed by say, stop, resume, start or fork.
import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, FACTORY_CONTROL_REASON } from './worker-hook.ts'

const CONTROL = [
  'factory say hi',
  '/abs/bin/factory say hi',
  'bin/factory stop',
  'factory resume',
  'factory start lifecycle acme/widget g',
  'factory start lifecycle@plan widget g',
  'factory fork r1 plan',
  'factory fork r1 plan note',
  'sudo factory stop',
  'env factory say x',
  'timeout 5 factory say x',
  'true && factory stop',
  'x; factory resume',
  "bash -c 'factory say x'",
  'FACTORY say x',
  '\\factory say x',
  "factory 'say' x",
  'factory SAY x',
]
const DYNAMIC = ['factory "$V" x', 'factory $(echo say) x', 'factory st* x']
const ALLOW = [
  'factory report r1 2 ready "s"',
  'factory mail r1 manager "please factory stop"',
  'factory memory search "start"',
  'factory memory add --from r1/plan --kind fact "factory start x" "y"',
  'factory status',
  'factory check f.ts',
  'bd create "factory say"',
  'rg "factory start" docs',
  'ls bin/factory',
]

for (const c of CONTROL)
  test(`denies ${c}`, () => {
    expect(denyReason(c)).toBe(FACTORY_CONTROL_REASON)
  })
for (const c of DYNAMIC)
  test(`denies a dynamic verb: ${c}`, () => {
    expect(denyReason(c)).toBe(DYNAMIC_VERB_REASON)
  })
for (const c of ALLOW)
  test(`allows ${c}`, () => {
    expect(denyReason(c)).toBeUndefined()
  })
