import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, type HookGate } from './worker-hook'

// claude-factory-qn8a.11: a glob in a skipped wrapper word (a value slot such as sudo -u) can expand
// to several words, so a file named rm becomes the command. The guard denies such a word.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', ['acme'], GATE)

const SLOTS = [
  'sudo -u',
  'sudo -g',
  'sudo -C',
  'env -u',
  'env -C',
  'nice -n',
  'timeout -s',
  'exec -a',
  'xargs -I',
  'xargs -n',
]
const GLOBS = ['r*', '?o*', '[nr]*', '.[nr]*', 'r??']

const denyRows: string[] = [
  'sudo -u [nr]* -rf /',
  'sudo -u ?o* -rf /',
  'sudo -u r* -rf /',
  'sudo -u .[nr]* -rf /',
  'sudo -u ${X:-*} -rf zq',
  'env -C ${X:-*} -rf zq',
  'nice -n ${X:-*} -rf zq',
  'sudo -u ${X:-.r*} -rf zq',
  'env -C ${X:-[ar]*} -rf zq',
  'echo ok; sudo -u .[nr]* -rf zq',
  'sudo -u .[nr]* -rf zq && echo ok',
  'timeout -s .[nr]* 5 -rf zq',
]
for (const s of SLOTS) for (const g of GLOBS) denyRows.push(`${s} ${g} -rf zq`)

const allowRows = [
  'sudo -u root ls',
  'sudo -u root-x ls',
  'sudo -u root ls *.txt',
  'timeout 30 bun test src/*.ts',
  'nice -n 10 ls src/*.ts',
  'env -C src ls *.ts',
  'env -u FOO ls *.ts',
  'xargs -I{} echo {}',
  "find . -name '*.ts' -exec grep -l x {} +",
  'sudo -u root A=b ls -la',
  'noglob ls *',
  'A=*.txt sudo ls',
]

test('a glob in a skipped wrapper word denies', () => {
  for (const c of denyRows) expect([c, run(c) !== undefined]).toEqual([c, true])
  expect(run('sudo -u .[nr]* -rf /')).toBe(DYNAMIC_VERB_REASON)
})

test('wrapper rows without a glob in a skipped word stay allowed', () => {
  for (const c of allowRows) expect([c, run(c)]).toEqual([c, undefined])
})
