// The event log of the local core (claude-factory-hpmc.4, spec 006 control-api GET /v1/events).
// An event holds no data: it tells a front end to read a resource again.
import { randomBytes } from 'node:crypto'

export type CoreEvent = { seq: number; resource: string; revision: number }

const CURSOR = /^([0-9a-f]{8})-(\d{1,15})$/

/**
 * ponytail: the log lives in memory. A restart makes a new epoch, so an old cursor gets 409 and the front end reads a snapshot.
 * Upgrade path: the 006 durable event table.
 */
export function eventLog(cap = 1000) {
  const epoch = randomBytes(4).toString('hex')
  const kept: CoreEvent[] = []
  const rev = new Map<string, number>()
  const subs = new Set<(e: CoreEvent) => void>()
  const closers = new Set<() => void>()
  let seq = 0
  return {
    epoch,
    emit(resource: string): CoreEvent {
      const e = { seq: ++seq, resource, revision: (rev.get(resource) ?? 0) + 1 }
      rev.set(resource, e.revision)
      kept.push(e)
      if (kept.length > cap) kept.shift()
      for (const f of [...subs]) f(e)
      return e
    },
    /** the kept events after the cursor, or why the cursor is refused */
    after(cursor: string): CoreEvent[] | 'bad cursor' | 'snapshot_required' {
      const m = CURSOR.exec(cursor)
      if (!m) return 'bad cursor'
      const n = Number(m[2])
      const first = kept[0]?.seq ?? seq + 1
      if (m[1] !== epoch || n > seq || n < first - 1) return 'snapshot_required'
      return kept.filter(e => e.seq > n)
    },
    subscribe(fn: (e: CoreEvent) => void) {
      subs.add(fn)
      return () => void subs.delete(fn)
    },
    onClose(fn: () => void) {
      closers.add(fn)
      return () => void closers.delete(fn)
    },
    /** ends every open stream */
    close() {
      for (const f of [...closers]) f()
    },
  }
}
export type EventLog = ReturnType<typeof eventLog>

const refuse = (status: number, why: string) =>
  new Response(`${JSON.stringify({ refused: why })}\n`, {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** the SSE response: subscribe first, then send the kept events after the cursor, then new ones */
export function sseResponse(log: EventLog, cursor: string | undefined, hbMs = 5000): Response {
  let replay: CoreEvent[] = []
  if (cursor !== undefined) {
    const a = log.after(cursor)
    if (a === 'bad cursor') return refuse(400, 'bad cursor')
    if (a === 'snapshot_required') return refuse(409, 'snapshot_required')
    replay = a
  }
  const enc = new TextEncoder()
  let cleanup = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      let last = 0
      const send = (e: CoreEvent) => {
        if (e.seq <= last) return
        last = e.seq
        ctl.enqueue(enc.encode(`id: ${log.epoch}-${e.seq}\nevent: change\ndata: ${JSON.stringify(e)}\n\n`))
      }
      const off = log.subscribe(send)
      const hb = setInterval(() => ctl.enqueue(enc.encode(': hb\n\n')), hbMs)
      const offClose = log.onClose(() => {
        cleanup()
        try {
          ctl.close()
        } catch {}
      })
      cleanup = () => {
        off()
        offClose()
        clearInterval(hb)
      }
      for (const e of replay) send(e)
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  })
}
