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
]
const ALLOW = [
  'gh pr ready 5 --undo',
  'gh pr ready --undo 5',
  'gh pr ready --undo',
  'gh pr -R o/r ready --undo 1',
  'gh pr --zz ready --undo 1',
  'gh pr --zz 3 ready --undo 1',
  "gh pr ready 5 '--undo'",
  'gh pr ready 5 --undo -- --undo=false',
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
