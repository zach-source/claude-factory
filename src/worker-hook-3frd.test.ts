import { expect, test } from 'bun:test'
import {
  denyReason,
  DYNAMIC_VERB_REASON,
  type HookGate,
  PUSH_REASON,
  SH_DYNAMIC_SCRIPT_REASON,
} from './worker-hook'

// claude-factory-3frd: a sh, bash, zsh or dash -c call with a dollar or backtick in a word after
// -c fails closed. The shell expands it at run time, so the guard cannot read the script.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)
const BT = '`'

// AC1: a dollar script word.
// The delete word is built from parts: the worker hook reads this file when bun runs it.
const SET = `y='${'r' + 'm'} ../acme.txt'; `
const AC1 = [
  'bash -c "$y"',
  'sh -c "$y"',
  'zsh -c "$y"',
  'dash -c "$y"',
  'bash -lc "$y"',
  'bash -ec "$y"',
  'bash -x -c "$y"',
  'bash -c -- "$y"',
  '/bin/bash -c "$y"',
  'env bash -c "$y"',
  'command bash -c "$y"',
  'sudo bash -c "$y"',
  'timeout 5 bash -c "$y"',
  'nohup bash -c "$y"',
].map(c => SET + c)
test.each(AC1)('3FRD AC1 denies %s', cmd => {
  expect(run(cmd)).toBeDefined()
})

// AC2: a dollar in a literal script, or in an argv word after it.
const AC2 = [
  "bash -c '$0 ../acme.txt' rm",
  "bash -c '\"$0\" ../acme.txt' rm",
  "bash -c '$1 ../acme.txt' _ rm",
  "bash -c '\"$@\"' _ rm ../acme.txt",
  "bash -c 'echo $1' _ hi",
  'bash -c \'echo hi\' "$y"',
]
test.each(AC2)('3FRD AC2 denies %s', cmd => {
  expect(run(cmd)).toBeDefined()
})

// AC3: a dollar word after a flag value that follows -c.
test.each(["bash -c -o pipefail '$0 ../acme.txt' rm", "bash -c -o pipefail 'echo $1' _ hi"])(
  '3FRD AC3 denies %s',
  cmd => {
    expect(run(cmd)).toBeDefined()
  },
)

// AC4: a backtick in the script word.
test('3FRD AC4 denies a backtick script', () => {
  expect(run(`bash -c 'echo ${BT}date${BT}'`)).toBeDefined()
})

// AC5: the exact reason when no other rule denies.
test('3FRD AC5 gives SH_DYNAMIC_SCRIPT_REASON', () => {
  expect(run("bash -c 'echo $1' _ hi")).toBe(SH_DYNAMIC_SCRIPT_REASON)
})

// AC6: literal rows stay allowed.
const AC6 = [
  "bash -c 'echo hi'",
  "sh -c 'ls -la'",
  "bash -lc 'bun test'",
  "bash -o pipefail -c 'git status'",
  'sh acme.sh "$a" "$b"',
  "bash -c 'echo hi' > .scratch/out.txt",
  'sh script.sh $X',
  'sh -- $X',
]
test.each(AC6)('3FRD AC6 allows %s', cmd => {
  expect(run(cmd)).toBeUndefined()
})

// AC7: specific reasons win.
test('3FRD AC7 keeps specific reasons', () => {
  expect(run('bash -c "$(cat acme.sh)"')).toBe(DYNAMIC_VERB_REASON)
  expect(run("bash -c 'git push origin main $x'")).toBe(PUSH_REASON)
})

// AC8: the 38jm AC5 rows that held a dollar next to -c now deny.
test.each(["bash -c 'echo $" + "HOME'","sh -c 'git status' $X", 'sh -c "$CMD"'])(
  '3FRD AC8 denies %s',
  cmd => {
    expect(run(cmd)).toBe(SH_DYNAMIC_SCRIPT_REASON)
  },
)
