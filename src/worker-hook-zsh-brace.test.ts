import { expect, test } from 'bun:test'
import {
  denyReason,
  DYNAMIC_VERB_REASON,
  type HookGate,
  PUSH_REASON,
  REASON,
  SCAN_BUDGET_REASON,
} from './worker-hook'

// claude-factory-4iod: zsh opens a brace group at a `{` word in the middle of a segment, for
// example after `repeat N`, after `]]` or after `} always`. segments() keeps the whole shape in
// one segment, so realCommand read only the first command. The guard now reads the words after
// each such `{` as a new command start. This reading only denies.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)

const DENY_REASON = [
  'repeat 1 { rm -rf /; }',
  'repeat 1 { rm -rf / }',
  'if [[ 1 ]] { rm -rf /; }',
  'while [[ 1 ]] { rm -rf /; }',
  'until [[ 1 ]] { rm -rf /; }',
  '{ true; } always { rm -rf /; }',
  '{ true } always { rm -rf / }',
  'if [[ 1 ]] { true } else { rm -rf / }',
  'if [[ 1 ]] { true } elif [[ 1 ]] { rm -rf / }',
  'for x in a { rm -rf / }',
  'repeat 1 { rm -rf ./widget; }',
  'repeat 1 { A=x rm -rf /; }',
  'repeat 1 { sudo rm -rf /; }',
  'repeat 1 { find . -exec rm -rf {} + }',
  'repeat 1 { cd /acme; }; rm widget',
  // Known fail-closed deny: bash prints text, zsh gives a parse error.
  'echo { rm -rf / }',
]
test.each(DENY_REASON)('4IOD denies REASON for %s', cmd => {
  expect(run(cmd)).toBe(REASON)
})

test('4IOD inner dynamic verb denies', () => {
  expect(run('repeat 1 { $G $V o main }')).toBe(DYNAMIC_VERB_REASON)
})
test('4IOD inner push keeps PUSH_REASON', () => {
  expect(run('repeat 1 { git push origin main }')).toBe(PUSH_REASON)
})

test('4IOD 17 brace words in one segment hit the scan budget', () => {
  expect(run('repeat 1 { '.repeat(17) + 'rm -rf /')).toBe(SCAN_BUDGET_REASON)
  expect(run('repeat 1 { '.repeat(700) + 'rm -rf /')).toBe(SCAN_BUDGET_REASON)
})

const ALLOW = [
  'echo {a,b}',
  'find . -exec ls {} +',
  '{ echo hi; }',
  'repeat 1 { echo hi; }',
  'while [[ 1 ]] { ls; break }',
  'if [[ 1 ]] { git commit -m x }',
  'echo { hi }',
  "grep -F '{' acme.txt",
]
test.each(ALLOW)('4IOD keeps the allow for %s', cmd => {
  expect(run(cmd)).toBeUndefined()
})

test('4IOD long brace shapes stay fast', () => {
  const body = 'repeat 1 { '.repeat(744).slice(0, 8192)
  for (const cmd of [body, 'eval '.repeat(16) + body]) {
    const t = performance.now()
    run(cmd)
    expect(performance.now() - t).toBeLessThan(2000)
  }
}, 30_000)
