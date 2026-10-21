import { expect, test } from 'bun:test'
import { denyReason, type HookGate } from './worker-hook'

// claude-factory-ibas: a quoted script word after a dynamic head ($X "rm -rf /") can run as
// eval or sh -c. The guard reads the words after the head as a script. This reading only denies.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', ['acme'], GATE)

const ROWS = [
  '$X "rm -rf /"',
  "$X 'rm -rf /'",
  '${X} "rm -rf /"',
  '"$X" "rm -rf /"',
  '$X -- "rm -rf /"',
  "$X 'rm -rf' /",
  '$X "echo a;rm -rf /"',
  "$X 'cd /; rm -r x'",
]
const PREFIXES = [
  '%',
  'nice %',
  '( % )',
  'echo ok && %',
  'Y=1 %',
  'command %',
  'sudo %',
  'repeat 1 %',
  'find . -exec % ;',
]
for (const row of ROWS)
  for (const p of PREFIXES) {
    const cmd = p.replace('%', () => row)
    test(`deny ${cmd}`, () => expect(run(cmd)).toBeDefined())
  }
for (const cmd of [
  "$X 'git push origin main'",
  '$X "git push -f origin main"',
  "env -i $X 'bd create acme -l factory'",
  'X=eval; $X "rm -rf /"',
  '$X x "rm -rf /"',
  "$X 'git push -f origin' main",
  "$X 'git push' origin main",
  "env -i $X x 'bd create acme'",
])
  test(`deny ${cmd}`, () => expect(run(cmd)).toBeDefined())
for (const cmd of [
  '"$PY" -c "print(1)"',
  '$X "hello world"',
  '$EDITOR notes.md',
  '$GIT status',
  '$X "a b" c',
  '$GREP -n "foo bar" file',
])
  test(`allow ${cmd}`, () => expect(run(cmd)).toBeUndefined())

for (const cmd of [Array(200).fill('$X').join(' ') + ' "x y"', '$X ' + Array(200).fill('"x y"').join(' ')])
  test('cost stays linear', () => {
    const t = Date.now()
    run(cmd)
    expect(Date.now() - t).toBeLessThan(1000)
  })
