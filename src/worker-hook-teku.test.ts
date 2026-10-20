import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, type HookGate } from './worker-hook'

// claude-factory-teku: `$_` is the last argument of the previous command, so a head `$_` can run
// any command. No NAME=value in the text sets it, so the guard denies it.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)

const AC1 = [
  ': rm; $_ -rf /',
  ': rm; ${_} -rf /',
  ': rm; "$_" -rf /',
  ': rm; ${_:-x} -rf /',
  ": 'rm -rf /'; $_",
  ': git; $_ push origin main',
]
const ZSH = ['${(@)_}', '${=_}', '${^_}', '${~_}', '${^^_}', '${(P)_}', '$=_', '$~_', '$^_', '$^^=_'].map(
  h => `: rm; ${h} -rf /`,
)
AC1.push(...ZSH)
const AC2 = [': rm; sudo $_ -rf /', ': rm; env $_ -rf /', ': rm; command $_ -rf /']
const AC3 = [': \'rm -rf /\'; eval "$_"', ': \'rm -rf /\'; bash -c "$_"']
const AC4 = [
  'echo $_',
  'echo x; echo $_',
  'mkdir -p d && cd "$_"',
  'ls $_',
  'cp a "$_x"',
  'printf \'%s\' "${_x}"',
]

test('a head $_ is denied', () => {
  for (const c of AC1) expect(run(c), c).toBe(DYNAMIC_VERB_REASON)
})
test('a wrapped $_ is denied', () => {
  for (const c of AC2) expect(run(c), c).toBe(DYNAMIC_VERB_REASON)
})
test('$_ as an eval or sh -c script is denied', () => {
  for (const c of AC3) expect(run(c), c).toBeDefined()
})
test('$_ as an operand stays allowed', () => {
  for (const c of AC4) expect(run(c), c).toBeUndefined()
})
