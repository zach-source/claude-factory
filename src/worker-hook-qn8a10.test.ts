import { expect, test } from 'bun:test'
import { denyReason, type HookGate, REASON } from './worker-hook'

// claude-factory-qn8a.10: segments() ends a word at unquoted whitespace, ; | and newline. bash reads
// a dollar-brace word on to its matching close brace, then splits the result. So a wrapper value
// slot such as `sudo -u ${X:-root rm} -rf /` hides rm. In the rows, DB is a dollar and an open
// brace, and RB is a close brace. This reading only denies.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) =>
  denyReason(cmd.replaceAll('DB', '${').replaceAll(' RB', '}'), '/root/repo', ['acme'], GATE)

const denyRows = [
  'sudo -u DBX:-root rm RB -rf /',
  'sudo -u DBX-root rm RB -rf /',
  'sudo -u DBX:+root rm RB -rf /',
  'env -C DBX:-/ rm RB -rf /',
  'nice -n DBX:-5 rm RB -rf /',
  'sudo -u DBX=root rm RB -rf /',
  'sudo -u DBX:?root rm RB -rf /',
  'sudo -u DBX?root rm RB -rf /',
  'sudo -u DBX+root rm RB -rf /',
  'sudo -u DBX/#/root rm RB -rf /',
  'sudo -u DBX:-root\trm RB -rf /',
  'sudo -u DBX:-root\nrm RB -rf /',
  'sudo -u DBX:-root \\\nrm RB -rf /',
  'sudo -u DBX:-root;rm RB -rf /',
  'sudo -u DBX:-root|rm RB -rf /',
  'sudo -u DBX:-"root" rm RB -rf /',
  'sudo -u DBX:-DBY:-root rm RB RB -rf /',
  'sudo -u DBX:-DBY rm RB RB -rf /',
  'sudo -u }DBX:-root rm RB -rf /',
  'sudo -u }DBX:-root rm RB',
  'env -C }DBX:-/ rm RB -rf /',
  'nice -n }DBX:-5 rm RB -rf /',
  'sudo -u }}DBX:-root rm RB -rf /',
  'sudo -u aDBX:-b rm RB -rf /',
  'sudo -g DBX:-root rm RB -rf /',
  'env -u DBX:-root rm RB -rf /',
  'timeout -s DBX:-9 rm RB -rf /',
  'timeout -k DBX:-9 rm RB -rf /',
  'echo ok && sudo -u DBX:-root rm RB -rf /',
  'sudo -u DBX:-root rm RB -rf / # c',
  "sudo -u DBX:-rootDBY+'}'} rm RB -rf /",
  'sudo -u DBX:-rootDBY+\\}} rm RB -rf /',
  'env -C DBX:-/DBY+"}"} rm RB -rf /',
  'nice -n DBX:-5DBY+\\}} rm RB -rf /',
  'sudo -g DBX:-rootDBY+\\}} rm RB -rf /',
  'timeout -s DBX:-9DBY+\\}} rm RB -rf /',
  'env -u DBX:-ADBY+\\}} rm RB -rf /',
  'sudo -u $\\\n{X:-root rm RB -rf /',
  'sudo -g $\\\n{X:-root rm RB -rf /',
  'env -C $\\\n{X:-root rm RB -rf /',
  'env -u $\\\n{X:-root rm RB -rf /',
  'nice -n $\\\n{X:-root rm RB -rf /',
  'timeout -s $\\\n{X:-root rm RB -rf /',
  'sudo -u "DBX:-root rm RB" -rf /',
  "sudo -u DBX:-'root rm' RB -rf /",
  'sudo -u DBX:-root\\ rm RB -rf /',
  "echo \\\\\n'true'; sudo -u DBX:-root rm RB -rf zq",
  'echo "a\\\\\n"; sudo -u DBX:-root rm RB -rf zq',
  'echo "a\\\\\n"; env -C DBX:-. rm RB -rf zq',
  'echo "a\\\\\n"; nice -n DBX:-5 rm RB -rf zq',
  'exec -a DBY-\\\\\nrm RB -rf zq',
  'env -u DBY-\\\\\nrm RB -rf zq',
  'sudo -g DBY-\\\\\nrm RB -rf zq',
  'timeout -s DBY-\\\\\nrm RB -rf zq',
  'echo "`echo \'"\'`"; sudo -u DBX:-root rm RB -rf zq',
  'echo "`echo \'"\'`"; env -C DBX:-. rm RB -rf zq',
  `sudo -u DBX:-root"DBY%'"'}" rm RB -rf zq '}'`,
  `env -C DBX:-."DBY%'"'}" rm RB -rf zq '}'`,
  'sudo -u DBX:-root ls',
  'sudo -u DBX:-root rm RB',
  'sudo -u DBX:-root git RB push origin main',
]

test.each(denyRows)('denies %j', row => {
  expect(run(row)).toBeDefined()
})

test.each([
  'sudo -u root ls',
  'sudo A=1 ls',
  'env A=1 ls',
  'sudo -u DBUSER RB ls',
  'sudo -u $\\\n{USER} ls',
  'sudo -u }DBUSER RB ls',
  'sudo -u DBX:-root RB ls',
  'nice -n DBX:-5 RB ls',
  'echo DBX:-a b RB',
  'ls DBX:-a b RB',
  'sudo ls DBX:-a b RB',
])('allows %j', row => {
  expect(run(row)).toBeUndefined()
})

test('rows that denied before keep their reason', () => {
  expect(run('sudo -u DBX:-root RB rm -rf /')).toBe(REASON)
})
