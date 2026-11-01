import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Each row spawns bin/factory (a bun start-up), and the refusal test spawns 25 of them.
setDefaultTimeout(120_000)

const BIN = join(import.meta.dir, '..', 'bin', 'factory')
const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mutate-'))
  dirs.push(d)
  return d
}

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-C', cwd, ...a])

// A fresh git repo holding the tracked file src/widget.ts with the given bytes.
function repo(bytes: string | Buffer = 'const a = 1\nreturn x >= 2\nend\n', mode = 0o644) {
  const d = tmp()
  git(d, 'init', '-q')
  git(d, 'config', 'user.email', 'a@acme.test')
  git(d, 'config', 'user.name', 'acme')
  mkdirSync(join(d, 'src'))
  const file = join(d, 'src', 'widget.ts')
  writeFileSync(file, bytes)
  chmodSync(file, mode)
  git(d, 'add', '.')
  git(d, 'commit', '-q', '-m', 'init')
  return { d, file }
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const home = tmp()
  const e: Record<string, string | undefined> = {
    ...process.env,
    FACTORY_SELF_UPDATE: '0',
    FACTORY_HOME: home,
    ...env,
  }
  for (const k of ['FACTORY_OUTBOX', 'FACTORY_FROM', 'FACTORY_RUN']) delete e[k]
  const p = Bun.spawnSync([BIN, 'mutate', ...args], { cwd, env: e as Record<string, string>, timeout: 60000 })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), home }
}

// A test argv: runs `body` as a bash script; `$M` is a marker file path that the script touches.
function script(d: string, name: string, body: string) {
  const p = join(d, name)
  writeFileSync(p, `#!/bin/bash\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

test('KILLED: a test that fails on the mutant exits 0, prints one row, restores the bytes', () => {
  const { d, file } = repo()
  const before = readFileSync(file)
  const t = script(tmp(), 'fail-on-mutant.sh', `grep -q '>= 2' src/widget.ts`)
  const r = run(d, ['src/widget.ts:2', '>=', '>', '--', t])
  expect(r.code).toBe(0)
  expect(r.out.trim().split('\n')).toHaveLength(1)
  expect(r.out).toMatch(/^\| src\/widget\.ts:2 \| >= -> > \| test exit 1 \| KILLED \|\n$/)
  expect(readFileSync(file).equals(before)).toBe(true)
  expect(readdirClean(d)).toBe('')
  expect(existsSync(r.home) && Bun.spawnSync(['ls', r.home]).stdout.toString()).toBe('')
})

test('SURVIVED: a test that passes on the mutant exits 1 and restores the bytes', () => {
  const { d, file } = repo()
  const before = readFileSync(file)
  const r = run(d, ['src/widget.ts:2', '>=', '>', '--', 'true'])
  expect(r.code).toBe(1)
  expect(r.out).toMatch(/SURVIVED \|\n$/)
  expect(readFileSync(file).equals(before)).toBe(true)
})

function readdirClean(d: string) {
  return git(d, 'status', '--short').stdout.toString()
}

test('byte for byte: CRLF, no trailing newline, multibyte, mode 0755; only the named line changes', () => {
  const bytes = Buffer.from('é = 1\r\nreturn x >= 2 >= 3\r\nlast >= 9', 'utf8')
  const { d, file } = repo(bytes, 0o755)
  const mode = statSync(file).mode
  const t = script(d, 'copy.sh', `cp src/widget.ts "${d}/seen.txt"; exit 1`)
  const r = run(d, ['src/widget.ts:2', '2 >= 3', '2 > 3', '--', t])
  // baseline fails here (exit 1 on the clean file), so use a passing baseline script instead
  expect(r.code).toBe(2)
  const t2 = script(
    d,
    'copy2.sh',
    `if grep -q '2 > 3' src/widget.ts; then cp src/widget.ts "${d}/seen.txt"; exit 1; fi`,
  )
  const r2 = run(d, ['src/widget.ts:2', '2 >= 3', '2 > 3', '--', t2])
  expect(r2.code).toBe(0)
  expect(readFileSync(file).equals(bytes)).toBe(true)
  expect(statSync(file).mode).toBe(mode)
  expect(readFileSync(join(d, 'seen.txt')).toString()).toBe(
    'é = 1\r\nreturn x >= 2 > 3\r\nlast >= 9'.replace('2 > 3', '2 > 3'),
  )
})

test('a pipe in old or new is escaped in the row', () => {
  const { d } = repo('a || b\n')
  const r = run(d, ['src/widget.ts:1', '||', '&&', '--', 'true'])
  expect(r.out).toContain('\\|\\| -> &&')
})

test('refusals exit 2, never spawn the test, and leave the file alone', () => {
  const { d, file } = repo('x >= 1\ny\nx >= 3 >= 4\n')
  const outside = tmp()
  writeFileSync(join(outside, 'o.ts'), 'x >= 1\n')
  symlinkSync(join(outside, 'o.ts'), join(d, 'link.ts'))
  git(d, 'add', 'link.ts')
  git(d, 'commit', '-q', '-m', 'link')
  writeFileSync(join(d, 'untracked.ts'), 'x >= 1\n')
  writeFileSync(join(d, 'bad.ts'), Buffer.from([0x78, 0xff, 0xfe, 0x0a]))
  git(d, 'add', 'bad.ts')
  git(d, 'commit', '-q', '-m', 'bad')
  const marker = join(d, 'MARK')
  const t = script(tmp(), 'mark.sh', `touch "${marker}"`)
  const before = readFileSync(file)
  const mtime = statSync(file).mtimeMs
  const W = 'src/widget.ts'
  const rows: [string, string[]][] = [
    ['no --', [`${W}:1`, '>=', '>']],
    ['empty argv', [`${W}:1`, '>=', '>', '--']],
    ['unknown flag', ['--foo', `${W}:1`, '>=', '>', '--', t]],
    ['short flag', ['-t', `${W}:1`, '>=', '>', '--', t]],
    ['timeout 0', ['--timeout', '0', `${W}:1`, '>=', '>', '--', t]],
    ['timeout abc', ['--timeout', 'abc', `${W}:1`, '>=', '>', '--', t]],
    ['timeout 1.5', ['--timeout', '1.5', `${W}:1`, '>=', '>', '--', t]],
    ['timeout 3601', ['--timeout', '3601', `${W}:1`, '>=', '>', '--', t]],
    ['line 0', [`${W}:0`, '>=', '>', '--', t]],
    ['line past EOF', [`${W}:9`, '>=', '>', '--', t]],
    ['empty old', [`${W}:1`, '', '>', '--', t]],
    ['old == new', [`${W}:1`, '>=', '>=', '--', t]],
    ['old not found', [`${W}:2`, '>=', '>', '--', t]],
    ['old twice in line', [`${W}:3`, '>=', '>', '--', t]],
    ['old twice in file, no line', [W, 'x >=', 'x >', '--', t]],
    ['missing path', ['src/none.ts:1', 'a', 'b', '--', t]],
    ['directory', ['src:1', 'a', 'b', '--', t]],
    ['outside toplevel', [`../${outside.split('/').pop()}/o.ts:1`, '>=', '>', '--', t]],
    ['symlink out', ['link.ts:1', '>=', '>', '--', t]],
    ['untracked', ['untracked.ts:1', '>=', '>', '--', t]],
    ['under .git', ['.git/HEAD:1', 'ref', 'x', '--', t]],
    ['non-UTF-8', ['bad.ts:1', 'x', 'y', '--', t]],
    ['old/new equal after one-arg form', [`${W}:1`, '>=>', '--', t]],
  ]
  for (const [name, args] of rows) {
    const r = run(d, args)
    expect(`${name}: ${r.code}`).toBe(`${name}: 2`)
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(statSync(file).mtimeMs).toBe(mtime)
  }
  // dirty files: unstaged and staged
  writeFileSync(file, before.toString() + 'z\n')
  expect(run(d, [`${W}:2`, 'y', 'w', '--', t]).code).toBe(2)
  git(d, 'add', W)
  expect(run(d, [`${W}:2`, 'y', 'w', '--', t]).code).toBe(2)
  expect(existsSync(marker)).toBe(false)
  // not a git repo
  const plain = tmp()
  writeFileSync(join(plain, 'a.ts'), 'a\n')
  expect(run(plain, ['a.ts:1', 'a', 'b', '--', t]).code).toBe(2)
  expect(existsSync(marker)).toBe(false)
})

test('a baseline that fails exits 2 after one test run and leaves the file alone', () => {
  const { d, file } = repo()
  const before = readFileSync(file)
  const marker = join(d, 'RUNS')
  const t = script(tmp(), 'count.sh', `echo x >> "${marker}"; exit 1`)
  const r = run(d, ['src/widget.ts:2', '>=', '>', '--', t])
  expect(r.code).toBe(2)
  expect(r.err).toContain('baseline')
  expect(readFileSync(marker, 'utf8')).toBe('x\n')
  expect(readFileSync(file).equals(before)).toBe(true)
})

test('restore failure exits 4 and names git checkout', () => {
  if (process.getuid?.() === 0) return
  const { d, file } = repo()
  const t = script(
    tmp(),
    'chmod.sh',
    `if grep -q '> 2' "${join(d, 'src/widget.ts')}"; then chmod 444 "${file}"; fi`,
  )
  const r = run(d, ['src/widget.ts:2', '>= 2', '> 2', '--', t])
  chmodSync(file, 0o644)
  expect(r.code).toBe(4)
  expect(r.err).toContain('git checkout -- src/widget.ts')
})

test('bare mutate prints usage on stderr and exits 2', () => {
  const r = run(tmp(), [])
  expect(r.code).toBe(2)
  expect(r.err).toContain('usage: factory mutate')
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
// A killed process stays visible as a zombie until init reaps it, so poll for a moment.
const dead = async (pid: number) => {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true
    await Bun.sleep(100)
  }
  return false
}

// The test script sleeps only on the mutant. It writes its sleep grandchild pid and a started marker.
function sleeper(d: string) {
  const pidf = join(d, 'SLEEPPID')
  const started = join(d, 'STARTED')
  const t = script(
    tmp(),
    'sleep.sh',
    `if grep -q '> 2' "${join(d, 'src/widget.ts')}"; then sleep 30 & echo $! > "${pidf}"; touch "${started}"; wait; fi`,
  )
  return { t, pidf, started }
}

test('timeout: exit 3, row TIMEOUT, bytes restored, the sleep grandchild is dead, under 10 s', async () => {
  const { d, file } = repo()
  const before = readFileSync(file)
  const { t, pidf } = sleeper(d)
  const t0 = Date.now()
  const r = run(d, ['--timeout', '1', 'src/widget.ts:2', '>= 2', '> 2', '--', t])
  expect(Date.now() - t0).toBeLessThan(10000)
  expect(r.code).toBe(3)
  expect(r.out).toMatch(/timeout 1s \| TIMEOUT \|\n$/)
  expect(readFileSync(file).equals(before)).toBe(true)
  expect(await dead(Number(readFileSync(pidf, 'utf8')))).toBe(true)
})

for (const [sig, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const) {
  test(`${sig}: exit ${code}, bytes restored, the process group is dead`, async () => {
    const { d, file } = repo()
    const before = readFileSync(file)
    const { t, pidf, started } = sleeper(d)
    const home = tmp()
    const e: Record<string, string | undefined> = {
      ...process.env,
      FACTORY_SELF_UPDATE: '0',
      FACTORY_HOME: home,
    }
    for (const k of ['FACTORY_OUTBOX', 'FACTORY_FROM', 'FACTORY_RUN']) delete e[k]
    const p = Bun.spawn([BIN, 'mutate', 'src/widget.ts:2', '>= 2', '> 2', '--', t], {
      cwd: d,
      env: e as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    for (let i = 0; i < 300 && !existsSync(started); i++) await Bun.sleep(100)
    expect(existsSync(started)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('> 2')
    p.kill(sig)
    expect(await p.exited).toBe(code)
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(await dead(Number(readFileSync(pidf, 'utf8')))).toBe(true)
  })
}
