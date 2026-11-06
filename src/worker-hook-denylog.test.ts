import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as hook from './worker-hook'
import { HOME_REASON } from './home-guard'

const HOOK = join(import.meta.dir, 'worker-hook.ts')
let home: string
let cwd: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'denylog-'))
  cwd = mkdtempSync(join(tmpdir(), 'denylog-cwd-'))
})
afterEach(() => {
  rmSync(home, { recursive: true })
  rmSync(cwd, { recursive: true })
})

const bash = (command: string) => ({ tool_name: 'Bash', cwd, tool_input: { command } })
function run(input: unknown, env: Record<string, string | undefined> = {}, argv = ['--harness', 'codex']) {
  const e: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd,
    FACTORY_HOME: home,
    FACTORY_RUN: 'r1',
    FACTORY_FROM: 'implement',
    FACTORY_OUTBOX: undefined,
    FACTORY_DENY_LOG: undefined,
    FACTORY_HARNESS: undefined,
    ...env,
  }
  const p = Bun.spawnSync(['bun', HOOK, ...argv], { stdin: Buffer.from(JSON.stringify(input)), env: e })
  return { out: p.stdout.toString(), code: p.exitCode }
}
const file = () => join(home, 'runs', 'r1', 'denials.jsonl')
const lines = () =>
  readFileSync(file(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))

describe('deny log', () => {
  beforeEach(() => mkdirSync(join(home, 'runs', 'r1'), { recursive: true }))

  test('a denied Bash command writes one line with the reason name', () => {
    const r = run(bash('f() { ls; }'))
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason).toBe(hook.FUNCTION_DEF_REASON)
    const l = lines()
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({
      run: 'r1',
      station: 'implement',
      harness: 'codex',
      reason: 'FUNCTION_DEF_REASON',
      command: 'f() { ls; }',
    })
    expect(Number.isFinite(l[0].at)).toBe(true)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  test('the command is cut to 200 chars', () => {
    run(bash('f() { ls; } # ' + 'x'.repeat(500)))
    expect(lines()[0].command).toHaveLength(200)
  })

  test('a denied file write logs FILE_WRITE_REASON', () => {
    run({ tool_name: 'Write', cwd, tool_input: { file_path: join(cwd, '.git', 'config') } })
    expect(lines()[0].reason).toBe('FILE_WRITE_REASON')
  })

  test('the stdout is the same with and without the log', () => {
    const a = run(bash('f() { ls; }'))
    const b = run(bash('f() { ls; }'), { FACTORY_RUN: undefined })
    expect(a.out).toBe(b.out)
    expect(a.out).not.toBe('')
  })

  test('a missing or unknown harness is unknown', () => {
    run(bash('f() { ls; }'), {}, [])
    run(bash('f() { ls; }'), {}, ['--harness', 'evil'])
    expect(lines().map(l => l.harness)).toEqual(['unknown', 'unknown'])
  })

  // claude-factory-ay4w: a hook config with no --harness (an older settings file or image) logged 'unknown'
  test('with no --harness, FACTORY_HARNESS names the harness; --harness wins', () => {
    run(bash('f() { ls; }'), { FACTORY_HARNESS: 'claude' }, [])
    run(bash('f() { ls; }'), { FACTORY_HARNESS: 'claude' }, ['--harness', 'codex'])
    run(bash('f() { ls; }'), { FACTORY_HARNESS: 'evil' }, [])
    expect(lines().map(l => l.harness)).toEqual(['claude', 'codex', 'unknown'])
  })

  test('text with no constant is UNKNOWN', () => {
    expect(hook.reasonName('some other text')).toBe('UNKNOWN')
    expect(hook.reasonName(HOME_REASON)).toBe('HOME_REASON')
  })

  test('reasonName round-trips every exported reason', () => {
    const all = Object.entries({ ...hook, HOME_REASON }).filter(
      (e): e is [string, string] => e[0].endsWith('REASON') && typeof e[1] === 'string',
    )
    expect(all.length).toBeGreaterThan(30)
    for (const [k, v] of all) expect(hook.reasonName(v)).toBe(all.find(e => e[1] === v)![0])
    expect(hook.reasonName(hook.PUSH_REASON)).toBe('PUSH_REASON')
  })

  test('no line for an allowed command', () => {
    run(bash('ls src'))
    expect(existsSync(file())).toBe(false)
  })

  test.each([undefined, '', '.', '..', '../x', 'a/b'])('FACTORY_RUN %p writes nothing', id => {
    const r = run(bash('f() { ls; }'), { FACTORY_RUN: id })
    expect(r.out).toContain('deny')
    expect(existsSync(file())).toBe(false)
    expect(existsSync(join(home, 'x'))).toBe(false)
    expect(existsSync(join(home, 'denials.jsonl'))).toBe(false) // FACTORY_RUN '..'
    expect(existsSync(join(home, 'runs', 'denials.jsonl'))).toBe(false) // FACTORY_RUN '.'
  })

  test('no run dir: no mkdir, same deny', () => {
    const r = run(bash('f() { ls; }'), { FACTORY_RUN: 'r2' })
    expect(r.out).toContain('deny')
    expect(existsSync(join(home, 'runs', 'r2'))).toBe(false)
  })

  test('denials.jsonl as a dir: deny printed, exit 0', () => {
    rmSync(join(home, 'runs', 'r1'), { recursive: true })
    mkdirSync(file(), { recursive: true })
    const r = run(bash('f() { ls; }'))
    expect(r.code).toBe(0)
    expect(r.out).toContain('deny')
  })

  test('an outbox without FACTORY_DENY_LOG writes no outbox line', () => {
    const box = join(home, 'outbox.jsonl')
    run(bash('f() { ls; }'), { FACTORY_OUTBOX: box })
    expect(existsSync(box)).toBe(false)
  })

  test('FACTORY_OUTBOX and FACTORY_DENY_LOG=1 write one outbox deny line', () => {
    const box = join(home, 'outbox.jsonl')
    run(bash('f() { ls; }'), { FACTORY_OUTBOX: box, FACTORY_DENY_LOG: '1' })
    const l = readFileSync(box, 'utf8').trim().split('\n')
    expect(l).toHaveLength(1)
    const o = JSON.parse(l[0]!)
    expect(o.deny).toMatchObject({ harness: 'codex', reason: 'FUNCTION_DEF_REASON', command: 'f() { ls; }' })
    expect(Object.keys(o.deny).sort()).toEqual(['at', 'command', 'harness', 'reason'])
    expect(o.from).toBe('implement')
    expect(o.argv).toBeUndefined()
  })

  test('a NAME=value word is masked in denials.jsonl and the outbox (claude-factory-uzes)', () => {
    const box = join(home, 'outbox.jsonl')
    run(bash('f() { ls; }; X=zqsecret ls'), { FACTORY_OUTBOX: box, FACTORY_DENY_LOG: '1' })
    expect(readFileSync(file(), 'utf8')).not.toContain('zqsecret')
    expect(lines()[0].command).toContain('X=***')
    const o = JSON.parse(readFileSync(box, 'utf8').trim())
    expect(JSON.stringify(o)).not.toContain('zqsecret')
    expect(o.deny.command).toContain('X=***')
  })

  test('a quoted NAME=value inside bash -c is masked end to end', () => {
    run(bash('f() { ls; }; bash -c "GH_TOKEN=zqsecret gh pr list"'))
    expect(readFileSync(file(), 'utf8')).not.toContain('zqsecret')
    expect(lines()[0].command).toContain('GH_TOKEN=***')
  })

  test('the mask runs before the 200-char cut', () => {
    run(bash('f() { ls; } X=' + 'zqsecret'.repeat(40)))
    const c = lines()[0].command
    expect(c).not.toContain('zqsecret')
    expect(c.length).toBeLessThanOrEqual(200)
  })
})

describe('maskAssignments', () => {
  const m = (hook as any).maskAssignments as (s: string) => string
  test.each([
    ['X=zqsecret ls', 'X=*** ls'],
    ['A=1 B=zqsecret ls', 'A=*** B=*** ls'],
    ["X='zq secret' ls", 'X=*** ls'],
    ['X="zq secret" ls', 'X=*** ls'],
    ['X=zq"sec ret" ls', 'X=*** ls'],
    ['X=zq\\ secret ls', 'X=*** ls'],
    ['X="zqsecret', 'X=***'],
    ['f() { ls; }', 'f() { ls; }'],
    ['ls -la /tmp', 'ls -la /tmp'],
    ['echo hello', 'echo hello'],
    ['--token=zqsecret', '--token=zqsecret'],
    ['git -c http.extraHeader=zqsecret', 'git -c http.extraHeader=zqsecret'],
    ['bash -c "GH_TOKEN=zqsecret gh pr list"', 'bash -c "GH_TOKEN=*** gh pr list"'],
    ["sh -c 'X=zqsecret ls'", "sh -c 'X=*** ls'"],
    ['eval "X=zqsecret ls"', 'eval "X=*** ls"'],
    ['env -S "X=zqsecret ls"', 'env -S "X=*** ls"'],
    ['bash -c "sh -c \'X=zqsecret ls\'"', 'bash -c "sh -c \'X=*** ls\'"'],
    ['a[' + 'k'.repeat(65) + ']=zqsecret ls', 'a[' + 'k'.repeat(65) + ']=*** ls'],
    ['a[b[1]]=zqsecret ls', 'a[b[1]]=*** ls'],
    ['a[x y]=zqsecret ls', 'a[x y]=*** ls'],
    ['a["k"]+=zqsecret ls', 'a["k"]+=*** ls'],
    ['X=$(echo zqsecret) ls', 'X=***'],
    ['X=a$(echo zq secret) ls', 'X=***'],
    ['X=`echo zqsecret` ls', 'X=***'],
    ['X="$(echo "zq secret")" ls', 'X=***'],
    ['X=<(cat zqsecret) ls', 'X=***'],
    ['declare -A m=([k]=zqsecret)', 'declare -A m=***'],
    ['m=([k]=zqsecret [j]=v2)', 'm=***'],
    ['m=(zq secret)', 'm=***'],
    ['${X=zqsecret}', '${X=***'],
    ['${X:=zqsecret}', '${X:=***'],
    [': "${GH_TOKEN:=zqsecret}"', ': "${GH_TOKEN:=***'],
    ['echo "${GH_TOKEN:-zqsecret}"', 'echo "${GH_TOKEN:-***'],
    ['${X-zqsecret}', '${X-***'],
    [': ${X:=zq secret}', ': ${X:=***'],
    ['echo "${GH_TOKEN:-zq secret}"', 'echo "${GH_TOKEN:-***'],
    ['${X=zq secret}', '${X=***'],
    ['${X-zq secret}', '${X-***'],
    ['${X:=zq;secret}', '${X:=***'],
    ['${X:=zq|secret}', '${X:=***'],
    ['${X:=zq)secret}', '${X:=***'],
    ['${a[k]=zq secret}', '${a[***'],
    ['${a[1]:=zqsecret}', '${a[***'],
    ['${a[1]:-zqsecret}', '${a[***'],
    ['${a[1]-zqsecret}', '${a[***'],
    ['Y=${X:-zq secret} ls', 'Y=***'],
    ['Y=a${X:=zq secret} ls', 'Y=***'],
    ['a[k]=${X:-zq secret} ls', 'a[k]=***'],
    ['Y=${a[1]:-zq secret} ls', 'Y=***'],
    ['export Y=${X:-zq;secret}', 'export Y=***'],
    ['Y="${X:-"zq secret"}" ls', 'Y=***'],
    ["X=$'zq\\' secret' ls", 'X=***'],
    ["X=a$'zq\\' secret' ls", 'X=***'],
    ['X="a"$\'zq\\\' secret\' ls', 'X=***'],
    ["a[k]=$'zq\\' secret' ls", 'a[k]=***'],
    ['X=$[1 + 2] ls', 'X=***'],
    ['X=zq\rsecret ls', 'X=*** ls'],
    ['X=zq\vsecret ls', 'X=*** ls'],
    ['X=zq\fsecret ls', 'X=*** ls'],
    ['X=zq secret ls', 'X=*** ls'],
    ['ls foo-bar', 'ls foo-bar'],
    ['echo $(date) a-b', 'echo $(date) a-b'],
    ['cat a]b', 'cat a]b'],
    ['ls x==y', 'ls x=***'],
  ])('%s', (i, o) => expect(m(i)).toBe(o))
  test.each([
    'export X=zqsecret',
    'env X=zqsecret ls',
    'ls;X=zqsecret ls',
    'ls&&X=zqsecret ls',
    '(X=zqsecret ls)',
    'X+=zqsecret ls',
    'a[1]=zqsecret ls',
    'a[' + 'k'.repeat(65) + ']=zqsecret ls',
    'a[b[1]]=zqsecret ls',
    'X=$(echo zqsecret) ls',
    'X=`echo zqsecret` ls',
    'm=([k]=zqsecret)',
    '${X:=zqsecret}',
    'bash -c "GH_TOKEN=zqsecret gh pr list"',
    "sh -c 'X=zqsecret ls'",
    'eval "X=zqsecret ls"',
    'env -S "X=zqsecret ls"',
  ])('%s hides the value', i => expect(m(i)).not.toContain('zqsecret'))
  test('an unclosed subscript tail is linear', () => {
    const t = performance.now()
    m(' a['.repeat(1e5))
    expect(performance.now() - t).toBeLessThan(2000)
  })
  test('long rows are fast', () => {
    for (const i of ['X=' + '"'.repeat(1e5), 'a='.repeat(5e4), '"a='.repeat(4e4), "'a=".repeat(4e4)]) {
      const t = performance.now()
      m(i)
      expect(performance.now() - t).toBeLessThan(100)
    }
  })
  test('long ]= and substitution rows stay linear', () => {
    for (const i of [
      ']='.repeat(1e5),
      '"]='.repeat(1e5),
      ' ${a:-'.repeat(1e5),
      ' X=$('.repeat(1e5),
      ' X="$('.repeat(1e5),
      ' a[b['.repeat(1e5),
      ' ${a['.repeat(1e5),
      ' ${a:='.repeat(1e5),
      ' Y=${X:-'.repeat(1e5),
      ' Y="${'.repeat(1e5),
      " X=$'".repeat(1e5),
      ' X=$['.repeat(1e5),
    ]) {
      const t = performance.now()
      m(i)
      expect(performance.now() - t).toBeLessThan(2000)
    }
  })
})
