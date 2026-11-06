import { expect, test } from 'bun:test'
import { denyReason, READY_REASON } from './worker-hook.ts'

// claude-factory-qn8a.23: gh takes the last value of a bool flag, so any `--undo=<value>` word
// or dynamic word can cancel the undo exemption. Only the plain `--undo` word is exempt.
const DENY = [
  'gh pr ready 5 --undo --undo=false',
  'gh pr ready 5 --undo=false --undo',
  'gh pr ready 5 --undo --undo=0',
  'gh pr ready 5 --undo --undo=f',
  'gh pr ready 5 --undo --undo=no',
  'gh pr ready 5 --undo --undo=true',
  'gh pr ready 5 --undo --undo=FALSE',
  "gh pr ready 5 --undo '--undo=false'",
  'gh pr ready 5 --undo --undo=\\false',
  'gh pr ready 5 --undo --undo=$X',
  'gh pr ready 5 --undo $X',
  'gh pr ready 5 --undo "$X"',
  'gh pr ready "$N" --undo',
  'gh pr -R o/r ready --undo --undo=false 1',
  'gh pr --zz ready --undo --undo=false 1',
  'gh --zz pr ready --undo --undo=false 1',
  'gh pr --zz ready --undo "$X" 1',
  'gh pr --zz 3 ready --undo --undo=false 1',
  'gh pr ready 5 --undo (-)-undo=false',
  'gh pr ready 5 --undo (--undo=false)',
  'gh pr -R o/r ready --undo (-)-undo=false 1',
  'gh pr --zz ready --undo (-)-undo=false 1',
  'gh pr ready 5 --undo ^x',
  'gh pr ready 5 --undo !(x)',
  'gh pr ready 5 --undo --undo#=false',
  'gh pr ready 5 --undo -#-undo=false',
  'setopt extendedglob; gh pr ready 5 --undo --undo#=false',
  'gh pr -R o/r ready --undo --undo#=false 1',
  'gh pr --zz ready --undo --undo#=false 1',
  'gh pr ready 5 --undo --und<->o=false',
  'gh pr ready 5 --undo -~x-undo=false',
  // -R and --repo eat the next word; with a URL selector gh ignores the value (claude-factory-qn8a.23.5)
  'gh pr ready https://github.com/acme/widget/pull/5 -R --undo',
  'gh pr ready https://github.com/acme/widget/pull/5 --repo --undo',
  'gh pr ready -R --undo https://github.com/acme/widget/pull/5',
  'gh pr -R --undo ready https://github.com/acme/widget/pull/5',
  'gh -R --undo pr ready https://github.com/acme/widget/pull/5',
  'gh pr ready https://github.com/acme/widget/pull/5 --undo -R -- --undo=false',
  'gh pr ready https://github.com/acme/widget/pull/5 --undo --repo -- --undo=false',
  'gh pr ready --undo -R -- --undo=false https://github.com/acme/widget/pull/5',
  'gh pr --zz ready https://github.com/acme/widget/pull/5 -R --undo',
  'gh pr --zz ready https://github.com/acme/widget/pull/5 --undo -R -- --undo=false',
  'gh pr ready https://github.com/acme/widget/pull/5 --undo -R',
  'gh pr ready https://github.com/acme/widget/pull/5 --undo -R $X',
  'gh pr ready https://github.com/acme/widget/pull/5 --undo --repo (-)-undo=false',
  // closed grammar (claude-factory-qn8a.23.6): only `pr [-R repo] ready` with --undo, one selector, one repo
  'gh pr --zz ready --undo 1',
  'gh pr --zz 3 ready --undo 1',
  'gh pr ready 5 --undo -- --undo=false',
  'gh pr ready --undo --undo',
  'gh pr ready feature-x --undo',
  'gh pr ready 5 6 --undo',
  'gh pr ready 0 --undo',
  'gh pr ready --repo=acme/widget --undo 5',
  'gh pr ready --undo -R acme/widget -R acme/widget',
  'gh pr -R acme/widget ready 5 --undo -R acme/widget',
  'gh pr ready 5 --undo -R --undo',
  'gh pr ready 5 --undo -R acme',
  'gh pr ready http://github.com/acme/widget/pull/5 --undo',
  'gh pr ready https://github.com/acme/widget/pull/5/files --undo',
  'gh pr ready 5 --undo -d',
  'gh pr ready 5 --undo 2>&1',
  'gh -R acme/widget pr ready --undo 5',
  'gh pr 5 ready --undo',
  'gh pr ready 5',
  'gh pr ready',
]
const ALLOW = [
  'gh pr ready 5 --undo',
  'gh pr ready --undo 5',
  'gh pr ready --undo',
  'gh pr -R o/r ready --undo 1',
  "gh pr ready 5 '--undo'",
  'gh pr ready 5 --undo -R acme/widget',
  'gh pr ready --repo acme/widget --undo 5',
  'gh pr --repo acme/widget ready --undo 5',
  'gh pr ready 5 --undo | cat',
  'gh pr ready 5 --undo && echo ok',
  'gh pr ready https://github.com/acme/widget/pull/5 --undo',
]
const DENY_STATIONS = [undefined, 'implement', 'plan', 'verify', 'quick']
const run = (cmd: string, station?: string) => denyReason(cmd, undefined, undefined, { station })

for (const station of DENY_STATIONS) {
  test.each(DENY)(`denies %j at station ${station} (claude-factory-qn8a.23)`, cmd => {
    expect(run(cmd, station)).toBe(READY_REASON)
  })
}
for (const station of [...DENY_STATIONS, 'release']) {
  test.each(ALLOW)(`allows %j at station ${station} (claude-factory-qn8a.23)`, cmd => {
    expect(run(cmd, station)).toBeUndefined()
  })
}
for (const station of ['release', 'review', 'security', 'check']) {
  test.each(DENY)(`allows %j at approving station ${station} (claude-factory-qn8a.23)`, cmd => {
    expect(run(cmd, station)).toBeUndefined()
  })
}
