import { expect, test } from 'bun:test'
import { denyReason, GLOB_CODE_REASON, type HookGate } from './worker-hook'

// claude-factory-1r7x: zsh runs the body of a glob qualifier e:...: (and +name) once per match.
const GATE: HookGate = {
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
}
const run = (cmd: string) => denyReason(cmd, '/root/repo', undefined, GATE)
const RM = 'r' + 'm'
const PUSH = 'git ' + 'push origin main'

const DENIED = [
  "ls a\\${(e:'echo hi':)",
  `ls *(e:'${RM} -rf /':)`,
  `ls *(e:'${PUSH}':)`,
  `echo *(e:'${RM} -rf /':)`,
  `ls *(+${RM})`,
  'ls *(+1)',
  `ls *(.e:'${RM} -rf /':)`,
  `ls *(Ne:'${RM} -rf /':)`,
  `ls *(om[1]e:'${RM} -rf /':)`,
  `ls *(^e:'${RM} -rf /':)`,
  `ls *(\\e:'${RM} -rf /':)`,
  `ls *(QeQ:'${RM} -rf /':)`,
  `ls *(e^${RM} -rf /^)`,
  `ls *(e\n'${RM} -rf /'\n)`,
  `ls a(e:'${RM} -rf /':)`,
  `ls ./(e:'${RM} -rf /':)`,
  `ls "a"(e:'${RM} -rf /':)`,
  `ls *(e:'${RM} -rf /':)>f`,
  `ls *(e:'${RM} -rf /':) >f`,
  `ls *(e:'${RM} -rf /':)\\\n x`,
  "ls (a)(e:'echo RAN':)",
  "ls $(echo a)(e:'echo RAN':)",
  "ls `echo a`(e:'echo RAN':)",
  "cat <<'EOF' \\\nls *(e:'echo RAN':)\nbody\nEOF",
  'ls *($q:x:)',
  'ls *(`id`:x:)',
  'ls *(`echo e`:x:)',
  `ls a=(e:'${RM} -rf /':)`,
  `ls a\\$(e:'${RM} -rf /':)`,
  `ls a\\=(e:'${RM} -rf /':)`,
  `bash -c "ls *(e:'${RM} -rf /':)"`,
  `eval "ls *(e:'${RM} -rf /':)"`,
  `sudo ls *(e:'${RM} -rf /':)`,
  `env A=1 ls *(e:'${RM} -rf /':)`,
  `xargs ls *(e:'${RM} -rf /':)`,
  `find . -exec ls *(e:'${RM} -rf /':) ;`,
  `echo $(ls *(e:'${RM} -rf /':))`,
  `ls; ls *(e:'${RM} -rf /':)`,
  `true && ls *(e:'${RM} -rf /':)`,
  `ls\nls *(e:'${RM} -rf /':)`,
  `cat <<EOF\n$(ls *(e:'${RM} -rf /':))\nEOF`,
]
test.each(DENIED)('denies a glob qualifier that runs code: %s', cmd => {
  expect(run(cmd)).toBe(GLOB_CODE_REASON)
})

const ALLOWED = [
  "ls a\\\\${(e:'echo hi':)",
  'ls *(N)',
  'ls *(.)',
  'ls -d *(/)',
  `ls '*(e:x:)'`,
  'ls "*(e:x:)"',
  'ls *\\(e:x:\\)',
  'ls (e:x:)',
  'arr=(one three)',
  'a=(e f) b=(e)',
  'echo $((1+2))',
  'echo ${(e)x}',
  'echo $a[(e)1]',
  'diff =(ls) =(ls)',
  'echo $(ls)',
  'cat <(cat f)',
  "cat > f.py <<'EOF'\nprint(response.text)\nEOF",
  "python3 - <<'EOF'\nprint(len(entries))\nEOF",
  "gh pr create --body-file - <<'EOF'\nSee note (here)\nEOF",
]
test.each(ALLOWED)('allows a harmless paren: %s', cmd => {
  expect(run(cmd)).toBeUndefined()
})
