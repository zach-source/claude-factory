// `factory server`: one long-lived process that ticks, holds the writer lease and answers /healthz
// (claude-factory-akiq.1, spec 004-factory-server FR-001, FR-007).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export type Lease = { holder: string; until: number }

export const leaseFile = (home: string) => join(home, 'server-lease.json')

function read(file: string): Lease | null | 'bad' {
  if (!existsSync(file)) return null
  try {
    const l = JSON.parse(readFileSync(file, 'utf8'))
    return typeof l?.holder === 'string' && Number.isFinite(l.until) ? l : 'bad'
  } catch {
    return 'bad'
  }
}

const other = (file: string): Lease | null => {
  const l = read(file)
  return l === 'bad' ? null : l
}

/**
 * Take, renew or refuse the lease. Return the lease in the file and whether `holder` owns it.
 * Take a lease that is missing or expired (until <= now). A corrupt file counts as live until its
 * mtime is older than ttlMs, so the check fails closed.
 * ponytail: two takers of one expired lease can both write. The last rename wins. The other taker
 * steps down at its next claim. A holder whose event loop blocks past ttlMs loses the lease, and its running tick still finishes and writes. Upgrade path: a Dolt `lease` row with compare-and-set (spec step S6).
 */
export function claim(
  file: string,
  holder: string,
  now: number,
  ttlMs: number,
): { held: boolean; lease: Lease | null } {
  const cur = read(file)
  if (cur === 'bad') {
    let age = 0
    try {
      age = now - statSync(file).mtimeMs
    } catch {}
    if (age <= ttlMs) return { held: false, lease: null }
  } else if (cur && cur.holder !== holder && cur.until > now) return { held: false, lease: cur }
  const mine: Lease = { holder, until: now + ttlMs }
  const tmp = `${file}.${holder.replace(/\W/g, '_')}.tmp`
  try {
    if (!cur) writeFileSync(file, JSON.stringify(mine), { flag: 'wx' })
    else {
      writeFileSync(tmp, JSON.stringify(mine))
      renameSync(tmp, file)
    }
  } catch {
    return { held: false, lease: other(file) }
  }
  const back = other(file)
  return back?.holder === holder ? { held: true, lease: mine } : { held: false, lease: back }
}

/** remove the lease only when `holder` owns it; never throws */
export function release(file: string, holder: string) {
  try {
    if (other(file)?.holder === holder) rmSync(file, { force: true })
  } catch {}
}

export const newHolder = () => `${hostname()}/${process.pid}/${randomBytes(4).toString('hex')}`

export type ServeOpts = {
  home: string
  port: number
  everyMs: number
  leaseMs: number
  tick: () => unknown
  holder?: string
  log?: (line: string) => void
}

/** Run the tick loop under the lease and answer GET /healthz. `stop()` finishes the tick that runs and releases the lease. */
export function serve(o: ServeOpts) {
  const file = leaseFile(o.home)
  const holder = o.holder ?? newHolder()
  const log = o.log ?? ((l: string) => console.log(l))
  const h = {
    lease: 'waiting',
    holder: '',
    until: 0,
    ticks: 0,
    tickOk: null as boolean | null,
    tickAt: null as string | null,
  }
  let held = false
  let stopping = false
  let running: Promise<void> = Promise.resolve()
  let seen = ''
  const take = () => {
    const c = claim(file, holder, Date.now(), o.leaseMs)
    if (c.held && !held) log(`lease taken by ${holder}`)
    if (!c.held && held) log(`lease lost to ${c.lease?.holder ?? 'unknown'}`)
    if (!c.held && c.lease) {
      if (c.lease.holder !== seen)
        log(`lease held by ${c.lease.holder} until ${new Date(c.lease.until).toISOString()}`)
      seen = c.lease.holder
    }
    held = c.held
    h.lease = held ? 'held' : 'waiting'
    h.holder = c.lease?.holder ?? ''
    h.until = c.lease?.until ?? 0
    return held
  }
  const step = async () => {
    if (!take()) return
    try {
      await o.tick()
      h.tickOk = true
    } catch (e) {
      h.tickOk = false
      log(
        `tick failed: ${String((e as Error)?.message ?? e)
          .split('\n')[0]!
          .slice(0, 300)}`,
      )
    }
    h.ticks++
    h.tickAt = new Date().toISOString()
  }
  let timer: ReturnType<typeof setTimeout>
  const next = () => {
    if (stopping) return
    running = step().finally(() => {
      if (!stopping) timer = setTimeout(next, o.everyMs)
    })
  }
  // Bun.serve first: if the port is busy it throws before any timer keeps the process alive.
  const server = Bun.serve({
    port: o.port,
    fetch(req) {
      const u = new URL(req.url)
      if (req.method === 'GET' && u.pathname === '/healthz') return Response.json(h)
      return new Response('not found\n', { status: 404 })
    },
  })
  // A long tick keeps the lease. A blocked event loop does not run this timer, so leaseMs must outlast those stretches.
  const renew = setInterval(() => held && take(), Math.max(1, Math.floor(o.leaseMs / 3)))
  timer = setTimeout(next, 0)
  return {
    port: server.port,
    holder,
    async stop() {
      stopping = true
      clearTimeout(timer)
      await running
      clearInterval(renew)
      if (held) {
        held = false
        release(file, holder)
        log('lease released')
      }
      await server.stop(true)
    },
  }
}

const USAGE = 'usage: factory server [--port 8080] [--every-ms 5000] [--lease-ms 60000]'

/** Parse the flags of `factory server`. Throw the usage text on a bad value. */
export function parseFlags(args: string[]) {
  const v = { port: 8080, everyMs: 5000, leaseMs: 60000 }
  const names: Record<string, keyof typeof v> = {
    '--port': 'port',
    '--every-ms': 'everyMs',
    '--lease-ms': 'leaseMs',
  }
  for (let i = 0; i < args.length; i += 2) {
    const k = names[args[i] ?? '']
    const raw = args[i + 1]
    if (!k || raw === undefined || !/^\d+$/.test(raw)) throw new Error(USAGE)
    v[k] = Number(raw)
  }
  if (v.everyMs <= 0 || v.leaseMs < 2 * v.everyMs || v.port > 65535) throw new Error(USAGE)
  return v
}

/** `factory server [--port 8080] [--every-ms 5000] [--lease-ms 60000]`. The caller passes the tick, so there is no import cycle with cli.ts. */
export function main(args: string[], home: string, tick: () => unknown) {
  const f = parseFlags(args)
  const s = serve({ home, ...f, tick })
  console.log(`factory server on :${s.port} as ${s.holder}`)
  const stop = () => void s.stop().then(() => process.exit(0))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
