import { expect, test } from 'bun:test'
import {
  denyReason,
  DYNAMIC_VERB_REASON,
  FUNCTION_DEF_REASON,
  type HookGate,
  HEREDOC_REASON,
  SCRATCH_HINT,
  SH_DYNAMIC_FLAG_REASON,
  SH_DYNAMIC_SCRIPT_REASON,
  SHELL_ALIAS_DEFINE_REASON,
  SHELL_STDIN_REASON,
} from './worker-hook'
import * as hook from './worker-hook'

// claude-factory-ukho: a deny for a shell form the guard cannot read ends with the scratch fix.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)

const HINT =
  'Write these steps with the Write tool to .scratch/<name>.sh (or .scratch/<name>.ts for denyReason rows), then run it by its literal path.'

const ROWS: [string, string, string][] = [
  ['stdin here-doc', "bash <<'EOF'\nls\nEOF", SHELL_STDIN_REASON],
  ['stdin pipe', 'echo x | bash', SHELL_STDIN_REASON],
  ['here-doc quote', "cat <<EOF\nit's\nEOF\nls", HEREDOC_REASON],
  ['dynamic -c script', 'bash -c "$S"', SH_DYNAMIC_SCRIPT_REASON],
  ['dynamic flag', 'bash $F', SH_DYNAMIC_FLAG_REASON],
  ['function', 'f(){ ls; }; f', FUNCTION_DEF_REASON],
  ['alias define', 'T=go; nix shell nixpkgs#go -c $T test', SHELL_ALIAS_DEFINE_REASON],
]

test('SCRATCH_HINT is the fixed line', () => {
  expect(SCRATCH_HINT).toBe(HINT)
})

for (const [name, cmd, reason] of ROWS) {
  test(`deny ${name} ends with the hint`, () => {
    const got = run(cmd)
    expect(got).toBe(reason)
    expect(got?.endsWith(' ' + HINT)).toBe(true)
  })
}

test('FUNCTION_DEF_REASON states the scratch fix once', () => {
  expect(FUNCTION_DEF_REASON.split('Write tool').length).toBe(2)
})

test('other reasons carry no hint', () => {
  const inSet = new Set<string>(ROWS.map(r => r[2]))
  for (const [k, v] of Object.entries(hook)) {
    if (k.endsWith('_REASON') && typeof v === 'string' && !inSet.has(v)) {
      expect(v).not.toContain('.scratch/<name>.sh')
    }
  }
  expect(run('git $V origin HEAD')).toBe(DYNAMIC_VERB_REASON)
  expect(run('$(echo gh) pr merge 1')).toBe(DYNAMIC_VERB_REASON)
})

test('plain forms stay allowed', () => {
  for (const c of [
    'for f in a b; do echo $f; done',
    'bash -c "git status"',
    'cat <<EOF > .scratch/a\nx\nEOF',
  ]) {
    expect(run(c)).toBeUndefined()
  }
})
