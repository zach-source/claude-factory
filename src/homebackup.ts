import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  '/home/manager-host.log',
  '/home/.restoring',
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
  /:\/\/[^\s/:@]+:[^\s/@]+@/, // URL userinfo
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, // JWT
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /lin_api_[A-Za-z0-9]{20,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /ops_[A-Za-z0-9+/=_-]{30,}/,
  /npm_[A-Za-z0-9]{36}/,
  /xapp-[A-Za-z0-9-]{10,}/,
  /PRIVATE-TOKEN:\s*\S{16,}/i,
]
/** whether a file holds a token shape. Only a yes or no: the match never leaves this function */
export const secretFile = (b: Buffer) => {
  const s = b.toString('latin1')
  return SECRETS.some(re => re.test(s))
}

const GIT_DIR = (ws: string) => join(ws, 'backup.git')
const clean = (s: string) => s.replace(/\/\/[^/@\s]+@/g, '//').trim() // a URL's userinfo never reaches a log

function git(
  cfg: BackupCfg,
  args: string[],
  timeout = 120_000,
  o: { tree?: string; env?: Record<string, string>; input?: string } = {},
) {
  const p = Bun.spawnSync(
    [
      'git',
      '--git-dir',
      GIT_DIR(cfg.ws),
      '--work-tree',
      o.tree ?? cfg.ws,
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
    {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...o.env },
      timeout,
      stdout: 'pipe',
      stderr: 'pipe',
      ...(o.input !== undefined && { stdin: Buffer.from(o.input) }),
    },
  )
  return {
    ok: p.exitCode === 0,
    code: p.exitCode,
    buf: p.stdout as Buffer,
    out: p.stdout.toString().trim(),
    err: clean(p.stderr.toString()),
  }
}

/** the memory store can be a git repo (the dream makes one). The backup keeps it as plain files */
const memDir = (ws: string) => join(ws, 'home', 'memory')
const DREAM_AT = (ws: string) => join(ws, 'home', 'memory-dream.at')
const RESTORING = (ws: string) => join(ws, 'home', '.restoring')

function init(cfg: BackupCfg) {
  if (!existsSync(GIT_DIR(cfg.ws))) {
    const p = Bun.spawnSync(['git', 'init', '-q', '--bare', GIT_DIR(cfg.ws)])
    if (p.exitCode !== 0) throw new Error(`git init: ${clean(p.stderr.toString())}`)
  }
  git(cfg, ['config', 'core.bare', 'false'])
  git(cfg, ['symbolic-ref', 'HEAD', `refs/heads/${cfg.branch}`])
  const x = join(GIT_DIR(cfg.ws), 'info')
  mkdirSync(x, { recursive: true })
  // memory goes in through its own index (snapshotMemory), never as a nested repo or a gitlink
  const rules = [...(cfg.excludes ?? EXCLUDES), '/home/memory/']
  writeFileSync(join(x, 'exclude'), rules.join('\n') + '\n')
}

const PUSH_MS = 600_000

/**
 * Put the memory work tree in the main index as plain files. A second index takes the files (the memory
 * .gitignore applies, a nested .git never counts), then its tree replaces home/memory/ in the main index.
 * Only the files leave the VM, so the secret scan of the staged files covers memory too.
 * Also keeps home/memory-dream.at: the time of the last "dream:" commit, for restore. Returns an error text.
 */
function snapshotMemory(cfg: BackupCfg): string | undefined {
  const mem = memDir(cfg.ws)
  if (existsSync(join(mem, '.git'))) {
    const l = Bun.spawnSync(['git', '-C', mem, 'log', '-1', '--grep=^dream:', '--format=%at'], {
      stdout: 'pipe',
    })
    const at = l.stdout.toString().trim()
    const had = existsSync(DREAM_AT(cfg.ws)) ? readFileSync(DREAM_AT(cfg.ws), 'utf8').trim() : ''
    if (l.exitCode === 0 && at && at !== had) writeFileSync(DREAM_AT(cfg.ws), at + '\n')
  }
  const rm = git(cfg, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', 'home/memory'])
  if (!rm.ok) return `git rm memory: ${rm.err}`
  if (!existsSync(mem)) return undefined
  const idx = join(GIT_DIR(cfg.ws), 'mem.index')
  rmSync(idx, { force: true })
  const env = { GIT_INDEX_FILE: idx }
  const add = git(cfg, ['add', '-A', '.'], 120_000, { tree: mem, env })
  if (!add.ok) return `git add memory: ${add.err}`
  const t = git(cfg, ['write-tree'], 120_000, { env })
  if (!t.ok) return `git write-tree: ${t.err}`
  rmSync(idx, { force: true })
  const rt = git(cfg, ['read-tree', '--prefix=home/memory/', t.out])
  return rt.ok ? undefined : `git read-tree: ${rt.err}`
}

/** the remote branch tip: a sha, null when the branch is absent, or an error text */
function remoteTip(cfg: BackupCfg): string | null | { error: string } {
  const p = git(cfg, ['ls-remote', '--exit-code', cfg.remote!, `refs/heads/${cfg.branch}`], PUSH_MS)
  if (p.ok) return p.out.split(/\s/)[0] ?? ''
  // exit code 2 means no such ref; any other failure (network, auth) is an error
  return p.code === 2 ? null : { error: `git ls-remote: ${p.err.split('\n').at(-1)}` }
}

/** the factory home's state in the workspace: used when it holds rigs.json, runs or the .migrated marker.
 * A restore that did not end leaves home/.restoring: the home is not used then */
const homeUsed = (ws: string) =>
  !existsSync(RESTORING(ws)) && ['rigs.json', 'runs', '.migrated'].some(f => existsSync(join(ws, 'home', f)))

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
  if (existsSync(RESTORING(cfg.ws))) return fail('backup refused: a restore is not finished')
  // a nested repo would be saved as one gitlink, with none of its files
  if (existsSync(join(cfg.ws, 'home', '.git'))) return fail('backup refused: home/.git exists (nested repo)')
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
    // memory first: it also writes home/memory-dream.at, which the add below picks up
    const mem = snapshotMemory(cfg)
    if (mem) {
      git(cfg, ['reset', '-q'])
      return fail(mem)
    }
    const add = git(cfg, ['add', '-A', '--', ...pathspecs(cfg.ws)])
    if (!add.ok) return fail(`git add: ${add.err}`)
    // the staged blobs are what leaves the VM: scan them, not the work tree file
    const raw = git(cfg, ['diff', '--cached', '--raw', '--no-renames', '--diff-filter=d', '-z']).out.split(
      '\0',
    )
    const staged: { path: string; blob: string }[] = []
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const m = /^:\d+ (\d+) \S+ (\S+) /.exec(raw[i]!)
      if (m && m[1]!.startsWith('100')) staged.push({ path: raw[i + 1]!, blob: m[2]! }) // regular files, no gitlink
    }
    const blobs = (list: { blob: string }[]) => {
      const r = git(cfg, ['cat-file', '--batch'], 120_000, { input: list.map(s => s.blob).join('\n') + '\n' })
      if (!r.ok) throw new Error(`git cat-file: ${r.err}`) // an unread blob is not a clean one
      return r.buf
    }
    const bad = staged.length && secretFile(blobs(staged)) ? staged.filter(s => secretFile(blobs([s]))) : []
    if (bad.length) {
      git(cfg, ['reset', '-q'])
      return fail(`backup refused: secret-like text in ${bad.map(s => s.path).join(', ')}`)
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
    // a branch that holds a path the backup excludes (login files, Claude hooks, home/bin) is not ours: write nothing
    const names = git(cfg, ['ls-tree', '-r', '--name-only', '-z', sha])
    if (!names.ok) return { error: `git ls-tree: ${names.err}` }
    const ign = git(cfg, ['check-ignore', '--no-index', '-v', '-z', '--stdin'], 120_000, { input: names.out })
    if (ign.code !== 0 && ign.code !== 1) return { error: `git check-ignore: ${ign.err}` }
    const f4 = ign.out.split('\0')
    const hit: string[] = []
    // -v -z prints source, line, pattern, path; the memory rule is the backup's own, not an exclude
    for (let i = 0; i + 3 < f4.length; i += 4) if (f4[i + 2] !== '/home/memory/') hit.push(f4[i + 3]!)
    if (hit.length)
      return { error: `restore refused: the branch holds excluded paths: ${hit.slice(0, 5).join(', ')}` }
    // the marker stays until the last step: a crash in between makes the next call restore again
    writeFileSync(RESTORING(cfg.ws), `${sha}\n`)
    const c = git(cfg, ['checkout', '-q', '-f', '-B', cfg.branch, sha])
    if (!c.ok) return { error: `git checkout: ${c.err}` }
    const mem = memDir(cfg.ws)
    if (existsSync(mem)) {
      // memory is plain files in the backup: make it a repo again, dated by the last dream, so the next dream reads the journal from there
      const at = existsSync(DREAM_AT(cfg.ws)) ? readFileSync(DREAM_AT(cfg.ws), 'utf8').trim() : ''
      const date = /^\d+$/.test(at) ? `${at} +0000` : ''
      const env = { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }
      const g = (...a: string[]) =>
        Bun.spawnSync(
          [
            'git',
            '-C',
            mem,
            '-c',
            'user.name=factory',
            '-c',
            'user.email=factory@localhost',
            '-c',
            'commit.gpgsign=false',
            ...a,
          ],
          { env, stderr: 'pipe' },
        )
      const steps = [
        g('init', '-q'),
        g('add', '-A'),
        g(
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          `${date ? 'dream: restored from' : 'restore:'} backup ${sha}`,
        ),
      ]
      const bad = steps.find(p => p.exitCode !== 0)
      if (bad) return { error: `git memory: ${clean(bad.stderr.toString())}` }
    }
    writeFileSync(join(cfg.ws, 'home', '.migrated'), `restored ${sha}\n`)
    rmSync(RESTORING(cfg.ws))
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
