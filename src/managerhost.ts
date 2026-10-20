import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { sq } from './harness'
import { backup, restore, type BackupCfg, type Outcome } from './homebackup'
import * as worker from './worker'

/**
 * `factory manager host`: the long-lived process of the AX manager task. It runs herdr headless, starts
 * `factory manager` in herdr's first pane, and starts both again when herdr dies. It mirrors `factory manager`
 * on the laptop, where the manager lives in a herdr pane.
 */

export type HostState = { herdrUp: boolean; panes: number }
export type HostAction = 'none' | 'start-manager' | 'restart-all'

/** what one supervision step does. Herdr down: start it and the manager. Herdr up and no pane: only the manager. */
export function decide({ herdrUp, panes }: HostState): HostAction {
  if (!herdrUp) return 'restart-all'
  return panes === 0 ? 'start-manager' : 'none'
}

/** the manager args with `--resume <session>` last; an earlier --resume or -r in them goes */
export function withResume(args: string[], session?: string) {
  if (!session) return args
  const i = args.findIndex(a => a === '--resume' || a === '-r')
  const rest = i >= 0 ? args.filter((_, j) => j !== i && j !== i + 1) : args
  return [...rest, '--resume', session]
}

/** the shell line typed into the pane */
export const managerLine = (args: string[], session?: string) =>
  ['factory', 'manager', ...withResume(args, session)]
    .map(a => (/^[\w./=:@%+-]+$/.test(a) ? a : sq(a)))
    .join(' ')

/** the newest session superviseManager wrote to manager-sessions.json */
export function lastSession(json: string): string | undefined {
  try {
    return (JSON.parse(json) as { session?: string }[]).at(-1)?.session
  } catch {
    return undefined
  }
}

/**
 * whether the host starts the manager now. The .migrated marker or FACTORY_AX_FRESH=1 (a new factory) says yes. A
 * home with rigs.json and no marker is a hand-made one: yes, unless a migration archive is on the volume, since
 * its unpack writes rigs.json before it ends. An empty home waits for `factory migrate-to-ax`
 */
export const homeReady = (f: { migrated: boolean; fresh: boolean; hasRigs: boolean; archive: boolean }) =>
  f.migrated || f.fresh || (f.hasRigs && !f.archive)

/** restore an empty home from the backup branch (192.9); logs what it did and never throws */
export function restoreStep(
  cfg: BackupCfg,
  log: (m: string) => void,
  run: (c: BackupCfg) => Outcome = restore,
) {
  if (!cfg.remote) return
  try {
    const o = run(cfg)
    if (o.restored) log(`restored ${o.restored}`)
    else if (o.error) log(`restore failed: ${o.error}`)
    else
      log(`restore: ${o.skipped}${o.skipped === 'no backup' ? '; waiting for `factory migrate-to-ax`' : ''}`)
  } catch (e) {
    log(`restore failed: ${(e as Error).message}`)
  }
}

/** one backup under the tick lock (a tick writes state files); a failure is logged and the host loop goes on */
export function backupStep(
  cfg: BackupCfg,
  ready: boolean,
  lock: () => (() => void) | null,
  log: (m: string) => void,
  run: (c: BackupCfg, ready: boolean) => Outcome = backup,
) {
  if (!cfg.remote) return
  const release = lock()
  if (!release) return log('backup skipped: a tick holds the lock')
  try {
    const o = run(cfg, ready)
    if (o.error) log(o.error.startsWith('backup refused') ? o.error : `backup failed: ${o.error}`)
    else if (o.changed) log(`backup ${o.sha}`)
  } catch (e) {
    log(`backup failed: ${(e as Error).message}`)
  } finally {
    release()
  }
}

export const HOST_PANE = () => process.env.FACTORY_AX_MANAGER_PANE ?? 'w1:p1'

// env: Bun gives a child its start env unless told, and trustCA() sets the CA vars at runtime
const herdr = (...a: string[]) =>
  Bun.spawnSync(['herdr', ...a], { env: { ...process.env }, stdin: 'ignore', timeout: 10_000 })
/** how many panes herdr lists; -1 when herdr does not answer */
function paneCount() {
  const p = herdr('pane', 'list')
  return p.exitCode === 0
    ? p.stdout
        .toString()
        .split('\n')
        .filter(l => l.trim()).length
    : -1
}

/**
 * herdr refuses to start without a terminal, so `script` gives it a pty of 200x50.
 * ponytail: the grid is fixed; a pane's Claude wraps at 200 columns whatever the viewer
 */
function startHerdr(logFile: string) {
  const fd = openSync(logFile, 'a')
  // the herdr server's panes, the manager's Claude among them, get the CA vars trustCA() set
  Bun.spawn(['setsid', 'script', '-qfc', 'stty cols 200 rows 50; exec herdr', '/dev/null'], {
    env: { ...process.env },
    stdin: 'ignore',
    stdout: fd,
    stderr: fd,
  }).unref()
}

async function waitFor(ok: () => boolean, ms: number, stepMs = 1000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(stepMs)) if (ok()) return true
  return ok()
}

function startManager(args: string[], session?: string) {
  herdr('pane', 'send-text', HOST_PANE(), managerLine(args, session))
  herdr('pane', 'send-keys', HOST_PANE(), 'Enter')
}

/** start herdr and the manager in its first pane; the manager resumes `session` when there is one */
async function bringUp(args: string[], home: string, log: (m: string) => void, session?: string) {
  startHerdr(join(home, 'herdr.log'))
  // `herdr pane list` answering is the signal that the server and its first pane exist
  if (!(await waitFor(() => paneCount() > 0, 60_000))) throw new Error('herdr did not answer in 60 s')
  startManager(args, session)
  log(`manager started in ${HOST_PANE()}${session ? ` (resume ${session})` : ''}`)
}

export async function host(
  args: string[],
  {
    everyMs = 30_000,
    prepare,
    lock = () => () => {},
  }: { everyMs?: number; prepare?: () => string[]; lock?: () => (() => void) | null } = {},
) {
  if (process.env.FACTORY_IN_AX !== '1') throw new Error('factory manager host runs only inside the AX task')
  const home = process.env.FACTORY_HOME
  if (!home) throw new Error('FACTORY_HOME is not set')
  worker.asWorker() // as the worker user, like `ax ssh` for attach and say: it re-runs this command and exits
  mkdirSync(worker.own(), { recursive: true })
  worker.trustCA()
  mkdirSync(home, { recursive: true })
  const log = (m: string) =>
    appendFileSync(join(home, 'manager-host.log'), `${new Date().toISOString()} ${m}\n`)
  const session = () => {
    const f = join(home, 'manager-sessions.json')
    return existsSync(f) ? lastSession(readFileSync(f, 'utf8')) : undefined
  }
  const ready = () =>
    homeReady({
      migrated: existsSync(join(home, '.migrated')),
      fresh: process.env.FACTORY_AX_FRESH === '1',
      hasRigs: existsSync(join(home, 'rigs.json')),
      archive:
        existsSync(join(worker.own(), 'migrate.tgz')) || existsSync(join(worker.own(), 'put', 'migrate.tgz')),
    })
  // the backup keeps FACTORY_HOME at <workspace>/home; any other home is not backed up
  const bcfg: BackupCfg = {
    ws: dirname(home),
    remote: basename(home) === 'home' ? process.env.FACTORY_AX_BACKUP_REMOTE : undefined,
    branch: process.env.FACTORY_AX_BACKUP_BRANCH || 'manager-home',
  }
  if (process.env.FACTORY_AX_BACKUP_REMOTE && !bcfg.remote)
    log('backup off: FACTORY_HOME is not <workspace>/home')
  const backupMs = Number(process.env.FACTORY_AX_BACKUP_EVERY) || 600_000
  restoreStep(bcfg, log)
  if (!ready()) log('waiting for `factory migrate-to-ax` (or FACTORY_AX_FRESH=1) before the manager starts')
  // ponytail: no timeout: an empty home waits until the laptop migrates it
  while (!ready()) await Bun.sleep(everyMs)
  // the rig repos and their beads stores, before the manager reads them; a failure is logged, and the manager still starts
  for (const problem of prepare?.() ?? []) log(`repos sync: ${problem}`)
  await bringUp(args, home, log, session())
  // ponytail: polls every 30 s with no backoff. A manager that exits inside a live herdr is not restarted
  // (superviseManager restarts its Claude); a herdr that keeps dying restarts every 30 s
  let lastBackup = Date.now()
  for (;;) {
    await Bun.sleep(everyMs)
    if (Date.now() - lastBackup >= backupMs) {
      lastBackup = Date.now()
      backupStep(bcfg, ready(), lock, log)
    }
    const n = paneCount()
    const action = decide({ herdrUp: n >= 0, panes: Math.max(n, 0) })
    if (action === 'none') continue
    log(`${action}: herdr ${action === 'restart-all' ? 'is down' : 'has no pane'}`)
    try {
      if (action === 'restart-all') await bringUp(args, home, log, session())
      else startManager(args, session())
    } catch (e) {
      log(`restart failed: ${(e as Error).message}`)
    }
  }
}
