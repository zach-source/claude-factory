import { SETTING_KEYS } from './settings'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>
export type TokenConfig = {
  read: string
  write: string
  liveField: string
  slotField: string
  activeField: string
}
export type Status = 'ok' | 'refused' | 'empty' | 'error'
export type Usage = { use7d?: number; use5h?: number; status: Status }
export type Slot = Usage & { n: number; hasToken: boolean; live: boolean }
export type SlotList = { live?: string; slots: Slot[] }

export const MISSING_HELP = `Set the token store with factory settings set:
  token.read          a shell command that prints the value of the field named "$1"
  token.write         a shell command that stores its stdin as the field named "$1"
  token.live-field    the field that agent-vault reads for the live token
  token.slot-field    the slot field name, with %s for the slot number (account_%s_token)
  token.active-field  the field that holds the live slot number`

export function tokenConfig(stored: Record<string, string>): TokenConfig {
  const missing = SETTING_KEYS.filter(({ key }) => key.startsWith('token.') && !stored[key]?.trim()).map(
    ({ key }) => key,
  )
  if (missing.length)
    throw new Error(`token store is not configured; missing: ${missing.join(', ')}\n${MISSING_HELP}`)
  if (stored['token.slot-field']!.split('%s').length !== 2)
    throw new Error('token.slot-field must contain %s exactly one time')
  return {
    read: stored['token.read']!,
    write: stored['token.write']!,
    liveField: stored['token.live-field']!,
    slotField: stored['token.slot-field']!,
    activeField: stored['token.active-field']!,
  }
}

export function parseUsage(h: Headers): Usage {
  const use = (period: string) => {
    const value = h.get(`anthropic-ratelimit-unified-${period}-utilization`)
    if (value === null || value.trim() === '') return undefined
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  const status = h.get('anthropic-ratelimit-unified-status')
  return {
    use7d: use('7d'),
    use5h: use('5h'),
    status:
      status === 'allowed' || status === 'allowed_warning'
        ? 'ok'
        : status === 'rejected'
          ? 'refused'
          : 'error',
  }
}

export function bestSlot(slots: readonly Slot[]): number | undefined {
  return slots
    .filter(s => s.status === 'ok')
    .sort((a, b) => (a.use7d ?? Infinity) - (b.use7d ?? Infinity) || a.n - b.n)[0]?.n
}

const READ_TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 15_000
const MAX_SLOTS = 20

function read(cfg: TokenConfig, field: string): string | null {
  const p = Bun.spawnSync(['sh', '-c', cfg.read, 'sh', field], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: READ_TIMEOUT_MS,
  })
  return p.exitCode === 0 && !p.signalCode ? p.stdout.toString().replace(/\r?\n$/, '') : null
}

function write(cfg: TokenConfig, field: string, value: string) {
  const p = Bun.spawnSync(['sh', '-c', cfg.write, 'sh', field], {
    stdin: Buffer.from(value),
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: WRITE_TIMEOUT_MS,
  })
  if (p.exitCode !== 0 || p.signalCode) {
    const why = p.exitCode === null ? `signal ${p.signalCode}` : `exit ${p.exitCode}`
    throw new Error(`token.write failed for field ${field} (${why})`)
  }
}

const slotField = (cfg: TokenConfig, n: number) => cfg.slotField.replace('%s', String(n))

function scan(cfg: TokenConfig): { n: number; token: string }[] {
  const slots: { n: number; token: string }[] = []
  // ponytail: a gap hides later slots. Upgrade path: a token.slots count setting.
  for (let n = 1; n <= MAX_SLOTS; n++) {
    const token = read(cfg, slotField(cfg, n))
    if (!token) break
    slots.push({ n, token })
  }
  if (!slots.length)
    throw new Error(
      `cannot read slot 1 (field ${slotField(cfg, 1)}): the store is locked, needs a sign-in, or has no slot 1`,
    )
  return slots
}

export async function probe(token: string, fetchFn: Fetch = fetch): Promise<Usage> {
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const usage = parseUsage(res.headers)
    await res.body?.cancel()
    return usage
  } catch {
    return { status: 'error' }
  }
}

const probeSlots = (slots: { n: number; token: string }[], fetchFn?: Fetch, live?: string): Promise<Slot[]> =>
  Promise.all(
    slots.map(async ({ n, token }) => ({
      n,
      hasToken: true,
      ...(await probe(token, fetchFn)),
      live: String(n) === live,
    })),
  )

export async function listSlots(cfg: TokenConfig, fetchFn?: Fetch): Promise<SlotList> {
  const slots = scan(cfg)
  const active = read(cfg, cfg.activeField)?.trim()
  const live = active !== undefined && /^[0-9]{1,3}$/.test(active) ? active : undefined
  return { live, slots: await probeSlots(slots, fetchFn, live) }
}

function makeLive(cfg: TokenConfig, n: number, token: string): string {
  // ponytail: the two writes are not atomic. Upgrade path: one command that takes both fields.
  write(cfg, cfg.liveField, token)
  try {
    write(cfg, cfg.activeField, String(n))
  } catch (e) {
    throw new Error(`slot ${n} token is live, but ${(e as Error).message}`)
  }
  return `slot ${n} is live; agent-vault picks it up within 5 minutes`
}

export function useSlot(cfg: TokenConfig, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > 999) throw new Error('slot must be a number from 1 to 999')
  const field = slotField(cfg, n)
  const token = read(cfg, field)
  if (token === null)
    throw new Error(`cannot read slot ${n} (field ${field}): it is empty or missing, or the store is locked`)
  if (token === '') throw new Error(`no token in slot ${n}`)
  return makeLive(cfg, n, token)
}

export async function bestUse(cfg: TokenConfig, fetchFn?: Fetch): Promise<string> {
  const slots = scan(cfg)
  const n = bestSlot(await probeSlots(slots, fetchFn))
  if (n === undefined)
    throw new Error(
      'no slot is allowed (every slot is refused or failed its probe); the live slot did not change',
    )
  return makeLive(cfg, n, slots.find(s => s.n === n)!.token)
}

export function slotRows(r: SlotList): string[] {
  const row = (n: string, d: string, h: string, status: string) =>
    `${n.padEnd(5)} ${d.padEnd(8)} ${h.padEnd(8)} ${status}`
  return [
    `live: slot ${r.live ?? '?'}`,
    row('slot', '7d', '5h', 'status'),
    ...r.slots.map(s => row(String(s.n), String(s.use7d ?? '?'), String(s.use5h ?? '?'), s.status)),
  ]
}
