// Command records of the local core (claude-factory-hpmc.4, spec 006 GET /v1/commands/:id).
import { randomUUID } from 'node:crypto'

export type Command = {
  id: string
  op: string
  actor: 'person'
  status: 'accepted' | 'running' | 'done' | 'failed'
  createdAt: string
  doneAt?: string
  result?: { status: number; body: string }
}

const BODY_MAX = 65536
const ID = /^[0-9a-f-]{36}$/

/**
 * Keeps up to `cap` records in memory. A new record removes the oldest finished one.
 * ponytail: no durable store. After a restart an old id gives 404. Upgrade path: the 006 command table.
 */
export function commandStore(onChange: (id: string) => void, cap = 500) {
  const rows = new Map<string, Command>()
  const json = (status: number, v: unknown) =>
    new Response(`${JSON.stringify(v)}\n`, { status, headers: { 'content-type': 'application/json' } })
  return {
    get: (id: string): Command | undefined => (ID.test(id) ? rows.get(id) : undefined),
    /** record the command, start `run` at once and answer 202 with the id */
    start(opName: string, run: () => Promise<Response>): Response {
      if (rows.size >= cap) {
        const old = [...rows.values()].find(c => c.status === 'done' || c.status === 'failed')
        if (!old) return json(503, { refused: 'too many running commands' })
        rows.delete(old.id)
      }
      const c: Command = {
        id: randomUUID(),
        op: opName,
        actor: 'person',
        status: 'accepted',
        createdAt: new Date().toISOString(),
      }
      rows.set(c.id, c)
      onChange(c.id)
      const end = (status: number, body: string) => {
        c.status = status < 400 ? 'done' : 'failed'
        c.doneAt = new Date().toISOString()
        c.result = { status, body: body.slice(0, BODY_MAX) }
        onChange(c.id)
      }
      c.status = 'running'
      onChange(c.id)
      void (async () => {
        try {
          const res = await run()
          end(res.status, await res.text())
        } catch {
          end(500, '')
        }
      })()
      return json(202, { commandId: c.id, status: 'accepted' })
    },
  }
}
