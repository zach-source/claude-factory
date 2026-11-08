// The weekly Cursor pool is shared with other users of the same plan. The manager reads its percent from Cursor's dashboard API
// at most every 5 minutes, caches it in <home>/cursor-meter.json, and a launch gate keeps the factory under a cap.
// These are private Cursor APIs: on any failure the last good reading stays for 1 hour, then the meter is unknown.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** `pct` is a percent (0.0758 is 0.08 %). `resetsAt` is the end of the billing cycle in ms. `at` is when it was read. */
export type Meter = { pct: number; resetsAt: number; at: number }
type Cache = { tried: number; reading?: Meter }

export const METER_EVERY_MS = 5 * 60_000
export const METER_KEEP_MS = 3_600_000
export const DEFAULT_CAP = 60
const API = 'https://api2.cursor.sh'

const file = (home: string) => join(home, 'cursor-meter.json')
const num = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN)

function readCache(home: string): Cache {
  try {
    const c = JSON.parse(readFileSync(file(home), 'utf8')) as Cache
    const r = c.reading
    const ok = r && [r.pct, r.resetsAt, r.at].every(Number.isFinite) && r.pct >= 0
    return { tried: Number.isFinite(c.tried) ? c.tried : 0, ...(ok && { reading: r }) }
  } catch {
    return { tried: 0 }
  }
}

function writeCache(home: string, c: Cache) {
  const tmp = `${file(home)}.${process.pid}.tmp`
  mkdirSync(home, { recursive: true })
  writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 })
  renameSync(tmp, file(home))
}

/** the cached reading when it is under an hour old; undefined (unknown) otherwise. No network. */
export const cursorMeter = (home: string, now = Date.now()) => {
  const r = readCache(home).reading
  return r && now - r.at <= METER_KEEP_MS ? r : undefined
}

/** `GetCurrentPeriodUsage`'s body as a Meter, or undefined when it lacks the percent or the cycle end */
export function parseUsage(body: unknown, at: number): Meter | undefined {
  const o = body as { billingCycleEnd?: unknown; planUsage?: { totalPercentUsed?: unknown } } | null
  const pct = num(o?.planUsage?.totalPercentUsed)
  const resetsAt = num(o?.billingCycleEnd)
  return pct >= 0 && Number.isFinite(pct) && Number.isFinite(resetsAt) ? { pct, resetsAt, at } : undefined
}

/** the cap in percent from FACTORY_CURSOR_CAP (setting cursor.cap); 60 for a missing or bad value */
export function cursorCap(env: Record<string, string | undefined> = process.env) {
  const n = num(env.FACTORY_CURSOR_CAP?.trim() || DEFAULT_CAP)
  return n >= 0 && n <= 100 ? n : DEFAULT_CAP
}

/** may a launch use cursor? Only with a known meter under the cap. `why` is the one line the log shows. */
export function cursorVerdict(meter: Meter | undefined, cap: number) {
  if (!meter) return { use: false, why: `the Cursor pool meter is unknown (cap ${cap}%)` }
  const use = meter.pct < cap
  return { use, why: `the Cursor pool is at ${show(meter.pct)}% (cap ${cap}%)` }
}

const show = (pct: number) => Number(pct.toFixed(2))

/** the line `factory status` and `factory metrics` print */
export const cursorLine = (meter: Meter | undefined, cap: number) =>
  meter
    ? `Cursor: ${show(meter.pct)}% of the weekly pool used (cap ${cap}%), resets ${new Date(meter.resetsAt).toLocaleString()}`
    : `Cursor: the weekly pool meter is unknown (cap ${cap}%): cursor launches use the station's other agent`

type Post = (url: string, headers: Record<string, string>) => Promise<unknown>
const postJson: Post = async (url, headers) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{}',
    signal: AbortSignal.timeout(8_000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// the access token lives in this process only; it is never logged or written
let accessToken: string | undefined

async function usageBody(key: string, post: Post) {
  const usage = () =>
    post(`${API}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
      'Connect-Protocol-Version': '1',
      Authorization: `Bearer ${accessToken}`,
    })
  if (accessToken) {
    try {
      return await usage()
    } catch {
      accessToken = undefined // expired: exchange the key again once
    }
  }
  const t = (await post(`${API}/auth/exchange_user_api_key`, { Authorization: `Bearer ${key}` })) as {
    accessToken?: unknown
  }
  if (typeof t?.accessToken !== 'string' || !t.accessToken) throw new Error('no access token')
  accessToken = t.accessToken
  return usage()
}

/**
 * Reads the meter when the cache is 5 minutes old or more and CURSOR_API_KEY is set; with no key there is no meter. The attempt time
 * is stored before the call, so a slow or failing API is tried at most every 5 minutes. A failure keeps the last good reading.
 */
export async function refreshCursorMeter(
  home: string,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
  post: Post = postJson,
) {
  const key = env.CURSOR_API_KEY
  const cache = readCache(home)
  if (!key || now - cache.tried < METER_EVERY_MS) return
  try {
    writeCache(home, { ...cache, tried: now })
    const reading = parseUsage(await usageBody(key, post), now)
    if (reading) writeCache(home, { tried: now, reading })
  } catch {
    // the last good reading stays (cursorMeter ignores one over an hour old); the message could name nothing secret, but nothing needs it
  }
}
