import { randomUUID } from 'node:crypto'
import type { PatrolIdentity } from './patrol-api'

type Operation = 'acquire' | 'renew' | 'complete'
type Result = { status: number; body: Record<string, unknown> }
type Lease = { owner: string; generation: string; expiresAt: number; terminal: boolean; keys: Set<string> }
type Replay = { owner: string; generation: string; operation: Operation; body: string; result: Result }
const binding = (who: PatrolIdentity) =>
  JSON.stringify([who.id, who.digest, who.audience, who.notBefore, who.expiresAt, [...who.rigs].sort()])

export class PatrolLease {
  readonly epoch = randomUUID()
  private current: Lease | undefined
  private readonly replays = new Map<string, Replay>()
  private lastTime: number | undefined
  private readonly now: () => number

  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now
  }

  lookup(key: string) {
    return this.replays.get(key)
  }

  mutate(
    who: PatrolIdentity,
    operation: Operation,
    body: Record<string, unknown>,
    key: string,
    records: PatrolIdentity[],
  ): Result {
    const refuse = (status = 409): Result => ({
      status,
      body: { error: status === 503 ? 'unavailable' : 'conflict' },
    })
    const now = this.now()
    const owner = binding(who)
    const valid = (r: PatrolIdentity) => r.notBefore <= now && now < r.expiresAt
    if (
      body.epoch !== this.epoch ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !valid(who) ||
      !records.some(r => valid(r) && binding(r) === owner)
    )
      return refuse()
    if (now > Number.MAX_SAFE_INTEGER - 60_000) return refuse(503)
    const backwards = this.lastTime !== undefined && now < this.lastTime
    this.lastTime = now
    if (
      this.current &&
      (backwards ||
        now >= this.current.expiresAt ||
        !records.some(r => valid(r) && binding(r) === this.current!.owner))
    )
      this.current = undefined
    const current = this.current
    const prior = this.replays.has(key)
    if (operation === 'acquire') {
      if (
        (current && !current.terminal && (current.owner !== owner || !current.keys.has(key))) ||
        (current?.terminal && prior) ||
        (!current && prior)
      )
        return refuse()
    } else {
      if (
        !current ||
        current.owner !== owner ||
        body.generation !== current.generation ||
        (prior && !current.keys.has(key)) ||
        (current.terminal && (operation !== 'complete' || !prior))
      )
        return refuse()
    }
    const replay = this.lookup(key)
    if (replay) {
      if (
        replay.owner !== owner ||
        replay.generation !== current?.generation ||
        replay.operation !== operation ||
        replay.body !== JSON.stringify(body)
      )
        return refuse()
      return structuredClone(replay.result)
    }
    if (this.replays.size >= 4096) return refuse(503)
    let result: Result
    if (operation === 'acquire') {
      this.current = {
        owner,
        generation: randomUUID(),
        expiresAt: now + 60_000,
        terminal: false,
        keys: new Set(),
      }
      result = {
        status: 200,
        body: { epoch: this.epoch, generation: this.current.generation, expiresAt: this.current.expiresAt },
      }
    } else if (operation === 'renew') {
      current!.expiresAt = now + 60_000
      result = {
        status: 200,
        body: { epoch: this.epoch, generation: current!.generation, expiresAt: current!.expiresAt },
      }
    } else {
      current!.terminal = true
      result = { status: 200, body: { completed: true } }
    }
    this.current!.keys.add(key)
    this.replays.set(key, {
      owner,
      generation: this.current!.generation,
      operation,
      body: JSON.stringify(body),
      result: structuredClone(result),
    })
    return result
  }
}
