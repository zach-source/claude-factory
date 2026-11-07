import { expect, test } from 'bun:test'
import { denyReason, PUSH_REASON, SHELL_ALIAS_REASON, type HookGate } from './worker-hook'

// claude-factory-qn8a.30: the Bash tool adds a newline to the text, so a last backslash is a line
// continuation in the shell. The guard must read the same text.
const BS = '\\'
const gate: HookGate = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
  shellAliases: () => new Map<string, string | null>([['gp', 'git push']]),
}
const verdict = (cmd: string) => denyReason(cmd, '/w', undefined, gate)

test('AC1: a last backslash does not hide a push', () => {
  for (const row of [
    'kubectl x; git push origin main' + BS,
    'git push origin main' + BS,
    'echo $(git push origin main' + BS,
  ])
    expect(verdict(row)).toBe(PUSH_REASON)
})

test('AC2: a last backslash does not hide an alias', () => {
  for (const row of ['kubectl x; gp' + BS, 'gp' + BS]) expect(verdict(row)).toBe(SHELL_ALIAS_REASON)
})

test('AC3: rows that stay allowed', () => {
  for (const row of [
    'echo a' + BS,
    'kubectl x; gp' + BS + BS,
    'echo x # c' + BS,
    'git push origin factory/x' + BS,
  ])
    expect(verdict(row)).toBeUndefined()
})

test('AC6: a last backslash in an eval, -c or trap script does not hide the last word', () => {
  for (const row of [
    `eval 'git push origin main${BS}'`,
    `zsh -c 'git push origin main${BS}'`,
    `bash -c 'git push origin main${BS}'`,
  ])
    expect(verdict(row)).toBe(PUSH_REASON)
  expect(verdict(`trap 'git push origin main${BS}' EXIT`)).toBeDefined()
  for (const row of [`eval 'gp${BS}'`, `zsh -c 'gp${BS}'`])
    expect(verdict(row)).toBe(SHELL_ALIAS_REASON)
  expect(verdict(`eval 'echo a${BS}'`)).toBeUndefined()
})

test('AC4:backslash-newline control denies', () => {
  expect(verdict('git push origin main' + BS + '\n')).toBe(PUSH_REASON)
})
