// claude-factory-3c4w: the hook denies a factory word followed by a manager-only verb, or rig with a sub other than list.
import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, FACTORY_CONTROL_REASON } from './worker-hook.ts'

const CONTROL = [
  'factory goto r1 done',
  '/abs/bin/factory tick',
  'bin/factory attach --follow',
  'factory manager host',
  'factory migrate-to-ax',
  'factory loop --interval 1000',
  'factory self-update',
  'factory gc --dry-run',
  'factory sweep',
  'factory beads',
  'factory watch',
  'factory sync',
  'factory dream',
  'factory devenv',
  'factory retry r1',
  'factory abort r1',
  'factory rm r1',
  'factory rig add w acme/widget',
  'factory rig rm w',
  'factory rig --max 2 add w x',
  'factory rig ADD w x',
  'FACTORY TICK',
  '\\factory tick',
  "factory 'goto' r1 x",
  'sudo factory tick',
  'env factory abort r1',
  'timeout 5 factory rm r1',
  'true && factory goto r1 done',
  "bash -c 'factory tick'",
]
const DYNAMIC = ['factory rig "$X"', 'factory $(echo goto) r1']
const ALLOW = [
  'factory rig',
  'factory rig list',
  'factory status',
  'factory report r1 2 ready "goto done"',
  'factory mail r1 manager "please factory tick"',
  'factory memory search "abort"',
  'bd create "factory rm"',
  'rg "factory manager" src',
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
