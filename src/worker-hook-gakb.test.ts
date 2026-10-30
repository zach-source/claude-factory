import { expect, test } from 'bun:test'
import { denyReason, FACTORY_FROM_REASON, FACTORY_RUN_REASON } from './worker-hook.ts'

const M = 'factory mail r1 implement x'
const DENY = [
  `env -u FACTORY_RUN ${M}`,
  `env --unset=FACTORY_RUN ${M}`,
  `env --unset FACTORY_RUN ${M}`,
  `env --uns FACTORY_RUN ${M}`,
  `env -uFACTORY_RUN ${M}`,
  `env -0u FACTORY_RUN ${M}`,
  `unset FACTORY_RUN; ${M}`,
  'unset -v FACTORY_RUN',
  'export -n FACTORY_RUN',
  'export FACTORY_RUN=manager',
  'declare -x FACTORY_RUN=manager',
  'typeset FACTORY_RUN',
  'readonly FACTORY_RUN',
  `FACTORY_RUN=manager ${M}`,
  `FACTORY_RUN= ${M}`,
  `env FACTORY_RUN=manager ${M}`,
  `env -i ${M}`,
  'env -i PATH=/usr/bin /abs/bin/factory mail r1 implement x',
  `env - ${M}`,
  `env --ignore-environment ${M}`,
  `env -i sh -c "${M}"`,
  `env -i nice sh -c "${M}"`,
  `env -i eval "${M}"`,
  `sh -c "unset FACTORY_RUN; ${M}"`,
  `eval "env -u FACTORY_RUN ${M}"`,
  `env -S"-u FACTORY_RUN" ${M}`,
  `env -u \\\nFACTORY_RUN ${M}`,
  `env --unset=\\\nFACTORY_RUN ${M}`,
  `env --unset \\\nFACTORY_RUN ${M}`,
]
const ALLOW = [
  'factory report r1 2 ready x',
  'factory mail r1 manager "a question"',
  'bin/factory report r1 2 ready x',
  'env -i ls',
  'env -i PATH=/usr/bin ls',
  `env -u OTHER_VAR ${M}`,
  'echo FACTORY_RUN_LOG=1',
  'grep -rn FACTORY_RUN src',
  'env LC_ALL=C grep -rn FACTORY_RUN src',
  'env FOO=1 factory mail r1 implement "FACTORY_RUN note"',
  'git commit -m "fix FACTORY_RUN guard"',
]

test.each(DENY)('denyReason denies %j (claude-factory-gakb)', cmd => {
  // env -i clears both variables: the FACTORY_FROM guard answers first
  const clearsAll = /env (-i|-\s|--ignore-environment)/.test(cmd)
  expect(denyReason(cmd)).toBe(clearsAll ? FACTORY_FROM_REASON : FACTORY_RUN_REASON)
})
test.each(ALLOW)('denyReason allows %j (claude-factory-gakb)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})
