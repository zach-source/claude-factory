import { expect, test } from 'bun:test'
import { denyReason, type HookGate } from './worker-hook'

// claude-factory-piqf: a head word that glues text to a visibly set name runs the split value.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)

const DENY = [
  // goal rows
  "X='rm -rf /'; ${X}x",
  "X=' -rf /'; rm${X}",
  // gap rows
  "X=' push origin HEAD:main'; git${X}",
  "X=' push origin HEAD:main'; git$X",
  "X=' push origin HEAD:main'; env git${X}",
  "X=' push origin HEAD:main'; time git${X}",
  "X=' push origin HEAD:main'; command git${X}",
  "X=' push origin HEAD:main'; sudo git${X}",
  "X='sh -c'; ${X}x 'rm -rf /'",
  "X='h -c'; s${X} 'rm -rf /'",
  "X=' -c'; sh${X} 'rm -rf /'",
  "X=' api -X PUT repos/o/r/branches/main/protection'; gh${X}",
  // zsh split forms
  "X=' push origin HEAD:main'; git$=X",
  "X=' push origin HEAD:main'; git${=X}",
  "X=' push origin HEAD:main'; git$~X",
  // unreadable sets
  'for X in "git push origin HEAD:main"; do git${X}; done',
  'X=$(echo " push origin HEAD:main"); git${X}',
  "IFS=/; X=' push'; git${X}",
  "X=a; X=' push origin HEAD:main'; git${X}",
  'read X; git${X}',
  // the slash exception fails closed
  "X='/a b'; ${X}/bin/tool",
  "X='/a*'; ${X}/bin/tool",
  'X=/x; ${X/x/ y}/bin/tool',
  'IFS=/; X=/x; ${X}/bin/tool',
  'let X=1; ${X}/bin/tool',
  'read $N; X=/x; ${X}/bin/tool',
  'X=/x; git${X}',
  'X=/x; ${X:-$Y}/bin/tool',
  'X=/x; X=/x; ${X}/bin/tool',
  'X=/x; echo X; ${X}/bin/tool',
  'REPLY=/x; ${REPLY}/bin/tool',
  'X=/x; $X/bin/rm -rf /',
]
const ALLOW = [
  'HOME=/x; ${HOME%/}/bin/tool',
  '${PAGER:-less} README.md',
  'X=/x; ${X}/bin/tool',
  'X=/x; $X/bin/tool',
  'git${UNSET} status',
  '$HOME/bin/tool',
  'echo ${X}x',
  'X=.scratch; ls $X/a',
]

for (const c of DENY) test(`denies ${c}`, () => expect(run(c)).toBeDefined())
for (const c of ALLOW) test(`allows ${c}`, () => expect(run(c)).toBeUndefined())
