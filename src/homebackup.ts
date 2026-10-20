import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  return {
    ok: p.exitCode === 0,
    code: p.exitCode,
    out: p.stdout.toString().trim(),
    err: clean(p.stderr.toString()),
  }
}

/** The memory store is its own git repo (migrate copies its .git). The outer git would see a gitlink. */
const memoryRepo = (ws: string) => existsSync(join(ws, 'home', 'memory', '.git'))
const BUNDLE = 'memory.bundle'

function init(cfg: BackupCfg) {
  if (!existsSync(GIT_DIR(cfg.ws))) {
    const p = Bun.spawnSync(['git', 'init', '-q', '--bare', GIT_DIR(cfg.ws)])
    if (p.exitCode !== 0) throw new Error(`git init: ${clean(p.stderr.toString())}`)
  }
  git(cfg, ['config', 'core.bare', 'false'])
  git(cfg, ['symbolic-ref', 'HEAD', `refs/heads/${cfg.branch}`])
  const x = join(GIT_DIR(cfg.ws), 'info')
  mkdirSync(x, { recursive: true })
  const rules = [...(cfg.excludes ?? EXCLUDES), ...(memoryRepo(cfg.ws) ? ['/home/memory/'] : [])]
  writeFileSync(join(x, 'exclude'), rules.join('\n') + '\n')
}

const PUSH_MS = 600_000

/** every regular file under d, .git excluded */
function files(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.name === '.git' ? [] : e.isDirectory() ? files(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : [],
  )
}

/**
 * Put the history of the memory repo in home/memory.bundle. Write it only when the refs changed, because
 * each bundle run gives different bytes. Scan the memory files for secrets first.
 * The backup does not save uncommitted memory files. Returns an error text, or undefined.
 */
function bundleMemory(ws: string): string | undefined {
  if (!memoryRepo(ws)) return undefined
  const mem = join(ws, 'home', 'memory')
  const bad = files(mem).filter(f => secretFile(readFileSync(f)))
  if (bad.length) return `backup refused: secret-like text in ${bad.map(f => relative(ws, f)).join(', ')}`
  // the bundle carries every commit, so a token in an old commit counts even when the work tree is clean
  const hist = Bun.spawnSync(['git', '-C', mem, 'log', '--all', '-p', '--format='], { stdout: 'pipe' })
  if (hist.exitCode === 0 && secretFile(Buffer.from(hist.stdout)))
    return 'backup refused: secret-like text in the history of home/memory'
  const refs = Bun.spawnSync(['git', '-C', mem, 'for-each-ref', '--format=%(objectname) %(refname)'])
  const state = refs.stdout.toString()
  const marker = join(ws, 'home', `${BUNDLE}.refs`)
  if (!state.trim()) return undefined // no commit yet: nothing to bundle
  if (existsSync(marker) && readFileSync(marker, 'utf8') === state && existsSync(join(ws, 'home', BUNDLE)))
    return undefined
  // ponytail: each ref change stores a whole new bundle. Push the memory refs to their own remote ref if the branch grows too big
  const b = Bun.spawnSync(['git', '-C', mem, 'bundle', 'create', '-q', join(ws, 'home', BUNDLE), '--all'])
  if (b.exitCode !== 0) return `git bundle: ${clean(b.stderr.toString())}`
  writeFileSync(marker, state)
  return undefined
}

/** the remote branch tip: a sha, null when the branch is absent, or an error text */
function remoteTip(cfg: BackupCfg): string | null | { error: string } {
  const p = git(cfg, ['ls-remote', '--exit-code', cfg.remote!, `refs/heads/${cfg.branch}`], PUSH_MS)
  if (p.ok) return p.out.split(/\s/)[0] ?? ''
  // exit code 2 means no such ref; any other failure (network, auth) is an error
  return p.code === 2 ? null : { error: `git ls-remote: ${p.err.split('\n').at(-1)}` }
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
 * Snapshot and push. Refuses when the home is not ready (an empty home must not replace a good backup), when a
 * staged file holds a secret (nothing stays staged), and never forces a push. The result goes to home/backup.json.
 * `lock` guards the snapshot only. The push runs after the lock is free, because a push can take minutes.
 * With no local history and a branch on the remote, the first commit goes on top of the remote tip.
 */
export function backup(
  cfg: BackupCfg,
  ready: boolean,
  lock: () => (() => void) | null = () => () => {},
): Outcome {
  if (!cfg.remote) return { skipped: 'no remote' }
  const remote = cfg.remote
  const fail = (error: string) => {
    const o = { error }
    record(cfg, o)
    return o
  }
  if (!ready) return fail('backup refused: home is not ready')
  let sha = ''
  let dirty = false
  const release = lock()
  if (!release) return { skipped: 'lock' }
  try {
    init(cfg)
    if (!git(cfg, ['rev-parse', '--verify', 'HEAD']).ok) {
      const tip = remoteTip(cfg)
      if (tip && typeof tip === 'object') return fail(tip.error)
      if (tip) {
        const f = git(cfg, ['fetch', '-q', remote, `refs/heads/${cfg.branch}`], PUSH_MS)
        if (!f.ok) return fail(`git fetch: ${f.err.split('\n').at(-1)}`)
        // the branch moves to the remote tip; the index follows it and the files stay as they are
        git(cfg, ['update-ref', `refs/heads/${cfg.branch}`, 'FETCH_HEAD'])
        git(cfg, ['reset', '-q'])
      }
    }
    const mem = bundleMemory(cfg.ws)
    if (mem) return fail(mem)
    const add = git(cfg, ['add', '-A', '--', ...pathspecs(cfg.ws)])
    if (!add.ok) return fail(`git add: ${add.err}`)
    const staged = git(cfg, ['diff', '--cached', '--name-only', '--diff-filter=d', '-z'])
      .out.split('\0')
      .filter(Boolean)
    const regular = (n: string) => {
      try {
        return lstatSync(join(cfg.ws, n)).isFile()
      } catch {
        return false
      }
    }
    const bad = staged.filter(n => regular(n) && secretFile(readFileSync(join(cfg.ws, n))))
    if (bad.length) {
      git(cfg, ['reset', '-q'])
      return fail(`backup refused: secret-like text in ${bad.join(', ')}`)
    }
    dirty = git(cfg, ['diff', '--cached', '--quiet']).ok === false
    if (dirty) {
      const c = git(cfg, ['commit', '-q', '-m', `backup ${new Date().toISOString()}`])
      if (!c.ok) return fail(`git commit: ${c.err}`)
    }
    sha = git(cfg, ['rev-parse', '--verify', 'HEAD']).out
    if (!sha) return fail('git rev-parse: no commit')
  } catch (e) {
    return fail(clean((e as Error).message))
  } finally {
    release()
  }
  try {
    const push = git(cfg, ['push', '-q', remote, `HEAD:refs/heads/${cfg.branch}`], PUSH_MS)
    if (!push.ok) return fail(`git push: ${push.err.split('\n').at(-1)}`)
    // blob sizes come from the tree: a file that left the work tree after the commit cannot break this
    const tree = git(cfg, ['ls-tree', '-r', '-l', 'HEAD']).out.split('\n').filter(Boolean)
    const bytes = tree.reduce((n, l) => n + (Number((l.split('\t')[0] ?? '').trim().split(/\s+/)[3]) || 0), 0)
    const o = { sha, changed: dirty }
    record(cfg, o, { files: tree.length, bytes })
    return o
  } catch (e) {
    return fail(clean((e as Error).message))
  }
}

/**
 * Put the backup branch into an empty home. A used home, no remote or no branch changes nothing. Writes the
 * .migrated marker, so the host starts the manager. A fetch that fails is an error, not "no backup":
 * the caller can try again.
 */
export function restore(cfg: BackupCfg): Outcome {
  if (!cfg.remote) return { skipped: 'no remote' }
  if (homeUsed(cfg.ws)) return { skipped: 'used' }
  try {
    init(cfg)
    const tip = remoteTip(cfg)
    if (tip === null) return { skipped: 'no backup' }
    if (typeof tip === 'object') return { error: tip.error }
    const f = git(cfg, ['fetch', '-q', cfg.remote, `refs/heads/${cfg.branch}`], PUSH_MS)
    if (!f.ok) return { error: `git fetch: ${f.err.split('\n').at(-1)}` }
    const sha = git(cfg, ['rev-parse', 'FETCH_HEAD']).out
    const c = git(cfg, ['checkout', '-q', '-f', '-B', cfg.branch, sha])
    if (!c.ok) return { error: `git checkout: ${c.err}` }
    const bundle = join(cfg.ws, 'home', BUNDLE)
    const mem = join(cfg.ws, 'home', 'memory')
    if (existsSync(bundle) && !existsSync(mem)) {
      const k = Bun.spawnSync(['git', 'clone', '-q', bundle, mem], { stderr: 'pipe' })
      if (k.exitCode !== 0) return { error: `git clone memory: ${clean(k.stderr.toString())}` }
      Bun.spawnSync(['git', '-C', mem, 'remote', 'remove', 'origin'])
    }
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

/** the error of the last backup run in `home`, or undefined when it had none */
export function backupError(home: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(home, 'backup.json'), 'utf8')).error || undefined
  } catch {
    return undefined
  }
}
