import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, type HookGate } from './worker-hook'

// claude-factory-ycaq: a dynamic command word that ends in a dashed git verb ($G-push) runs the
// git-push binary. The guard must deny it.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)

const AC1 = [
  '$G-push origin main',
  '${G}-push origin main',
  '"$G"-push origin main',
  '"$G-push" origin main',
  '$G-send-pack x',
  '$G-PUSH origin main',
  '$G-pu""sh origin main',
  "$G-'push' origin main",
  '$G-pu\\sh origin main',
  '$G-pu\\\nsh origin main',
  '${G}push origin main',
  '"$G"push origin main',
  'sudo $G-push origin main',
  'env $G-push origin main',
  '$G-checkout main',
  '$G-config x y',
]
const AC2 = [
  '=git-push origin main',
  '=git-send-pack x',
  'git-push origin main',
  '~/bin/git-push origin main',
  '$X/git-push origin main',
]
const AC3 = [
  '$G-tool x',
  '$G-status',
  '$G-log',
  '$G-fetch origin',
  '$G-pushx origin main',
  '$G-push-foo x',
  '$HOME/bin/run-tests x',
  'echo $G-push',
  'cp $G-push x',
  '$PY -c x',
  '=git-status',
]

test('a dynamic word ending in a dashed git verb is denied', () => {
  for (const c of AC1) expect(run(c), c).toBe(DYNAMIC_VERB_REASON)
})
test('literal dashed git binaries stay denied', () => {
  for (const c of AC2) expect(run(c), c).toBeDefined()
})
test('other dynamic words stay allowed', () => {
  for (const c of AC3) expect(run(c), c).toBeUndefined()
})
