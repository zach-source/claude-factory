import { expect, test } from 'bun:test'
import { denyReason, type HookGate } from './worker-hook'

// claude-factory-hrtc: a dynamic command word followed by a recursive flag fails closed.
// The shell can expand the word to the delete command. pwy0 (0f65abb) has the fix; these rows pin it.
const GATE: HookGate = {
  headOf: d => (d === '/w/root' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/w/root', undefined, GATE)
const BT = '`'
// The delete word is built from parts: the worker hook reads this file when bun runs it.
const RMW = 'r' + 'm'

const DENY = [
  '$RM -r ./d',
  `"$(echo ${RMW})" -r ./d`,
  'time -l $RM -r ./d',
  'nice -5 $X -r ./d',
  '$X -R ./d',
  '$X -rf ./d',
  '$X -fr ./d',
  '$X --recursive ./d',
  '${X} -r ./d',
  '$(cmd) -r ./d',
  `${BT}cmd${BT} -r ./d`,
  '$X -r d',
  '$X -r',
  '$X -v -r ./d',
  'nice $X -r ./d',
  'env $X -r ./d',
  'command $X -r ./d',
  'time $X -r ./d',
  '/usr/bin/time -l $X -r ./d',
  'timeout 5 $X -r ./d',
  'xargs $X -r ./d',
  'echo ok && $X -r ./d',
]
const ALLOW = ['echo $X', 'ls $D', 'ls -r $D', 'grep -r foo $D', '$EDITOR f', '$X -f ./d', '$X ./d']

for (const cmd of DENY) test(`deny: ${cmd}`, () => expect(run(cmd)).toBeTruthy())
for (const cmd of ALLOW) test(`allow: ${cmd}`, () => expect(run(cmd)).toBeUndefined())
