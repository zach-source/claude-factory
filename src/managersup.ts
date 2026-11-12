import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** the ax calls the pod supervisor makes; a test gives a fake (contracts/manager-task.md) */
export type TaskAx = {
  /** the task phase, null when there is no task */
  phase: () => string | null
  /** apply the session task from `image` */
  apply: (image: string) => Promise<unknown>
  /** delete the task; with `workspace`, its workspace too. Returns the failure text, if any */
  remove: (workspace: boolean) => string | undefined
  suspend: () => unknown
  resume: () => unknown
}

type Saved = { image?: string; suspended?: boolean }

/** 1, 2, 4 then 10 minutes between two applies that do not reach Running */
export const BACKOFF_MS = [60_000, 120_000, 240_000, 600_000]
/** the checks a task must be down before the pod replaces it */
export const DOWN_CHECKS = 3

/**
 * The pod's supervisor of the manager task. `check` runs on a timer; `setImage` and `suspend` are the person's
 * calls. The image and the suspend flag live in `<home>/manager-task.json`, so a pod restart keeps them.
 * Every ax step yields to the event loop first, so a tick runs between them (FR-009).
 */
export function supervisor(o: {
  home: string
  ax: TaskAx
  image?: string
  now?: () => number
  log?: (m: string) => void
}) {
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const file = join(o.home, 'manager-task.json')
  const yieldLoop = () => Bun.sleep(1)
  let saved: Saved = {}
  try {
    saved = JSON.parse(readFileSync(file, 'utf8')) as Saved
  } catch {}
  if (!saved.image && o.image) saved.image = o.image
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(saved))
    renameSync(`${file}.tmp`, file)
  }
  let down = 0
  let fails = 0
  let nextAt = 0
  const start = async () => {
    await yieldLoop()
    await o.ax.apply(saved.image!)
    nextAt = now() + BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)]!
    fails++
    // a task that is still bad after the back-off is replaced at once, not after 3 more checks
    down = DOWN_CHECKS
  }
  return {
    state: () => ({ ...saved, down, fails, nextAt }),
    /** one health check: returns what it saw or did */
    async check(): Promise<string> {
      if (saved.suspended) return 'suspended'
      if (!saved.image) return 'no image'
      try {
        const phase = o.ax.phase()
        if (phase === 'Running') {
          down = fails = nextAt = 0
          return 'running'
        }
        if (phase === 'Pending' || phase === 'Terminating') return phase.toLowerCase()
        if (now() < nextAt) return 'backoff'
        if (phase === null) {
          log('manager task: none, applying')
          await start()
          return 'created'
        }
        if (++down < DOWN_CHECKS) return 'down'
        log(`manager task: ${phase} for ${DOWN_CHECKS} checks, replacing`)
        await yieldLoop()
        const bad = o.ax.remove(false)
        if (bad) throw new Error(bad)
        await start()
        return 'replaced'
      } catch (e) {
        nextAt = now() + BACKOFF_MS[Math.min(fails++, BACKOFF_MS.length - 1)]!
        log(`manager task: ${(e as Error).message.split('\n')[0]!.slice(0, 200)}`)
        return 'error'
      }
    },
    /** a new image: delete the task and its workspace, then apply. Throws the failure text */
    async setImage(image: string) {
      if (!image.trim()) throw new Error('the image is empty')
      saved = { image, suspended: false }
      save()
      await yieldLoop()
      const bad = o.ax.remove(true)
      if (bad) throw new Error(bad)
      fails = 0
      await start()
    },
    async suspend(on: boolean) {
      await yieldLoop()
      if (on) o.ax.suspend()
      else o.ax.resume()
      saved.suspended = on
      save()
    },
  }
}
