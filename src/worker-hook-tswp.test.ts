import { expect, test } from 'bun:test'
import { denyReason } from './worker-hook'

// claude-factory-tswp: runner words (stdbuf, ionice, flock ...) run their operand command.
// The guard now reads each of them as a wrapper, with every dash word and plain word read two ways.
const ROOT = '/Users/acme/widget'
const run = (cmd: string) => denyReason(cmd, ROOT)

const RUNNERS = [
  'stdbuf -o0',
  'stdbuf -o 0',
  'stdbuf --output=0',
  'ionice -c3',
  'ionice -c 3',
  'caffeinate',
  'caffeinate -i',
  'doas',
  'doas -u root',
  'flock /tmp/l',
  'flock -x /tmp/l',
  'watch',
  'watch -n 1',
  'setsid',
  'setsid -f',
  'taskset 1',
  'taskset -c 0',
  'chrt 1',
  'chrt -f 1',
  'chroot /',
  'strace',
  'strace -f',
  'busybox',
  'arch -arm64',
  'sandbox-exec -n x',
  'unbuffer',
  'ltrace',
  'unshare',
  'nsenter -t 1',
  'systemd-run',
  'firejail',
  'runuser -u x',
  'pkexec',
  'setpriv',
  'prlimit',
  'numactl',
  'faketime now',
  'proxychains',
  'proxychains4',
  'torsocks',
  'cpulimit -l 5',
  'dtruss',
  'catchsegv',
  'chpst',
  'sg wheel',
  'gstdbuf',
  'gtimeout 5',
  'gnice',
  'gnohup',
  'genv',
  'gchroot /',
  'script',
  'ssh-agent',
  'fakeroot',
  'eatmydata',
  'xvfb-run',
  'direnv',
  'nix',
  'bwrap',
  'chronic',
  'ifne',
  'systemd-inhibit',
  'cgexec',
  'trickle',
  'nocache',
  'sem',
  'lckdo',
  'xcrun',
]

const DENY = [
  ...RUNNERS.map(r => `${r} rm -rf /`),
  'parallel rm -rf ::: /',
  'stdbuf -o0 xargs rm -rf',
  'nice stdbuf -o0 rm -rf /',
  'stdbuf -o0 nice -n 5 rm -rf /',
  'cd /tmp && stdbuf -o0 rm -rf x',
  'find . -exec stdbuf -o0 rm -rf {} ;',
  'stdbuf -o0 $X -rf /',
  'taskset 1 $X -rf /',
  'stdbuf -o0 /bin/r? -rf /',
  'watch /bin/r? -rf /',
  'chroot / /bin/r? -rf /',
  'busybox /bin/r? -rf /',
  'parallel /bin/r? -rf ::: /',
  'chroot -- / rm -rf /',
  'flock -- /tmp/l rm -rf /',
  'taskset -- 1 rm -rf /',
  'chrt -- 1 rm -rf /',
  'faketime -- now rm -rf /',
  'sg -- wheel rm -rf /',
  'chroot -- / /bin/r? -rf /',
  'flock -- /tmp/l $X -rf /',
  'cd /tmp; flock -- /tmp/l rm -rf x',
  '>f doas rm -rf /',
  '>f taskset 1 rm -rf /',
  '2>/dev/null stdbuf -o0 rm -rf /',
  'stdbuf -o0 {rm,} -rf /',
  'doas {rm,} -rf /',
  'taskset 1 {rm,} -rf /',
  'stdbuf -o0 {r,}m -rf /',
  'stdbuf -o0 r{m,} -rf /',
  "stdbuf -o0 {sh,-c} 'rm -rf /'",
  "doas {sh,-c} 'rm -rf /'",
  'doas {git,push} origin main',
  'doas $X $Y',
  'taskset 1 $X $Y',
]

test.each(DENY)('denyReason denies %j (claude-factory-tswp)', cmd => {
  expect(run(cmd)).toBeString()
})

const ALLOW = [
  'stdbuf -o0 ls',
  'stdbuf -o0 bun test',
  'ionice -c3 ls -la',
  'caffeinate -i bun test',
  'flock /tmp/l make',
  'watch -n 1 ls',
  'taskset 1 ls',
  'chrt 1 ls',
  'strace ls',
  'busybox ls',
  'chroot / ls',
  'parallel echo ::: a b',
  'doas ls',
  'setsid ls',
  'nohup bun test',
]

test.each(ALLOW)('denyReason allows %j (claude-factory-tswp)', cmd => {
  expect(run(cmd)).toBeUndefined()
})

test.each(RUNNERS)('denyReason gives rm node_modules the same verdict behind %j (claude-factory-tswp)', r => {
  expect(run(`${r} rm -rf node_modules`)).toBe(run('rm -rf node_modules'))
})

test.each([['stdbuf -o0 '.repeat(2000) + 'rm -rf /'], ['watch ' + 'a '.repeat(4000)]])(
  'denyReason bounds a long runner chain (claude-factory-tswp)',
  cmd => {
    const t0 = Date.now()
    run(cmd)
    expect(Date.now() - t0).toBeLessThan(1000)
  },
  30_000,
)
