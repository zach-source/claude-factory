import { expect, test } from 'bun:test'
import { denyReason, type HookGate } from './worker-hook'

// claude-factory-2hz6: segments() ends a segment at a backtick, so the wrapper segment held only
// the NAME=value (or flag value) word and no command. The guard now denies a skipped wrapper
// word that holds a backtick. This reading only denies.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', ['acme'], GATE)
const BT = '`'
const sub = (s: string) => BT + s + BT

const deny = [
  `sudo A=${sub('echo 1 rm')} -rf /`,
  `env A=${sub('echo 1 rm')} -rf /`,
  `sudo -E A=${sub('echo 1 rm')} -rf /`,
  `X=1 sudo A=${sub('echo 1 rm')} -rf /`,
  `sudo -- A=${sub('echo 1 rm')} -rf /`,
  `env -i A=${sub('echo 1 rm')} -rf /`,
  `nice env A=${sub('echo 1 rm')} -rf /`,
  `sudo -u ${sub('echo root rm')} -rf /`,
  `sudo -C ${sub('echo 3 rm')} -rf /`,
  `env -u ${sub('echo X rm')} -rf /`,
  `nice -n ${sub('echo 5 rm')} -rf /`,
  'sudo A=$(echo 1 rm) -rf /',
  'env A=$(echo 1 rm) -rf /',
]
test.each(deny)('denies %s', row => {
  expect(run(row)).toBeDefined()
})

const allow = [
  'env A=1 ls',
  'sudo A=1 ls',
  `A=${sub('date')} ls`,
  `A=${sub('date')} B=${sub('date')} ls`,
  `A=${sub('echo 1 rm')} -rf /`,
  `echo A=${sub('echo 1 rm')} -rf /`,
  `ls ${sub('pwd')}`,
  `echo ${sub('date')}`,
  `git log --since=${sub('date')}`,
]
test.each(allow)('allows %s', row => {
  expect(run(row)).toBeUndefined()
})
