import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, PUSH_REASON, type HookGate } from './worker-hook'

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
  '$G-push$E origin main',
  '$G-push${E} origin main',
  '"$G-push$E" origin main',
  '${G}push$E origin main',
  '"$G"push$E origin main',
  '${G}push${E} origin main',
  '${G}push$E$F origin main',
  '${G}push${E}${F} origin main',
  '${G}push${E}$F origin main',
  '${G}push"$E""$F" origin main',
  '${G}push$@ origin main',
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
  '"$ifs"push origin main',
  '"$ifs"push$E origin main',
  '$ifs"push" origin main',
  '"$IFS"push origin main',
  '"$ifs"send-pack x',
  '"$ifs"config x y',
  'x$ifs"push" origin main',
  '$G-p${E}ush origin main',
  '$G"push"$E origin main',
  '${G}push$1 origin main',
  'git"$ifs"push origin main',
  'git"$IFS"push origin main',
  'git"$ifs"send-pack x',
  'git"$ifs"config x y',
  '/x/git"$ifs"push origin main',
  '2>&1 $G-push origin main',
  '>>f $G-push origin main',
  '<<<x $G-push origin main',
  '{fd}>f $G-push origin main',
  'nice -n 5 $G-push origin main',
  'timeout -s KILL 5 $G-push origin main',
  'sudo -u x -- $G-push origin main',
  'env -u X $G-push origin main',
  'command -p $G-push origin main',
  'exec -a x $G-push origin main',
  'nohup >f $G-push origin main',
  'env >f $G-push origin main',
  'time -p $G-push origin main',
  'sudo -g x $G-push origin main',
  '$G-push origin main | cat',
  '>f $G-checkout main',
  '>f $G-send-pack x',
  '{ >f $G-push origin main; }',
  '( >f $G-push origin main )',
  'echo x | >f $G-push origin main',
  'x=$(>f $G-push origin main)',
  'eval ">f $G-push origin main"',
  'bash -c ">f $G-push origin main"',
  'xargs >f $G-push origin main',
  '>f git"$ifs"push origin main',
]
const AC2 = [
  '=git-push origin main',
  '=git-send-pack x',
  'git-push origin main',
  '~/bin/git-push origin main',
  '$X/git-push origin main',
  'env -S "$G-push origin main"',
  'x() { $G-push origin main; }',
  'A=1 >f $G-push origin main',
  '>f =git-push origin main',
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
  '$G-push.sh x',
  '>f $G-tool x',
]

test('a dynamic word ending in a dashed git verb is denied', () => {
  for (const c of AC1) expect(run(c), c).toBe(DYNAMIC_VERB_REASON)
})
test('literal dashed git binaries stay denied', () => {
  for (const c of AC2) expect(run(c), c).toBeDefined()
})
test('glued IFS pushes keep the push reason', () => {
  for (const c of ['git$IFS"push"$IFS"origin"$IFS"main"', 'git${IFS}push${IFS}origin${IFS}main'])
    expect(run(c), c).toBe(PUSH_REASON)
})
test('other dynamic words stay allowed', () => {
  for (const c of AC3) expect(run(c), c).toBeUndefined()
})
