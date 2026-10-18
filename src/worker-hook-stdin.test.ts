import { expect, test } from 'bun:test'
import { denyReason, SHELL_STDIN_REASON } from './worker-hook'

// claude-factory-l43b: a shell with no -c script reads its script from stdin, a here-string or a
// process substitution. xargs before a shell word hides the script too. These rows are static
// probes: no row runs a live shell.
const GATE = {
  headOf: (dir?: string) => (dir === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
}

const DENY = [
  "echo 'git push origin main' | sh",
  "echo 'git push origin main' | $SH",
  "echo 'git push origin main' | /bin/s?",
  "sh <<< 'git push origin main'",
  "$SH <<< 'git push origin main'",
  "echo 'git push origin main' | xargs sh -c",
  "echo 'git push origin main' | xargs $SH -c",
  'echo "\'git push origin main\'" | xargs sh -c',
  'echo P | bash',
  'echo P | BASH',
  'echo P | zsh',
  'echo P | dash',
  'echo P | /bin/bash',
  'echo P | \\sh',
  "echo P | 'sh'",
  'echo P | bash -o errexit',
  'echo P | bash -x',
  'echo P | sh -s',
  'echo P | sh -s file.sh',
  'echo P | bash --rcfile f',
  'echo P | xargs --zz v $SH',
  'echo P | sh -',
  'echo P | sh /dev/stdin',
  'echo P | sh /dev/fd/0',
  'echo P | sh -- -',
  'echo P | sh $F',
  'echo P | sh <(echo Q)',
  'echo P | stdbuf -oL sh',
  'echo P | timeout 5 $SH',
  'echo P | (sh)',
  'echo P | { sh; }',
  'echo P | env sh',
  '{ sh; } <<< P',
  'exec <<< P; sh',
  '<<< P $SH',
  'sh < script.txt',
  'bash < <(echo P)',
  'echo P | xargs bash',
  'echo P | xargs -n 1 sh -c',
  'echo P | xargs -I{} sh -c {}',
  'echo P | xargs $SH',
  'echo P | xargs -r $SH',
  'echo P | /usr/bin/xargs zsh',
  "sh -c 'echo P | sh'",
  'echo P | sudo sh',
  'sh<<<P',
  'bash<<<P',
  'zsh<<<P',
  'sh<f',
  'echo P > >(sh)',
  'echo P > >($SH)',
  'echo P | tee >(sh)',
  'sh =(echo P)',
  'bash =(echo P)',
  'echo P | xargs -I % sh -c %',
  'echo P | xargs -I X bash -c X',
  'echo P | xargs -J % sh -c %',
  'echo P | xargs --replace=% sh -c %',
  'echo P | xargs -R 1 -I % sh -c %',
  'echo P | xargs -i sh -c {}',
  'source /dev/stdin <<< P',
  '. /dev/stdin <<< P',
  'echo P | source /dev/stdin',
  'echo P | . /dev/stdin',
  'source <(echo P)',
  '. <(echo P)',
  'source =(echo P)',
  'coproc sh',
]

test.each(DENY)('denyReason denies %j (claude-factory-l43b, shell reads stdin)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, GATE)).toBe(SHELL_STDIN_REASON)
})

test('denyReason denies a dynamic shell word behind xargs -I (claude-factory-l43b)', () => {
  expect(denyReason('echo P | xargs -I {} $SH {}', '/root/repo', undefined, GATE)).toBeDefined()
})

const ALLOW = [
  'sh script.sh',
  'bash -x file.sh',
  'cat f | grep x',
  'echo x | sh script.sh',
  'echo x | bash -x file.sh',
  'echo x | bash -o errexit file.sh',
  'echo x | bash -- file.sh',
  'echo x | sh -c "echo hi"',
  'echo x | bash -lc "echo hi"',
  'echo P | xargs sh -c "echo hi" _',
  'command -v bash',
  'which zsh',
  'bash',
  'ls | xargs -I{} cp {} dest',
  'ls | xargs -I {} cp {} dest',
  'find . | xargs grep foo',
  'echo hi | xargs echo',
  'git log | xargs -n1 echo',
  'source ./env.sh',
  '. ./env.sh',
  'echo x | source ./env.sh',
  'ls | xargs -I % echo %',
]

test.each(ALLOW)('denyReason allows %j (claude-factory-l43b, no stdin script)', cmd => {
  expect(denyReason(cmd, '/root/repo', undefined, GATE)).toBeUndefined()
})
