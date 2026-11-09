import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { AUTHORIZED_KEYS_ENV, MANAGER_CWD, MANAGER_HOME, publicKeys, SSH_DIR, SSHD_CONFIG, WS } from './ax'
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
 * its unpack writes rigs.json before it ends. An empty home waits for `factory migrate-to-ax`.
 * With a launch id, the marker must be of this launch, and a hand-made home does not count: an old Workspace
 * of the same name also has rigs.json
 */
export const homeReady = (f: {
  migrated: boolean
  fresh: boolean
  hasRigs: boolean
  archive: boolean
  /** home/.restoring: a restore did not end, so the home may hold half a checkout */
  restoring?: boolean
  /** FACTORY_AX_LAUNCH_ID is set */
  launch?: boolean
}) => !f.restoring && (f.migrated || f.fresh || (f.hasRigs && !f.archive && !f.launch))

/** whether a .migrated text is of launch `id`; with no id (a reused Workspace), any marker */
export const markerOk = (text: string, id?: string) => !id || text.match(/\blaunch=([\w-]+)/)?.[1] === id

/** restore an empty home from the backup branch (192.9); logs what it did and never throws. True when a retry can help */
export function restoreStep(
  cfg: BackupCfg,
  log: (m: string) => void,
  run: (c: BackupCfg) => Outcome = restore,
) {
  if (!cfg.remote) return false
  try {
    const o = run(cfg)
    if (o.restored) log(`restored ${o.restored}`)
    else if (o.error) log(`restore failed: ${o.error}`)
    else
      log(`restore: ${o.skipped}${o.skipped === 'no backup' ? '; waiting for `factory migrate-to-ax`' : ''}`)
    return !!o.error
  } catch (e) {
    log(`restore failed: ${(e as Error).message}`)
    return true
  }
}

/**
 * Wait until the home is ready and no restore is pending. Try a failed restore again each cycle, also with
 * FACTORY_AX_FRESH=1. A manager that starts empty over a good backup would push the deletes on top of it.
 */
export async function awaitHome(ready: () => boolean, step: () => boolean, sleep: () => Promise<unknown>) {
  let retry = step()
  while (!ready() || retry) {
    await sleep()
    if (retry) retry = step()
  }
}

/**
 * one backup; backup() takes the tick lock for the snapshot only. A tick holds the lock most of the time.
 * If the lock is held, the step tries again each second, up to `tries` times (2 min).
 * It logs the skip once, at the end. It logs a failure, and the host loop goes on
 */
export async function backupStep(
  cfg: BackupCfg,
  ready: boolean,
  lock: () => (() => void) | null,
  log: (m: string) => void,
  run: (c: BackupCfg, ready: boolean, lock: () => (() => void) | null) => Outcome = backup,
  tries = 120,
  nap: () => Promise<unknown> = () => Bun.sleep(1000),
) {
  if (!cfg.remote) return
  try {
    let o = run(cfg, ready, lock)
    for (let n = 1; o.skipped === 'lock' && n < tries; n++) {
      await nap()
      o = run(cfg, ready, lock)
    }
    if (o.skipped === 'lock') log(`backup skipped: a tick held the lock at ${tries} tries`)
    else if (o.error) log(o.error.startsWith('backup refused') ? o.error : `backup failed: ${o.error}`)
    else if (o.changed) log(`backup ${o.sha}`)
    for (const x of o.redacted ?? []) log(`backup redacted ${x}`) // the rule id and the path, never the value
  } catch (e) {
    log(`backup failed: ${(e as Error).message}`)
  }
}

/** env keys that sshd sets itself for a session; the attach session gets every other one-line value of the host */
const SSH_OWN = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'PWD', 'OLDPWD', 'SHLVL', '_', 'MAIL'])

/**
 * The sshd_config for `sshd -i` as the worker user. A non-root sshd does no privilege separation and no chroot.
 * PAM, passwords and the StrictModes check are off. The key in authorized_keys is the only way in.
 * SetEnv gives the session the host env, so `herdr --remote` and `factory` find herdr, the home and the CA.
 */
export function sshdConfig(dir: string, env: Record<string, string | undefined>) {
  const setEnv = Object.entries(env)
    .filter(([k, v]) => v !== undefined && !SSH_OWN.has(k) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .filter(([, v]) => !/["\n\r\\]/.test(v!))
    .map(([k, v]) => `"${k}=${v}"`)
  return [
    `HostKey ${dir}/host_ed25519`,
    `AuthorizedKeysFile ${dir}/authorized_keys`,
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitRootLogin no',
    'StrictModes no',
    'UsePAM no',
    'PidFile none',
    ...(setEnv.length ? [`SetEnv ${setEnv.join(' ')}`] : []),
    '',
  ].join('\n')
}

/**
 * As root, before the drop to the worker user: put the worker in the tty group. Without it, sshd cannot chown
 * its pty (EPERM), and an attach gets no terminal. A failure goes to the log.
 */
function ttyGroup(log: (m: string) => void) {
  if (process.getuid?.() !== 0) return
  const p = Bun.spawnSync(['usermod', '-aG', 'tty', worker.WORKER_USER])
  if (p.exitCode !== 0) log(`attach: usermod -aG tty failed: ${p.stderr.toString().trim()}`)
}

/**
 * As the worker user: write the attach files in SSH_DIR. The host key is made once, on the first start.
 * authorized_keys comes from FACTORY_SSH_AUTHORIZED_KEYS on each start. With no key, nobody can attach.
 */
export function prepareSsh(log: (m: string) => void, env: Record<string, string | undefined> = process.env) {
  try {
    mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })
    const key = join(SSH_DIR, 'host_ed25519')
    if (!existsSync(key)) {
      const p = Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key])
      if (p.exitCode !== 0) throw new Error(`ssh-keygen: ${p.stderr.toString().trim()}`)
    }
    const keys = env[AUTHORIZED_KEYS_ENV]
    writeFileSync(join(SSH_DIR, 'authorized_keys'), keys ? publicKeys(keys) : '', { mode: 0o600 })
    chmodSync(join(SSH_DIR, 'authorized_keys'), 0o600)
    writeFileSync(SSHD_CONFIG, sshdConfig(SSH_DIR, env))
    log(keys ? `attach: sshd ready (${SSHD_CONFIG})` : `attach: off, ${AUTHORIZED_KEYS_ENV} is not set`)
  } catch (e) {
    log(`attach: ${(e as Error).message}`)
  }
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

/**
 * The `.claude.json` that lets a new CLAUDE_CONFIG_DIR skip the first-start onboarding. Onboarding checks the
 * network, and the egress gateway blocks that check. The result keeps every other key and a theme that is set.
 */
export function seedClaudeJson(cur: Json, dirs: string[] = [MANAGER_CWD, MANAGER_HOME]): Json {
  const projects = obj(cur.projects)
  const seeded = Object.fromEntries(
    dirs.map(d => [
      d,
      { ...obj(projects[d]), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    ]),
  )
  return {
    ...cur,
    hasCompletedOnboarding: true,
    theme: cur.theme ?? 'dark',
    bypassPermissionsModeAccepted: true,
    projects: { ...projects, ...seeded },
  }
}

/** the settings.json that skips the Bypass Permissions dialog */
export const seedSettings = (cur: Json): Json => ({ ...cur, skipDangerousModePermissionPrompt: true })

/** merge `seed` into the JSON file `path`. A missing file starts empty. A file that is not an object throws */
function seedFile(path: string, seed: (cur: Json) => Json) {
  let cur: Json = {}
  if (existsSync(path)) {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path} is not a JSON object`)
    cur = v as Json
  }
  writeFileSync(path, JSON.stringify(seed(cur), null, 2))
}

/** seed the manager Claude's config dir (CLAUDE_CONFIG_DIR, else `${WS}/claude`) before the manager starts */
function seedClaudeConfig(log: (m: string) => void) {
  const dir = process.env.CLAUDE_CONFIG_DIR || `${WS}/claude`
  try {
    mkdirSync(dir, { recursive: true })
    seedFile(join(dir, '.claude.json'), seedClaudeJson)
    seedFile(join(dir, 'settings.json'), seedSettings)
  } catch (e) {
    log(`claude config seed failed: ${(e as Error).message}`)
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
  seedClaudeConfig(log)
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
  // as root, before the drop: the log is not open yet, so a failure goes to stderr (the task log)
  ttyGroup(m => console.error(m))
  worker.asWorker() // as the worker user, like `ax ssh` for attach and say: it re-runs this command and exits
  mkdirSync(worker.own(), { recursive: true })
  worker.trustCA()
  mkdirSync(home, { recursive: true })
  const log = (m: string) =>
    appendFileSync(join(home, 'manager-host.log'), `${new Date().toISOString()} ${m}\n`)
  // before the wait for a home: a person can attach while the task waits for `factory migrate-to-ax`
  prepareSsh(log)
  const session = () => {
    const f = join(home, 'manager-sessions.json')
    return existsSync(f) ? lastSession(readFileSync(f, 'utf8')) : undefined
  }
  const launch = process.env.FACTORY_AX_LAUNCH_ID || undefined
  const marker = join(home, '.migrated')
  const ready = () =>
    homeReady({
      migrated: existsSync(marker) && markerOk(readFileSync(marker, 'utf8'), launch),
      launch: !!launch,
      fresh: process.env.FACTORY_AX_FRESH === '1',
      hasRigs: existsSync(join(home, 'rigs.json')),
      restoring: existsSync(join(home, '.restoring')),
      archive:
        existsSync(join(worker.own(), 'migrate.tgz')) || existsSync(join(worker.own(), 'put', 'migrate.tgz')),
    })
  // the backup keeps FACTORY_HOME at <workspace>/home; any other home is not backed up
  const bcfg: BackupCfg = {
    ws: dirname(home),
    remote: basename(home) === 'home' ? process.env.FACTORY_AX_BACKUP_REMOTE : undefined,
    branch: process.env.FACTORY_AX_BACKUP_BRANCH || 'manager-home',
    launch,
  }
  if (process.env.FACTORY_AX_BACKUP_REMOTE && !bcfg.remote)
    log('backup off: FACTORY_HOME is not <workspace>/home')
  const backupMs = Number(process.env.FACTORY_AX_BACKUP_EVERY) || 600_000
  if (existsSync(marker) && !markerOk(readFileSync(marker, 'utf8'), launch))
    log(
      `.migrated is not of launch ${launch}: an old home. Delete the Workspace, or run factory migrate-to-ax --force`,
    )
  if (!ready()) log('waiting for `factory migrate-to-ax` (or FACTORY_AX_FRESH=1) before the manager starts')
  // ponytail: no timeout: an empty home waits until the laptop migrates it. A restore that failed is tried again
  await awaitHome(
    ready,
    () => restoreStep(bcfg, log),
    () => Bun.sleep(everyMs),
  )
  // the rig repos and their beads stores, before the manager reads them; a failure is logged, and the manager still starts
  for (const problem of prepare?.() ?? []) log(`repos sync: ${problem}`)
  if (process.env.FACTORY_AX_MANAGER_DRY === '1') {
    // a staging copy of a live home: no herdr, no manager, no tick and no backup
    log('dry: the home is ready; the manager does not start (FACTORY_AX_MANAGER_DRY=1)')
    for (;;) await Bun.sleep(3_600_000)
  }
  await bringUp(args, home, log, session())
  // ponytail: polls every 30 s with no backoff. A manager that exits inside a live herdr is not restarted
  // (superviseManager restarts its Claude); a herdr that keeps dying restarts every 30 s
  let lastBackup = Date.now()
  for (;;) {
    await Bun.sleep(everyMs)
    if (Date.now() - lastBackup >= backupMs) {
      lastBackup = Date.now()
      // ponytail: the host loop waits for the backup, up to 2 min while a tick holds the lock
      await backupStep(bcfg, ready(), lock, log)
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
