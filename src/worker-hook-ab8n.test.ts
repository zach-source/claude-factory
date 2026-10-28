import { expect, test } from 'bun:test'
import { denyReason, FACTORY_FROM_REASON } from './worker-hook.ts'

const M = 'factory mail r1 implement x'
const DENY = [
  `env -u FACTORY_FROM ${M}`,
  `env --unset=FACTORY_FROM ${M}`,
  `env --unset FACTORY_FROM ${M}`,
  `env --uns FACTORY_FROM ${M}`,
  `env -uFACTORY_FROM ${M}`,
  `env -0u FACTORY_FROM ${M}`,
  `unset FACTORY_FROM; ${M}`,
  'unset -v FACTORY_FROM',
  'export -n FACTORY_FROM',
  'export FACTORY_FROM=manager',
  'declare -x FACTORY_FROM=manager',
  'typeset FACTORY_FROM',
  'readonly FACTORY_FROM',
  `FACTORY_FROM=manager ${M}`,
  `FACTORY_FROM= ${M}`,
  `env FACTORY_FROM=manager ${M}`,
  `env -i ${M}`,
  'env -i PATH=/usr/bin /abs/bin/factory mail r1 implement x',
  `env - ${M}`,
  `env --ignore-environment ${M}`,
  `env -i sh -c "${M}"`,
  `env -i nice sh -c "${M}"`,
  `env -i eval "${M}"`,
  `sh -c "unset FACTORY_FROM; ${M}"`,
  `eval "env -u FACTORY_FROM ${M}"`,
  `env -S"-u FACTORY_FROM" ${M}`,
  `env -u \\\nFACTORY_FROM ${M}`,
  `env --unset=\\\nFACTORY_FROM ${M}`,
  `env --unset \\\nFACTORY_FROM ${M}`,
]
const ALLOW = [
  'factory mail r1 manager "a question"',
  'bin/factory report r1 2 ready x',
  'env -i ls',
  'env -i PATH=/usr/bin ls',
  `env -u OTHER_VAR ${M}`,
  'echo FACTORY_FROM_LOG=1',
  'grep -rn FACTORY_FROM src',
  'env LC_ALL=C grep -rn FACTORY_FROM src',
  'env FOO=1 factory mail r1 implement "FACTORY_FROM note"',
  'git commit -m "fix FACTORY_FROM guard"',
]

test.each(DENY)('denyReason denies %j (claude-factory-ab8n)', cmd => {
  expect(denyReason(cmd)).toBe(FACTORY_FROM_REASON)
})
test.each(ALLOW)('denyReason allows %j (claude-factory-ab8n)', cmd => {
  expect(denyReason(cmd)).toBeUndefined()
})
