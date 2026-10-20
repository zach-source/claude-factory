import { expect, test } from 'bun:test'
import { BEADS_ACTOR_REASON, denyReason, type HookGate, PUSH_REASON } from './worker-hook'

// claude-factory-sbfo: bash eval has no options, so a leading `--` word is skipped before the
// eval script is read. Without the skip, the real head of the script stays hidden.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', ['x'], GATE)

const AC1: [string, string][] = [
  ['eval -- rm -rf /', 'eval rm -rf /'],
  ['eval -- "rm -rf /"', 'eval "rm -rf /"'],
  [': rm; eval -- $_ -rf /', ': rm; eval $_ -rf /'],
  ['eval "--" rm -rf /', 'eval rm -rf /'],
  ["eval '--' rm -rf /", 'eval rm -rf /'],
  ['eval \\-- rm -rf /', 'eval rm -rf /'],
  ['command eval -- rm -rf /', 'command eval rm -rf /'],
  ['eval -- eval -- rm -rf /', 'eval eval rm -rf /'],
]

test('AC1: eval -- hides nothing', () => {
  for (const [row, plain] of AC1) {
    const want = run(plain)
    expect(want, plain).toBeDefined()
    expect(run(row), row).toBe(want)
  }
})

test('AC2: harmless eval -- rows stay allowed', () => {
  for (const row of ['eval -- echo ok', 'eval --', 'eval -- ls -- -rf']) expect(run(row), row).toBeUndefined()
})

test('AC3: parity with and without --', () => {
  for (const plain of [
    ": 'rm -rf /'; eval \"$_\"",
    "X='rm -rf /'; eval \"$X\"",
    ": 'git push origin main'; eval \"$_\"",
  ]) {
    const withDash = plain.replace('eval ', 'eval -- ')
    expect(run(withDash) === undefined, withDash).toBe(run(plain) === undefined)
  }
})

test('AC4: quoted push still denies', () => {
  expect(run('eval -- "git push origin main"')).toBe(PUSH_REASON)
  expect(run("eval -- 'git push origin HEAD:main'")).toBe(PUSH_REASON)
})

test('AC5: bd under env -i eval --', () => {
  expect(run('env -i eval -- "bd create x"')).toBe(BEADS_ACTOR_REASON)
  expect(run('env -i eval -- bd create x')).toBe(BEADS_ACTOR_REASON)
})
