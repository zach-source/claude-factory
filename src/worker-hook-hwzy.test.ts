import { expect, test } from 'bun:test'
import { denyReason, type HookGate } from './worker-hook'

// claude-factory-hwzy: a brace word with = after a wrapper hid the real command, because the
// wrapper assignment skip read the word as NAME=value. The shell expands the word first.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', ['acme'], GATE)

const DENY = [
  'sudo {/tmp/d=1/rm,} -r ./d',
  'sudo -u root {/tmp/d=1/rm,} -r ./d',
  'sudo -- {/tmp/d=1/rm,} -r ./d',
  'env sudo {/tmp/d=1/rm,} -r ./d',
  'sudo {/tmp/d=1/rm,x} -r ./d',
  'sudo {/tmp/d=1/rm..} -r ./d',
  'sudo /tmp/{d=1/rm,} -r ./d',
  'sudo /tmp/d=1/{rm,} -r ./d',
  'sudo {A=1,rm} -rf /',
  'sudo {A=1,ls} -r ./d',
  'sudo -u root {A=1,ls} -a',
  'env {A=1,rm} -rf /',
  'env {/tmp/d=1/rm,} -r ./d',
  'env -- {/tmp/d=1/rm,} -r ./d',
  'nice {A=1,rm} -rf /',
  'timeout 5 {/tmp/d=1/rm,} -r ./d',
  'sudo /tmp/d=1/r? -r ./d',
  'sudo /tmp/d=1/r[m] -r ./d',
]
const ALLOW = [
  'sudo A=1 ls',
  'sudo A=1 B=2 ls -la',
  'sudo -- A=1 ls',
  'env A=1 ls',
  'sudo env A=1 ls',
  'env A=b,c ls',
  'env A=1..2 ls',
  'sudo A=/x/y ls',
  'env A=x,y ls',
]

test.each(DENY)('denies %s', cmd => {
  expect(run(cmd)).toBeDefined()
})
test.each(ALLOW)('allows %s', cmd => {
  expect(run(cmd)).toBeUndefined()
})
