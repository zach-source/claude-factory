import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, type HookGate, PUSH_REASON, REASON } from './worker-hook'

// claude-factory-xbr1: skipSudoFlags reads a word such as $=X or ${=X} as a NAME=value word and
// skips it. zsh splits the value of X, so sudo runs it. The guard now denies when a word that
// the wrapper skipped expands a set name. This reading only denies.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', ['acme'], GATE)

const FORMS = ['$=X', '${=X}', '$~=X', '$=~X', '$^=X', '${=X[1,-1]}']
const PREFIXES = [
  'sudo',
  'sudo -u root',
  'sudo -E',
  'sudo Y=1',
  'Y=1 sudo',
  'env sudo',
  'exec sudo',
  'command sudo',
  'nohup sudo',
  'timeout 5 sudo',
  'xargs sudo',
  'sudo sudo',
  'echo ok && sudo',
]
const VALUES = ['git push origin main', 'rm -rf /']

const denyRows: string[] = []
for (const x of VALUES)
  for (const p of PREFIXES)
    for (const f of FORMS) {
      denyRows.push(`X="${x}"; ${p} ${f}`)
    }
for (const x of VALUES)
  for (const f of FORMS) {
    denyRows.push(`X="${x}"; sudo ${f} # c`)
    denyRows.push(`X="${x}"; sudo \\\n${f}`)
  }
denyRows.push(
  'X="root git push origin main"; sudo -u $=X',
  'X="root git push origin main"; sudo -u ${=X}',
  'X="root git push origin main"; sudo -u $X',
  'X="5 git push origin main"; nice -n ${=X}',
  'X="git push origin main"; sudo $X=1',
  'X="git push origin main"; sudo ${X}=1',
  'X="a=1 git push origin main"; sudo ${=X}',
  'X="-- git push origin main"; sudo ${=X}',
  'sudo ${=REPLY}',
  'sudo ${=MATCH}',
  'sudo ${!Y}',
  'read X; sudo ${=X}',
  'X=a; A=$X sudo ls',
)

test.each(denyRows)('denies %s', row => {
  expect(run(row)).toBeDefined()
})

test('rows that denied before keep their reason', () => {
  expect(run('X="git push origin main"; sudo $X')).toBe(PUSH_REASON)
  expect(run('X="rm -rf /"; sudo $X')).toBe(REASON)
  expect(run('sudo $=X git push origin main')).toBe(PUSH_REASON)
})

test('a plain dynamic word uses the dynamic reason', () => {
  expect(run('X="git push origin main"; sudo ${=X}')).toBe(DYNAMIC_VERB_REASON)
})

test.each(['sudo ls', 'sudo A=1 git status', 'sudo A=1 B=2 ls', 'sudo -u root A=b ls -la', 'X=ls; sudo $X'])(
  'allows %s',
  row => {
    expect(run(row)).toBeUndefined()
  },
)
