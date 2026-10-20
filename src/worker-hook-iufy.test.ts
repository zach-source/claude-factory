import { expect, test } from 'bun:test'
import { denyReason, GLOB_SUBST_REASON, type HookGate } from './worker-hook'

// claude-factory-iufy: a tilde expansion or the GLOB_SUBST option reads a variable value as a glob.
const GATE: HookGate = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)
const P = `x='*(e:"echo RAN >&2":)'; `

const TILDE = [
  'ls ${~x}',
  'ls $~x',
  'ls ${^~x}',
  'ls ${=~x}',
  'ls ${~${x}}',
  'ls ${~y:-$x}',
  'ls $~x[1,-1]',
  'ls ${(L)~x}',
  'eval \\$\\~x',
  "eval '$''~x'",
  'eval "$"~x',
  'ls $\\\n~x',
]
const OPTS = [
  'setopt globsubst',
  'setopt GLOB_SUBST',
  'setopt Glob_Subst',
  'setopt g_l_o_b_subst',
  'setopt -o globsubst',
  'setopt -- globsubst',
  'builtin setopt globsubst',
  'set -o globsubst',
  'set -o GLOB_SUBST',
  'unsetopt noglobsubst',
  'unsetopt NO_GLOB_SUBST',
  'set +o noglobsubst',
  'options[globsubst]=on',
  "zsh -o globsubst -c 'ls'",
  "zsh --globsubst -c 'ls'",
  'f() { setopt localoptions globsubst; }',
]
const UNREADABLE = [
  "setopt -m 'glob?ub*'",
  'setopt $o',
  'unsetopt ${o}',
  'set -o $o',
  'options[$k]=on',
  'options+=($k on)',
]
for (const c of [...TILDE, ...OPTS, ...UNREADABLE])
  test(`denies ${JSON.stringify(c)}`, () => {
    expect(run(P + c)).toBe(GLOB_SUBST_REASON)
  })

const ALLOW = [
  'ls $x',
  'ls "${x}"',
  'ls ~/x',
  'ls $HOME/~x',
  'grep -n globsubst README.md',
  'git log --grep globsubst',
  'setopt extendedglob',
  'set -o pipefail',
]
for (const c of ALLOW) test(`allows ${c}`, () => expect(run(c)).toBeUndefined())
