import { expect, test } from 'bun:test'
import { denyReason, FACTORY_VM_ENV_REASON } from './worker-hook.ts'

const GIT = `'{"GIT_CONFIG_COUNT":"1","GIT_CONFIG_KEY_0":"push.default","GIT_CONFIG_VALUE_0":"matching"}'`
const MUT = 'factory mutate a.ts:1 x y -- git push origin feat'
const R = 'factory report r1 2 ready x'
const DENY = [
  `export FACTORY_VM_ENV=${GIT}; ${MUT}`,
  `FACTORY_VM_ENV=${GIT} ${MUT}`,
  `env FACTORY_VM_ENV=${GIT} ${MUT}`,
  `FACTORY_VM_ENV='{"FACTORY_RUN":"lifecycle-other"}' factory report lifecycle-other 1 approve x`,
  `export FACTORY_VM_ENV='{"HOME":"/x"}'; ${R}`,
  `FACTORY_VM_ENV='{"BEADS_ACTOR":"x"}' ${R}`,
  'declare -x FACTORY_VM_ENV=x',
  'typeset FACTORY_VM_ENV',
  'readonly FACTORY_VM_ENV',
  'export -n FACTORY_VM_ENV',
  `unset FACTORY_VM_ENV; ${R}`,
  `env -u FACTORY_VM_ENV ${R}`,
  `env --unset=FACTORY_VM_ENV ${R}`,
  `FACTORY_VM_ENV= ${R}`,
  `sh -c "export FACTORY_VM_ENV=x; ${R}"`,
  `eval "FACTORY_VM_ENV=x ${R}"`,
  'FACTORY_VM_ENV=x git push origin feat',
]
const ALLOW = [
  'grep -rn FACTORY_VM_ENV src',
  'echo $FACTORY_VM_ENV',
  'git commit -m "fix FACTORY_VM_ENV guard"',
  'bun test src/vm-env.test.ts',
  R,
  `env -u OTHER_VAR ${R}`,
]
test('FACTORY_VM_ENV writers deny', () => {
  for (const c of DENY) expect([c, denyReason(c)]).toEqual([c, FACTORY_VM_ENV_REASON])
})
test('FACTORY_VM_ENV reads and unrelated text allow', () => {
  for (const c of ALLOW) expect([c, denyReason(c)]).toEqual([c, undefined])
})
