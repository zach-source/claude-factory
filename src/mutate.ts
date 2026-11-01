import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileWriteReason } from './worker-hook'

const USAGE =
  'usage: factory mutate [--timeout <s>] <path>[:<line>] <old> <new> -- <test argv...>\n' +
  '  applies one literal edit, runs the test argv, restores the file, prints one row.\n' +
  '  exit 0 killed, 1 survived, 2 refused, 3 timeout, 4 restore failed, 129/130/143 signal'

class Refuse extends Error {}
const refuse = (m: string): never => {
  throw new Refuse(m)
}

type Run = { code: number | null; timedOut: boolean; tail: string }

// ponytail: no --no-baseline flag; add one when the baseline run costs too much time.
function runTest(
  argv: string[],
  cwd: string,
  seconds: number,
  onChild: (pid: number | undefined) => void,
): Promise<Run> {
  return new Promise(done => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    onChild(child.pid)
    let out = ''
    let timedOut = false
    const keep = (b: Buffer) => (out = (out + b.toString()).slice(-20000))
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, seconds * 1000)
    const end = (code: number | null) => {
      clearTimeout(timer)
      killGroup()
      onChild(undefined)
      done({ code, timedOut, tail: out.split('\n').slice(-21).join('\n').trim() })
    }
    child.on('error', e => {
      out += String(e)
      end(127)
    })
    child.on('close', end)
  })
}

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' })

type Plan = {
  abs: string
  rel: string
  line: number
  original: Buffer
  mutant: Buffer
  old: string
  neu: string
}

function parse(args: string[], cwd: string): Plan & { seconds: number; argv: string[] } {
  let seconds = 200
  let a = [...args]
  if (a[0] === '--timeout') {
    if (!/^[1-9]\d{0,3}$/.test(a[1] ?? '') || Number(a[1]) > 3600)
      refuse('--timeout takes an integer 1..3600')
    seconds = Number(a[1])
    a = a.slice(2)
  }
  if (a[0]?.startsWith('-')) refuse(`unknown flag ${a[0]}`)
  const [spec, old, neu, dd, ...argv] = a
  if (spec === undefined || old === undefined || neu === undefined) refuse('need <path>[:<line>] <old> <new>')
  if (dd !== '--' || !argv.length) refuse('need -- and a test argv after <new>')
  if (!old) refuse('<old> is empty')
  if (old === neu) refuse('<old> and <new> are the same')
  const m = /^(.*):(\d+)$/.exec(spec!)
  const path = m ? m[1]! : spec!
  const line = m ? Number(m[2]) : 0
  if (m && line < 1) refuse('<line> is 1-based')

  const top = git(cwd, 'rev-parse', '--show-toplevel')
  if (top.status !== 0) refuse('not in a git repository')
  const root = realpathSync(top.stdout.trim())
  let real: string
  try {
    real = realpathSync(resolve(cwd, path))
  } catch {
    return refuse(`no such file: ${path}`)
  }
  if (!real.startsWith(root + sep)) refuse('path is outside the repository')
  const rel = relative(root, real)
  if (rel === '.git' || rel.startsWith('.git' + sep)) refuse('path is under .git')
  if (!statSync(real).isFile()) refuse('path is not a regular file')
  if (git(root, 'ls-files', '--error-unmatch', '--', rel).status !== 0) refuse('file is not tracked')
  if (git(root, 'diff', '--quiet', 'HEAD', '--', rel).status !== 0)
    refuse('file has changes: commit or restore them first')
  const denied = fileWriteReason(real, cwd)
  if (denied) refuse(denied)

  const original = readFileSync(real)
  const text = original.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(original)) refuse('file is not valid UTF-8')
  let start = 0
  let end = text.length
  if (line) {
    const lines = text.split('\n')
    if (line > lines.length) refuse(`file has ${lines.length} lines`)
    start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    end = start + lines[line - 1]!.length
    if (text[end - 1] === '\r') end--
  }
  const scope = text.slice(start, end)
  const at = scope.indexOf(old)
  if (at < 0) refuse('<old> not found')
  if (scope.indexOf(old, at + 1) >= 0)
    refuse(`<old> occurs more than once${line ? ' in that line' : ': give :<line>'}`)
  const at0 = start + at
  const mutant = Buffer.from(text.slice(0, at0) + neu + text.slice(at0 + old.length), 'utf8')
  const lineNo = line || text.slice(0, at0).split('\n').length
  return { abs: real, rel, line: lineNo, original, mutant, old, neu, seconds, argv }
}

/** Runs `factory mutate`. Returns the exit code. The file is back to its original bytes on every path out. */
export async function mutate(args: string[], cwd = process.cwd()): Promise<number> {
  if (!args.length) {
    console.error(USAGE)
    return 2
  }
  let p: ReturnType<typeof parse>
  try {
    p = parse(args, cwd)
  } catch (e) {
    if (!(e instanceof Refuse)) throw e
    console.error(`refused: ${e.message}\n${USAGE}`)
    return 2
  }
  const base = await runTest(p.argv, cwd, p.seconds, () => {})
  if (base.code !== 0) {
    console.error(
      `refused: baseline fails on the clean file (${base.timedOut ? 'timeout' : `exit ${base.code}`})\n${base.tail}`,
    )
    return 2
  }

  let child: number | undefined
  let restored = false
  const restore = () => {
    if (restored) return true
    try {
      writeFileSync(p.abs, p.original)
      restored = readFileSync(p.abs).equals(p.original)
    } catch {}
    return restored
  }
  const killChild = () => {
    try {
      if (child) process.kill(-child, 'SIGKILL')
    } catch {}
  }
  const onSignal = (code: number) => () => {
    killChild()
    if (!restore()) console.error(`restore failed: run git checkout -- ${p.rel}`)
    process.exit(restore() ? code : 4)
  }
  const sigs: [NodeJS.Signals, number][] = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]
  for (const [s, c] of sigs) process.on(s, onSignal(c))

  let r: Run
  try {
    writeFileSync(p.abs, p.mutant)
    r = await runTest(p.argv, cwd, p.seconds, pid => (child = pid))
  } finally {
    killChild()
    restore()
  }
  if (!restored) {
    console.error(`restore failed: run git checkout -- ${p.rel}`)
    return 4
  }
  const cell = (s: string) => s.replace(/\|/g, '\\|')
  const result = r.timedOut ? `timeout ${p.seconds}s` : `test exit ${r.code}`
  const verdict = r.timedOut ? 'TIMEOUT' : r.code === 0 ? 'SURVIVED' : 'KILLED'
  console.log(`| ${p.rel}:${p.line} | ${cell(p.old)} -> ${cell(p.neu)} | ${result} | ${verdict} |`)
  if (r.tail) console.error(r.tail.split('\n').slice(-20).join('\n'))
  return r.timedOut ? 3 : r.code === 0 ? 1 : 0
}
