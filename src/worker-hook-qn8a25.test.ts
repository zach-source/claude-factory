import { expect, test } from 'bun:test'
import { BEADS_ACTOR_REASON, denyReason, FACTORY_FROM_REASON, FACTORY_RUN_REASON } from './worker-hook.ts'

const GUARDS = [
  { name: 'BEADS_ACTOR', cmd: 'bd create x', reason: BEADS_ACTOR_REASON },
  { name: 'FACTORY_FROM', cmd: 'factory mail r1 implement x', reason: FACTORY_FROM_REASON },
  { name: 'FACTORY_RUN', cmd: 'factory report run-b 3 approve x', reason: FACTORY_RUN_REASON },
]
const WRITERS = [
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'unset',
  'printf',
  'print',
  'read',
  'mapfile',
  'readarray',
  'getopts',
  'vared',
  'integer',
  'float',
  'private',
  'zparseopts',
  'zstyle',
  'zstat',
  'strftime',
  'sysread',
  'getln',
]
const DENY = (n: string, c: string) => [
  `printf -v ${n} x; ${c}`,
  `printf -v${n} x; ${c}`,
  `builtin printf -v ${n} x; ${c}`,
  `print -v ${n} x; ${c}`,
  `read ${n} <<< x; ${c}`,
  `read -r ${n} < f; ${c}`,
  `read -r a ${n} < f; ${c}`,
  `declare +x ${n}; ${c}`,
  `typeset +x ${n}; ${c}`,
  `export +x ${n}; ${c}`,
  `export -n OTHER ${n}; ${c}`,
  `export -- ${n}; ${c}`,
  `declare -n r=${n}; ${c}`,
  `${n}+=x ${c}`,
  `for ${n} in Manager; do ${c}; done`,
  `select ${n} in Manager; do ${c}; done`,
  `foreach ${n} (Manager) ${c}; end`,
  `for ${n} (Manager) ${c}`,
  ...WRITERS.map(w => `${w} ${n}; ${c}`),
]
const ALLOW = (n: string, c: string) => [
  `printf %s "$${n}"`,
  `printf -v OTHER x; ${c}`,
  `read -r line < f; ${c}`,
  `export X=$${n}`,
  `export X=\${${n}}`,
  `echo ${n}_LOG=1; ${c}`,
  `grep -rn ${n} src`,
  `git commit -m "fix ${n} guard"`,
  'find . -print',
  `for f in a b; do grep -n ${n} "$f"; done`,
  `git commit -m "fix for ${n}"`,
  `for f in a ${n}; do echo; done`,
]

for (const g of GUARDS) {
  test(`${g.name}: variable writers deny`, () => {
    for (const cmd of DENY(g.name, g.cmd)) expect([cmd, denyReason(cmd)]).toEqual([cmd, g.reason])
  })
  test(`${g.name}: reads and unrelated text allow`, () => {
    for (const cmd of ALLOW(g.name, g.cmd)) expect([cmd, denyReason(cmd)]).toEqual([cmd, undefined])
  })
}
