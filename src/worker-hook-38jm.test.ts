import { expect, test } from 'bun:test'
import {
  BEADS_ACTOR_REASON,
  denyReason,
  DYNAMIC_VERB_REASON,
  type HookGate,
  PUSH_REASON,
  scanReason,
  SH_DYNAMIC_FLAG_REASON,
} from './worker-hook'

// claude-factory-38jm: a dynamic or brace word in the option slot of a sh, bash, zsh or dash call
// can expand to `-c` and a script. A brace word at a command anchor can expand to the command
// itself. The guard cannot read either expansion, so it fails closed.
const GATE: HookGate = {
  headOf: d => (d === '/root/repo' ? 'factory/x' : 'main'),
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)

const BT = '`'

// AC1: a literal shell word with a dynamic word in the -c slot.
const AC1 = [
  "C=-c; sh $C 'git push origin main'",
  'C=-c; sh "$C" \'git push origin main\'',
  "C=-c; sh ${C} 'git push origin main'",
  "C=-c; bash -x $C 'git push origin main'",
  `sh ${BT}echo -c${BT} 'git push origin main'`,
  "sh $(echo -c) 'git push origin main'",
  "C='-c {git,push,origin,main}'; bash $C",
  "C='-c {git,push,origin,main}'; bash $C x",
  "C=-c; bash -o pipefail $C 'git push origin main'",
  "C=-c; bash --rcfile rc $C 'git push origin main'",
  "C=-c; bash --init-file rc $C 'git push origin main'",
  "sh {-c,'git push origin main'}",
  "sh -[b-d] 'git push origin main'",
  "sh -? 'git push origin main'",
  "sh -{b..d} 'git push origin main'",
  "C=-c; zsh $C 'git push origin main'",
  "C=-c; dash $C 'git push origin main'",
  // push shapes: bare, remote-only, --force, current branch. The deny is outright.
  "C=-c; sh $C 'git push'",
  "C=-c; sh $C 'git push origin'",
  "C=-c; sh $C 'git push --force origin factory/x'",
  "C=-c; sh $C 'git push origin factory/x'",
]
test.each(AC1)('38JM AC1 denies %s', cmd => {
  expect(run(cmd)).toBe(SH_DYNAMIC_FLAG_REASON)
})

// AC2: a flag word that holds a dynamic part after a dash may be a -c cluster.
const AC2 = [
  "C=c; sh -$C 'git push origin main'",
  "C=c; sh -${C} 'git push origin main'",
  'C=c; sh -"$C" \'git push origin main\'',
  "C=c; sh -$C -- 'git push origin main'",
]
test.each(AC2)('38JM AC2 denies %s', cmd => {
  expect(run(cmd)).toBe(SH_DYNAMIC_FLAG_REASON)
})

// AC3: the bd scan fails closed on the same shapes.
const AC3 = ["C=c; env -i sh -$C 'bd create x'", "C=-c; env -i sh $C 'bd create x'"]
test.each(AC3)('38JM AC3 denies %s', cmd => {
  expect(run(cmd)).toBe(BEADS_ACTOR_REASON)
})

// AC4: a brace word with a comma or `..` at a command anchor.
const AC4 = [
  "{sh,-c} 'git push origin main'",
  "{sh,-c,'git push origin main'}",
  "{bash,-c} 'git push'",
  "nice {sh,-c} 'git push origin main'",
  "sudo {sh,-c} 'git push origin main'",
  "env -i {sh,-c} 'git push origin main'",
  "env -i {sh,-c} 'bd create x'",
  'env -i {bd,create,x}',
  '{git,push,origin,main}',
  '{git,push} origin main',
  '{a..c} x',
]
test.each(AC4)('38JM AC4 denies %s', cmd => {
  expect(run(cmd)).toBe(DYNAMIC_VERB_REASON)
})

// AC5: literal-safe forms stay allowed.
const AC5 = [
  'sh script.sh',
  'sh -x file',
  "bash -c 'echo $HOME'",
  "sh -c 'git status' $X",
  'sh script.sh $X',
  'sh -- $X',
  "bash -o pipefail -c 'git status'",
  "bash -lc 'git status'",
  'xargs -I {} cp {} dest',
  'echo {a,b}',
  'ls {a,b}.txt',
  'cp "$A" "$B"',
  'sh -c "$CMD"',
]
test.each(AC5)('38JM AC5 allows %s', cmd => {
  expect(run(cmd)).toBeUndefined()
})

// AC6: reasons that deny today stay the same.
test.each(["sh -{c,c} 'git push origin main'", "bash -lc 'git push origin main'"])(
  '38JM AC6 keeps PUSH_REASON for %s',
  cmd => {
    expect(run(cmd)).toBe(PUSH_REASON)
  },
)

// AC7 (the part that works on main): a dynamic word after a literal operand may be a -c flag.
test("38JM AC7 denies sh script.sh $X 'git push origin main' like sh script.sh -c", () => {
  expect(run("sh script.sh $X 'git push origin main'")).toBe(PUSH_REASON)
  expect(run("sh script.sh -c 'git push origin main'")).toBe(PUSH_REASON)
})

test("38JM AC7 denies env -i sh script.sh $X 'bd create x' (bd scan)", () => {
  expect(run("env -i sh script.sh $X 'bd create x'")).toBe(BEADS_ACTOR_REASON)
})

// AC8: cost. The 500 ms limit is far under the hook's 10 s fail-open timeout.
const N = 40000
test('38JM AC8 scanReason denies a 40000-word `sh -o` scan, fast', () => {
  expect(scanReason('sh -o '.repeat(N) + '; rm -rf x')).toBeString()
}, 500)

test('38JM AC8 scanReason denies a 40000-word `bash $C` scan, fast', () => {
  expect(scanReason('bash $C '.repeat(N) + '; rm -rf x')).toBeString()
}, 500)
