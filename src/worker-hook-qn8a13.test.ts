import { expect, test } from 'bun:test'
import { denyReason, REASON, type HookGate } from './worker-hook'

// claude-factory-qn8a.13: a brace list in a find exec-slot prefix can expand to a nested find.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', ['acme'], GATE)

const DENY = [
  'find . -exec fi{nd,x} / -delete \\;',
  'find . -exec {find,x} / -delete \\;',
  'find . -exec {find,/} -delete \\;',
  'find . -exec fi{nd,} {/,x} -delete \\;',
  'find . -execdir fi{nd,x} / -delete \\;',
  'find . -ok fi{nd,x} / -delete \\;',
  'find . -okdir fi{nd,x} / -delete \\;',
  'find . -exec fi{nd,x} / -delete +',
  'find . -exec fi{nd,x} / -de{lete,x} \\;',
  'find . -exec fi{nd,x} / -de* \\;',
  'find . -exec fi{nd,x} -L / -delete \\;',
  'find . -exec >f fi{nd,x} / -delete \\;',
  'find . -exec /usr/bin/fi{nd,x} / -delete \\;',
  'find . -exec {/usr/bin/find,x} / -delete \\;',
  'find . -exec {fi,x}nd / -delete \\;',
  'find . -exec {f..g}ind / -delete \\;',
  'find . -exec {{f,x}ind,y} / -delete \\;',
  'find . -exec sudo fi{nd,x} / -delete \\;',
  'find . -exec env fi{nd,x} / -delete \\;',
  'find . -exec timeout 5 fi{nd,x} / -delete \\;',
  'find . -exec nice -n 5 fi{nd,x} / -delete \\;',
  'find . -exec {env,} find / -delete \\;',
  'find . -exec {sudo,} find / -delete \\;',
  'find . -exec sudo {env,} find / -delete \\;',
  'find . -exec timeout {5,find} / -delete \\;',
  'find . -exec find . -exec fi{nd,x} / -delete \\; \\;',
]
const ALLOW = [
  'find . -exec ls{,} {} \\;',
  'find . -exec fi{nd,x} / -print \\;',
  'find . -exec find . -delete \\;',
  'find . -exec find . -name x{a,b} -delete \\;',
  'find . -exec ls {} \\; -name *.{c,h} -delete',
  'find . -name *.{c,h} -delete',
]

test.each(DENY)('denies %s', c => {
  expect(run(c)).toBe(REASON)
})
test.each(ALLOW)('allows %s', c => {
  expect(run(c)).toBeUndefined()
})
