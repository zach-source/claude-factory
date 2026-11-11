import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REAP_FAILED } from './reap'

const linux = process.platform === 'linux'
const reap = join(import.meta.dir, 'reap.ts')

/** a process that is gone, or a zombie */
const dead = (pid: number) => {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return s.slice(s.lastIndexOf(')') + 2)[0] === 'Z'
  } catch {
    return true
  }
}

const run = async (script: string) => {
  const p = Bun.spawn([process.execPath, reap, 'sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out, err, code }
}

const kids = (d: string) => `
sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${d}/pid.1
nohup sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${d}/pid.2
setsid sh -c 'echo $$ > ${d}/pid.3; exec sleep 300' </dev/null >/dev/null 2>&1 &
sleep 0.3
`

test('REAP_FAILED is 125 and the import starts nothing', () => {
  expect(REAP_FAILED).toBe(125)
})

test.skipIf(!linux)(
  'the reaper kills each process the command left, in any session, and passes the exit code',
  async () => {
    const d = mkdtempSync(join(tmpdir(), 'reap-'))
    const outside = Bun.spawn(['sleep', '300'])
    try {
      const r = await run(`${kids(d)}\nexit 3`)
      expect(r.code).toBe(3)
      for (const n of [1, 2, 3]) {
        const f = join(d, `pid.${n}`)
        expect(existsSync(f)).toBe(true)
        expect(dead(Number(readFileSync(f, 'utf8')))).toBe(true)
      }
      expect(dead(outside.pid)).toBe(false)
    } finally {
      outside.kill('SIGKILL')
      for (const n of [1, 2, 3])
        try {
          process.kill(Number(readFileSync(join(d, `pid.${n}`), 'utf8')), 'SIGKILL')
        } catch {}
      rmSync(d, { recursive: true, force: true })
    }
  },
)

test.skipIf(!linux)('the reaper runs a command with no children and passes stdio through', async () => {
  expect(await run('exit 0')).toEqual({ out: '', err: '', code: 0 })
  expect((await run('printf hi')).out).toBe('hi')
})

const ORPHANS = 1500
const MAX_ZOMBIES = 600

/** the number of zombie children of ppid; counts only, never a process list */
const zombieCount = (ppid: number) => {
  let n = 0
  for (const e of readdirSync('/proc'))
    if (/^\d+$/.test(e))
      try {
        const s = readFileSync(`/proc/${e}/stat`, 'utf8')
        const [state, pp] = s.slice(s.lastIndexOf(')') + 2).split(' ')
        if (state === 'Z' && pp === String(ppid)) n++
      } catch {}
  return n
}

test.skipIf(!linux)(
  'dead adopted children are waited for while the main command lives',
  async () => {
    const script = `for i in $(seq ${ORPHANS / 100}); do for j in $(seq 100); do (true &); done; sleep 0.3; done; sleep 1; exit 5`
    const p = Bun.spawn([process.execPath, reap, 'sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' })
    let ended = false
    let max = 0
    let alive = 0
    const t = setInterval(() => {
      const n = zombieCount(p.pid)
      if (ended) return
      alive++
      max = Math.max(max, n)
    }, 50)
    void p.exited.then(() => (ended = true))
    try {
      const code = await p.exited
      clearInterval(t)
      console.log(`zombie max ${max}, alive samples ${alive}`)
      expect({ ok: max <= MAX_ZOMBIES && alive >= 10, code, max, alive }).toEqual({
        ok: true,
        code: 5,
        max,
        alive,
      })
    } finally {
      clearInterval(t)
      p.kill('SIGKILL')
    }
  },
  60_000,
)
