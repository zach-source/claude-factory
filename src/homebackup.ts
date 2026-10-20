import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { claudeFiles } from './migrate'

/**
 * Backup of the AX manager's state to a private git branch (claude-factory-192.9). AX keeps a task's workspace only
 * across suspend and resume, so a deleted task loses FACTORY_HOME and the manager's Claude memory and sessions.
 * `backup` snapshots them into WS/backup.git (work tree WS) and pushes the branch fast-forward only.
 * `restore` fetches it into an empty home when the host starts. The VM holds no key: the gateway adds it to
 * github.com requests (ax.ts, GITHUB_BASIC). With no remote set, both do nothing.
 */

export type BackupCfg = {
  /** the workspace (/workspace/w): home/ and claude/ sit under it */
  ws: string
  remote?: string
  branch: string
  /** test hook: replaces EXCLUDES */
  excludes?: string[]
}

/** gitignore rules, relative to the workspace: what never goes in the backup */
export const EXCLUDES = [
  '.claude.json',
  '.credentials.json',
  'settings*.json',
  'rigs.json.*',
  '*.lock',
  '/home/bin/',
  '/home/devenv/',
  '/home/herdr.log',
  '/home/backup.json',
  'worktrees/',
]

const SECRETS = [
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[bpsa]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Authorization:\s*(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{20,}/i,
]
/** whether a file holds a token shape. Only a yes or no: the match never leaves this function */
export const secretFile = (b: Buffer) => {
  const s = b.toString('latin1')
  return SECRETS.some(re => re.test(s))
}

const GIT_DIR = (ws: string) => join(ws, 'backup.git')
const clean = (s: string) => s.replace(/\/\/[^/@\s]+@/g, '//').trim() // a URL's userinfo never reaches a log

function git(cfg: BackupCfg, args: string[], timeout = 120_000) {
  const p = Bun.spawnSync(
    [
      'git',
      '--git-dir',
      GIT_DIR(cfg.ws),
      '--work-tree',
      cfg.ws,
      '-c',
      'user.name=factory',
      '-c',
      'user.email=factory@localhost',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout, stdout: 'pipe', stderr: 'pipe' },
  )
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: clean(p.stderr.toString()) }
}

function init(cfg: BackupCfg) {
  if (!existsSync(GIT_DIR(cfg.ws))) {
    const p = Bun.spawnSync(['git', 'init', '-q', '--bare', GIT_DIR(cfg.ws)])
    if (p.exitCode !== 0) throw new Error(`git init: ${clean(p.stderr.toString())}`)
  }
  git(cfg, ['config', 'core.bare', 'false'])
  git(cfg, ['symbolic-ref', 'HEAD', `refs/heads/${cfg.branch}`])
  const x = join(GIT_DIR(cfg.ws), 'info')
  mkdirSync(x, { recursive: true })
  writeFileSync(join(x, 'exclude'), (cfg.excludes ?? EXCLUDES).join('\n') + '\n')
}

/** the factory home's state in the workspace: used when it holds rigs.json, runs or the .migrated marker */
const homeUsed = (ws: string) => ['rigs.json', 'runs', '.migrated'].some(f => existsSync(join(ws, 'home', f)))

export type Outcome = {
  sha?: string
  changed?: boolean
  restored?: string
  skipped?: string
  error?: string
}

/** the paths to snapshot: home/, and the manager's Claude memory and session files */
function pathspecs(ws: string) {
  const f = join(ws, 'home', 'manager-sessions.json')
  let sessions: { session: string; cwd: string }[] = []
  try {
    const v = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []
    if (Array.isArray(v)) sessions = v
  } catch {}
  return ['home', ...claudeFiles(sessions, join(ws, 'claude')).map(p => relative(ws, p))]
}

function record(cfg: BackupCfg, o: Outcome, stats: { files?: number; bytes?: number } = {}) {
  const f = join(cfg.ws, 'home', 'backup.json')
  let prev: { at?: string; sha?: string } = {}
  try {
    prev = JSON.parse(readFileSync(f, 'utf8'))
  } catch {}
  const good = !o.error
  try {
    writeFileSync(
      f,
      JSON.stringify({
        at: good ? new Date().toISOString() : prev.at,
        sha: good ? o.sha : prev.sha,
        ...stats,
        error: o.error ?? '',
      }) + '\n',
    )
  } catch {}
}

/**
 * snapshot and push. Refuses when the home is not ready (an empty home must not replace a good backup), when a
 * staged file holds a secret (nothing stays staged), and never forces a push. The result goes to home/backup.json
 */
export function backup(cfg: BackupCfg, ready: boolean): Outcome {
  if (!cfg.remote) return { skipped: 'no remote' }
  const fail = (error: string) => {
    const o = { error }
    record(cfg, o)
    return o
  }
  if (!ready) return fail('backup refused: home is not ready')
  try {
    init(cfg)
    const add = git(cfg, ['add', '-A', '--', ...pathspecs(cfg.ws)])
    if (!add.ok) return fail(`git add: ${add.err}`)
    const staged = git(cfg, ['diff', '--cached', '--name-only', '--diff-filter=d', '-z'])
      .out.split('\0')
      .filter(Boolean)
    const bad = staged.filter(n => secretFile(readFileSync(join(cfg.ws, n))))
    if (bad.length) {
      git(cfg, ['reset', '-q'])
      return fail(`backup refused: secret-like text in ${bad.join(', ')}`)
    }
    const dirty = git(cfg, ['diff', '--cached', '--quiet']).ok === false
    if (dirty) {
      const c = git(cfg, ['commit', '-q', '-m', `backup ${new Date().toISOString()}`])
      if (!c.ok) return fail(`git commit: ${c.err}`)
    }
    const sha = git(cfg, ['rev-parse', '--verify', 'HEAD']).out
    if (!sha) return fail('git rev-parse: no commit')
    const push = git(cfg, ['push', '-q', cfg.remote, `HEAD:refs/heads/${cfg.branch}`])
    if (!push.ok) return fail(`git push: ${push.err.split('\n').at(-1)}`)
    const files = git(cfg, ['ls-tree', '-r', '--name-only', 'HEAD']).out.split('\n').filter(Boolean)
    const bytes = files.reduce((n, p) => n + statSync(join(cfg.ws, p)).size, 0)
    const o = { sha, changed: dirty }
    record(cfg, o, { files: files.length, bytes })
    return o
  } catch (e) {
    return fail(clean((e as Error).message))
  }
}

/**
 * put the backup branch into an empty home. A used home, no remote or no branch changes nothing. Writes the
 * .migrated marker, so the host starts the manager
 */
export function restore(cfg: BackupCfg): Outcome {
  if (!cfg.remote) return { skipped: 'no remote' }
  if (homeUsed(cfg.ws)) return { skipped: 'used' }
  try {
    init(cfg)
    const f = git(cfg, ['fetch', '-q', cfg.remote, `refs/heads/${cfg.branch}`])
    if (!f.ok) return { skipped: 'no backup' }
    const sha = git(cfg, ['rev-parse', 'FETCH_HEAD']).out
    const c = git(cfg, ['checkout', '-q', '-f', '-B', cfg.branch, sha])
    if (!c.ok) return { error: `git checkout: ${c.err}` }
    writeFileSync(join(cfg.ws, 'home', '.migrated'), `restored ${sha}\n`)
    return { restored: sha }
  } catch (e) {
    return { error: clean((e as Error).message) }
  }
}

/** ms since the last good backup in `home`, or undefined when there is none */
export function backupAge(home: string, now: number) {
  try {
    const at = Date.parse(JSON.parse(readFileSync(join(home, 'backup.json'), 'utf8')).at)
    return Number.isNaN(at) ? undefined : now - at
  } catch {
    return undefined
  }
}
