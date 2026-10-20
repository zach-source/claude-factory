import { expect, test } from 'bun:test'
import { denyReason, DYNAMIC_VERB_REASON, type HookGate } from './worker-hook'

// claude-factory-5hjj: zsh (and bash with extglob) run a glob group in the command word, such as
// /bin/r(m). segments() splits the word at the paren, so no scan sees the command.
const GATE: HookGate = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)
const RM = 'r' + 'm'

const DENIED = [
  'eval /bin/r(m) -rf /',
  'eval /bin/@(r)m -rf /',
  'eval /bin/g(i)t push origin main',
  '/bin/r(m|"))") -rf /',
  '/bin/r(m|\\)) -rf /',
  '/bin/r(m|");") -rf /',
  "/bin/r(m|')|') -rf /",
  '>| x /bin/r(m) -rf /',
  '>>| x /bin/r(m) -rf /',
  '2>| x /bin/r(m) -rf /',
  '&>| x /bin/r(m) -rf /',
  '>| x /bin/g(i)t push origin main',
  '>! f /bin/r(m) -rf /',
  '>>! f /bin/r(m) -rf /',
  '2>! f /bin/r(m) -rf /',
  '>&! f /bin/r(m) -rf /',
  '&>! f /bin/r(m) -rf /',
  '>&| f /bin/r(m) -rf /',
  '>>&| f /bin/r(m) -rf /',
  '2>&| f /bin/r(m) -rf /',
  '>&| f /bin/g(i)t push origin main',
  '>! f /bin/g(i)t push origin main',
  'shopt -s extglob\n{fd}>f /bin/@(r)m -rf /',
  'shopt -s extglob\n{fd}>/dev/null /bin/@(r)m -rf /',
  'shopt -s extglob\n{v}<f /bin/@(r)m -rf /',
  'shopt -s extglob\n{fd}>&2 /bin/@(r)m -rf /',
  'shopt -s extglob\n{fd}>>f /bin/@(r)m -rf /',
  'shopt -s extglob\n{fd}> f /bin/@(r)m -rf /',
  'shopt -s extglob\n2>&1 {fd}>f /bin/@(r)m -rf /',
  '{fd}>f /bin/g(i)t push origin main',
  'shopt -s extglob\n>&- /bin/@(r)m -rf /',
  'shopt -s extglob\n3>&- /bin/@(r)m -rf /',
  'shopt -s extglob\n{fd}>&- /bin/@(r)m -rf /',
  '/bin/r(m) -rf /',
  `/bin/${RM}(.) -rf /`,
  '/bin/r(m|x) -rf /',
  '/bin/(r)m -rf /',
  '"/bin/r"(m) -rf /',
  'r(m) -rf /',
  '/bin/g(i)t push origin main',
  '/bin/@(r)m -rf /',
  'shopt -s extglob\n/bin/+(r)m -rf /',
  '/bin/?(r)m x',
  '/bin/*(r)m x',
  '/bin/!(x)m x',
  'sudo /bin/r(m) -rf /',
  'sudo -u x /bin/r(m) x',
  'env A=1 /bin/r(m) x',
  'nohup /bin/r(m) x',
  'foo=bar /bin/r(m) x',
  '>x /bin/r(m) x',
  '> x /bin/r(m) x',
  '2>/dev/null /bin/r(m) x',
  'find . -exec /bin/r(m) -rf {} +',
  'xargs /bin/r(m) -rf',
  'bash -c "/bin/r(m) -rf /"',
  'eval "/bin/r(m) x"',
  'ls; /bin/r(m) x',
]
test.each(DENIED)('denies a glob group in the command word: %s', cmd => {
  expect(run(cmd)).toBe(DYNAMIC_VERB_REASON)
})

const GITCONFIG_DENIED = [
  'echo x >&| ~/.gitconfig',
  'echo x >>&| ~/.gitconfig',
  'echo x 2>&| ~/.gitconfig',
  'echo x >&| ~/.config/git/config',
  'echo x >&| /Users/u/.gitconfig',
  'echo x >! ~/.gitconfig',
  'echo x >&! ~/.gitconfig',
]
test.each(GITCONFIG_DENIED)('denies a clobber redirect to the global git config: %s', cmd => {
  expect(run(cmd)).toBeTruthy()
})

const ALLOWED = [
  'echo hi >&| f ; ls',
  'echo a(b)',
  'echo "r(m)"',
  "echo 'r(m)'",
  '(ls)',
  'ls (x)',
  'ls; (ls)',
  'a=(1 2)',
  'cat <(ls)',
  'diff <(a) <(b)',
  'echo $(ls)',
  '(cd x; ls)',
  'ls (-)-all',
  "python3 -c 'print(len(x))'",
  "python3 <<'EOF'\nprint(\"don't\")\nEOF",
  '"$PY" -c \'print(1)\'',
  '/bin/r(m)',
]
test.each(ALLOWED)('allows a harmless paren: %s', cmd => {
  expect(run(cmd)).toBeUndefined()
})
