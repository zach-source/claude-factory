import { describe, expect, test } from 'bun:test'
import * as hook from './worker-hook'

// claude-factory-qn8a.21.21 and .21.22
const H = '/f/acme-factory'
const ROOT = '/w/acme'
const R: string = hook.HOOK_CONTROL_REASON ?? 'missing'
const bash = (cmd: string) => hook.denyReason(cmd, ROOT, undefined, { cwd: ROOT, hookDir: H })
const S = '.claude/settings.local.json'

describe('qn8a.21.21 astral char before a quoted brace', () => {
  test.each([
    `tee {x😀,'{',${S}}`,
    `tee {x😀,"{",${S}}`,
    `tee {x😀,'}',${S}}`,
    `tee 😀/../{.claude,'{'}/settings.local.json`,
    `tee {x𐀀,'{',${S}}`,
    `tee {😀,'{',${H}/src/cut.ts}`,
    `cd {😀,'{',.claude}`,
    `tee {x😀😀,'{','{',${S}}`,
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test('a plus sign in a sequence is read as a number', () => {
    expect(hook.expandBraces('a{+1..3}')).toEqual(['a1', 'a2', 'a3'])
  })
})

describe('qn8a.21.22 over-cap brace list in an operand-skip segment', () => {
  const many = (s: string, n = 65) => Array.from({ length: n }, () => s).join(',')
  test.each([
    `git log -1 --format=x {--output=${S},${many('-s')}}`,
    `git diff {--output=${S},${many('-p')}}`,
    `bd export {-o${S},${many('-q')}}`,
    `bun test {--reporter-outfile=${S},${many('x')}}`,
    `git log -1 {--output=${H}/src/cut.ts,${many('-s')}}`,
  ])('denies %s', c => expect(bash(c)).toBeDefined())
  test.each([`echo {${many('a', 70)}}`, `git log -1 {${many('-s', 70)}}`])('allows %s', c =>
    expect(bash(c)).toBeUndefined(),
  )
})
