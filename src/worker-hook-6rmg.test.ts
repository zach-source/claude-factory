// claude-factory-6rmg: the hook denies factory memory compact unless every later word is --dry-run.
import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, FACTORY_CONTROL_REASON } from './worker-hook.ts'

const CONTROL = [
  'factory memory compact',
  '/abs/bin/factory memory compact',
  'bin/factory memory compact',
  'factory memory COMPACT',
  'factory MEMORY compact',
  "factory memory 'compact'",
  'factory memory',
  'factory memory --rig x compact',
  'factory memory --no-core compact',
  'factory memory compact --rig --dry-run',
  'factory memory compact --dry-run 2>&1',
  'factory memory compact --from --dry-run',
  'factory memory compact --dry-run x',
  'factory memory compact\\\n --dry-run x',
  'factory memory \\\ncompact',
  'sudo factory memory compact',
  'env A=1 factory memory compact',
  'timeout 5 factory memory compact',
  'true && factory memory compact',
  "bash -c 'factory memory compact'",
]
const DYNAMIC = ['factory memory "$X"', 'factory memory $(echo compact)', 'factory memory c*']
const ALLOW = [
  'factory memory compact --dry-run',
  'bin/factory memory compact --dry-run',
  'factory memory search compact',
  'factory memory search --rig claude-factory "memory compact"',
  'factory memory add --from r1/plan --kind fact "factory memory compact" "y"',
  'factory memory helped --from r1/plan claude-factory/x.md',
  'factory memory eval --self 5',
  'bd create "factory memory compact"',
  'rg "factory memory compact" src',
]

for (const c of CONTROL)
  test(`denies ${c}`, () => {
    expect(denyReason(c)).toBe(FACTORY_CONTROL_REASON)
  })
for (const c of DYNAMIC)
  test(`denies a dynamic sub: ${c}`, () => {
    expect(denyReason(c)).toBe(DYNAMIC_VERB_REASON)
  })
for (const c of ALLOW)
  test(`allows ${c}`, () => {
    expect(denyReason(c)).toBeUndefined()
  })
