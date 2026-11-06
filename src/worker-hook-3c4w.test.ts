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
  'factory linear acme',
  'factory queue acme b1',
  'factory poke r1 hi',
  'factory retry r1',
  'factory abort r1',
  'factory rm r1',
  'factory rig add w acme/widget',
  'factory rig rm w',
  'factory rig --max 2 add w x',
  'factory rig ADD w x',
  'factory 2>&1 tick',
  'factory >f tick',
  'factory > f tick',
  'factory 2>&1 TICK',
  'factory 2>/dev/null say hi',
  'factory </dev/null goto r1 x',
  'factory 2>&1 rm r1',
  'factory 2>&1 rig add w x',
  'factory > f rig add w x',
  'factory 2>&1 rig 2>&1 add w x',
  'sudo factory 2>&1 tick',
  'factory\\\n 2>&1 tick',
  'factory memory 2>&1 compact',
  'factory 2>&1 memory compact',
  'FACTORY TICK',
  '\\factory tick',
  "factory 'goto' r1 x",
  'sudo factory tick',
  'env factory abort r1',
  'timeout 5 factory rm r1',
  'true && factory goto r1 done',
  "bash -c 'factory tick'",
  "factory memory compact '<' --rig --dry-run",
  'factory memory compact \\\\< --rig --dry-run',
  'factory memory compact "<" --rig --dry-run',
  "factory memory compact --dry-run '>' x",
  "factory memory compact '2>' x --dry-run",
  'factory memory compact --dry-run "2>&1"',
  "factory rig '>' x",
  "factory rig '>' add",
  'factory rig \\\\> rm',
  "factory rig '>' list",
  'factory memory compact --dry-run >f',
  'factory memory compact --dry-run 2>&1',
]
const DYNAMIC = ['factory 2>&1 ~/tick', 'factory 2>&1 $V', 'factory rig "$X"', 'factory $(echo goto) r1']
const ALLOW = [
  'factory 2>&1',
  'factory 2>&1 rig',
  'factory 2>&1 rig list',
  'factory > f rig list',
  'factory 2>&1 status',
  'factory 2>&1 report r1 2 ready x',
  'factory 2>&1 memory search x',
  'factory memory search x >f',
  'factory memory compact --dry-run',
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
