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
