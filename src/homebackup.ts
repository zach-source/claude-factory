import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { claudeFiles } from './migrate'
import { gitFenced } from './memory'

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
  /** the task's FACTORY_AX_LAUNCH_ID: a restore writes it into .migrated (managerhost.markerOk) */
  launch?: string
  /** base64 of x-access-token:<token>: sent as a header to git calls under `remote` only (the server home backup) */
  auth?: string
  /** replaces EXCLUDES (the server adds its lease file; tests) */
  excludes?: string[]
  /** test hook: the gitleaks binary (default `gitleaks` on PATH) */
  gitleaks?: string
}

/** gitignore rules, relative to the workspace: what never goes in the backup */
export const EXCLUDES = [
  '.claude.json',
  '.credentials.json',
  '/claude/**/settings*.json',
  'rigs.json.*',
  '*.lock',
  '/home/bin/',
  '/home/devenv/',
  '/home/herdr.log',
  '/home/backup.json',
  '/home/manager-host.log',
  '/home/.restoring',
  '/home/ui-cache/',
  // the beads stores: GBs of Dolt data with an empty nested .git; repos sync runs bd bootstrap from Dolt again
  '/home/beads/',
  // a step's own HOME and Claude config dir (src/steps.ts runStep): its login never goes in the backup
  '/home/steps/',
  'worktrees/',
]

import { SECRETS } from './secrets'
export { SECRETS }
/** whether a file holds a token shape. Only a yes or no: the match never leaves this function */
export const secretFile = (b: Buffer) => {
  const s = b.toString('latin1')
  return SECRETS.some(re => re.test(s))
}

const GIT_DIR = (ws: string) => join(ws, 'backup.git')
const clean = (s: string) => s.replace(/\/\/[^/@\s]+@/g, '//').trim() // a URL's userinfo never reaches a log

/** env that gives git the Basic header for the backup remote only. The token never reaches argv or a log */
export const authEnv = (cfg: BackupCfg): Record<string, string> =>
  cfg.auth && cfg.remote
    ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${cfg.remote}.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${cfg.auth}`,
      }
    : {}

function git(
  cfg: BackupCfg,
  args: string[],
  timeout = 120_000,
  o: { tree?: string; env?: Record<string, string>; input?: string | Buffer } = {},
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
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...authEnv(cfg), ...o.env },
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

/** d289.21: the host writes FACTORY_HOME/backup.want when a backup is due. A tick does not start while it is fresh */
export const WANT_MS = 600_000
export const backupWant = (home: string) => join(home, 'backup.want')
export const backupWanted = (home: string, now = Date.now()) => {
  try {
    return now - statSync(backupWant(home)).mtimeMs < WANT_MS
  } catch {
    return false
  }
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
  if (existsSync(join(mem, '.git')) && !gitFenced(mem)) {
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
  /** `<rule id> <path>` of each secret that the push has as [REDACTED]; never the value */
  redacted?: string[]
}

/** one gitleaks finding. It holds the secret: it stays in memory, and no log, file or error gets it */
export type Leak = { RuleID: string; File: string; Secret: string; Tags?: string[] }

const B64 = /[A-Za-z0-9+/_-]{16,}={0,2}/g
/** whether a base64 run decodes to text that holds the needle, also after up to `depth` nested decodes */
const holds = (run: string, needle: string, depth: number): boolean => {
  const t = Buffer.from(run, 'base64').toString('latin1')
  return t.includes(needle) || (depth > 1 && (t.match(B64) ?? []).some(r => holds(r, needle, depth - 1)))
}

/**
 * The text with each secret of the findings replaced by [REDACTED], found by content: gitleaks reads big files
 * in chunks, so its line and column numbers do not point at the text. Each occurrence of a plain secret goes.
 * For a `decoded:*` finding, the secret is the decoded text: each base64 run that decodes to text holding it
 * goes. The text is latin1 (one char for each byte), and each secret is its UTF-8 bytes, so multibyte text
 * before a secret does not matter.
 */
export function redact(text: Buffer, leaks: Leak[]): Buffer {
  const bytes = (x: string) => Buffer.from(x, 'utf8').toString('latin1')
  const isDecoded = (l: Leak) => (l.Tags ?? []).some(t => t.startsWith('decoded:'))
  const plain = [...new Set(leaks.filter(l => l.Secret && !isDecoded(l)).map(l => bytes(l.Secret)))]
  const decoded = [...new Set(leaks.filter(l => l.Secret && isDecoded(l)).map(l => bytes(l.Secret)))]
  let s = text.toString('latin1')
  for (const n of plain.sort((x, y) => y.length - x.length)) s = s.split(n).join('[REDACTED]')
  if (decoded.length) s = s.replace(B64, run => (decoded.some(n => holds(run, n, 3)) ? '[REDACTED]' : run))
  return Buffer.from(s, 'latin1')
}

/**
 * gitleaks over the files of dir; the findings, or an error. The report holds the secrets: it goes to a pipe
 * only (stdout), never to a file or a log, and no error text gets any of it
 */
function gitleaks(bin: string, dir: string): Leak[] | { error: string } {
  const p = Bun.spawnSync(
    [
      bin,
      'dir',
      dir,
      '--no-banner',
      '--log-level',
      'error',
      '--exit-code',
      '0',
      '--report-format',
      'json',
      '--report-path',
      '-',
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: 600_000 },
  )
  if (p.exitCode !== 0) return { error: `gitleaks exit ${p.exitCode}` }
  try {
    return JSON.parse(p.stdout.toString() || '[]') as Leak[]
  } catch {
    return { error: 'gitleaks: the report is not JSON' }
  }
}

/** the contents of `git cat-file --batch` output, in order */
function splitBatch(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < buf.length;) {
    const nl = buf.indexOf(10, i)
    const size = Number(buf.subarray(i, nl).toString().split(' ')[2])
    if (!Number.isFinite(size)) throw new Error('git cat-file: a blob is missing') // an unread blob is not a clean one
    out.push(buf.subarray(nl + 1, nl + 1 + size))
    i = nl + 1 + size + 1
  }
  return out
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

type Staged = { mode: string; path: string; blob: string }

/**
 * The staged blobs are what leaves the VM. gitleaks scans them (a copy in a temp dir, named by index). Each file
 * with a finding gets a new blob with [REDACTED] in place of the secret, in the index only: the work tree file
 * stays. A second scan of the new blobs must find nothing. No gitleaks: refuse, as a scan that did not run is not
 * a clean one. It runs after the tick lock is free. ponytail: the scan copies the changed blobs to disk; the
 * first backup copies the whole home
 */
function scrub(cfg: BackupCfg, staged: Staged[]): { redacted: string[] } | { error: string } {
  if (!staged.length) return { redacted: [] }
  const bin = Bun.which(cfg.gitleaks ?? 'gitleaks')
  if (!bin) return { error: 'backup refused: gitleaks is missing' }
  const r = git(cfg, ['cat-file', '--batch'], 120_000, { input: staged.map(s => s.blob).join('\n') + '\n' })
  if (!r.ok) return { error: `git cat-file: ${r.err}` }
  const blobs = splitBatch(r.buf)
  const scan = (files: Map<number, Buffer>) => {
    const dir = mkdtempSync(join(cfg.ws, '.backup-scan-')) // the workspace disk: /tmp can be small; no pathspec covers it
    try {
      for (const [i, b] of files) writeFileSync(join(dir, String(i)), b)
      const leaks = gitleaks(bin, dir)
      if ('error' in leaks) return leaks
      const by = new Map<number, Leak[]>()
      for (const l of leaks) {
        const i = Number(l.File.split('/').at(-1))
        by.set(i, [...(by.get(i) ?? []), l])
      }
      return by
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const found = scan(new Map(blobs.map((b, i) => [i, b])))
  if ('error' in found) return { error: `backup refused: ${found.error}` }
  const fixed = new Map([...found].map(([i, leaks]) => [i, redact(blobs[i]!, leaks)]))
  const left = scan(fixed)
  if ('error' in left) return { error: `backup refused: ${left.error}` }
  if (left.size)
    return {
      error: `backup refused: a secret is left after redaction in ${[...left.keys()].map(i => staged[i]!.path).join(', ')}`,
    }
  for (const [i, b] of fixed) {
    const h = git(cfg, ['hash-object', '-w', '--stdin'], 120_000, { input: b })
    if (!h.ok) return { error: `git hash-object: ${h.err}` }
    const u = git(cfg, ['update-index', '--cacheinfo', `${staged[i]!.mode},${h.out},${staged[i]!.path}`])
    if (!u.ok) return { error: `git update-index: ${u.err}` }
  }
  return {
    redacted: [...found].flatMap(([i, leaks]) => [
      ...new Set(leaks.map(l => `${l.RuleID} ${staged[i]!.path}`)),
    ]),
  }
}

/** GitHub refuses a file over 100 MB and warns over 50 MB: the backup stores a bigger file as gzip */
const GZ_OVER = 50 * 1024 * 1024
/** the list of paths that the backup stored as <path>.gz; the restore gunzips only these */
const GZ_LIST = 'home/.backup-gz.json'

/**
 * Each index file over 50 MB goes in the index as <path>.gz, after the scrub (the scan reads the plain text).
 * The work tree file stays. The add stages the plain file again each time, so each backup does this again; the
 * same text gives the same gzip blob, so no commit. GZ_LIST names the paths. ponytail: reads and gzips each
 * big file at each backup, after the tick lock is free
 */
function gzipBig(cfg: BackupCfg): string | undefined {
  const ls = git(cfg, ['ls-files', '--stage', '-z']).out.split('\0').filter(Boolean)
  const rows = ls.map(l => /^(\d+) (\S+) \d+\t(.*)$/s.exec(l)).filter(m => m && m[1]!.startsWith('100'))
  const sizes = git(cfg, ['cat-file', '--batch-check=%(objectsize)'], 120_000, {
    input: rows.map(m => m![2]).join('\n') + '\n',
  }).out.split('\n')
  const big = rows.filter((m, i) => Number(sizes[i]) > GZ_OVER && m![3] !== GZ_LIST).map(m => m!)
  const put = (path: string, b: Buffer, mode = '100644') => {
    const h = git(cfg, ['hash-object', '-w', '--stdin'], 120_000, { input: b })
    if (!h.ok) return `git hash-object: ${h.err}`
    const u = git(cfg, ['update-index', '--add', '--cacheinfo', `${mode},${h.out},${path}`])
    return u.ok ? undefined : `git update-index: ${u.err}`
  }
  for (const [, mode, blob, path] of big) {
    if (existsSync(join(cfg.ws, `${path}.gz`)))
      return `backup refused: ${path} is over 50 MB and ${path}.gz exists`
    const c = git(cfg, ['cat-file', 'blob', blob!])
    if (!c.ok) return `git cat-file: ${c.err}`
    const e = put(`${path}.gz`, gzipSync(c.buf, { level: 6 }), mode)
    if (e) return e
    git(cfg, ['update-index', '--force-remove', '--', path!])
  }
  if (!big.length) return void git(cfg, ['update-index', '--force-remove', '--', GZ_LIST])
  return put(GZ_LIST, Buffer.from(JSON.stringify(big.map(m => m[3])) + '\n'))
}

/** after a checkout: gunzip each <path>.gz that GZ_LIST names back to <path>, then drop the list */
function gunzipBig(ws: string): string | undefined {
  const f = join(ws, GZ_LIST)
  if (!existsSync(f)) return
  let list: unknown
  try {
    list = JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return `restore: ${GZ_LIST} is not JSON`
  }
  for (const p of Array.isArray(list) ? list : []) {
    // only the paths the backup writes, and no way out of them
    if (typeof p !== 'string' || p.split('/').includes('..') || !/^(home|claude\/projects)\//.test(p))
      continue
    const gz = join(ws, `${p}.gz`)
    if (!existsSync(gz)) continue
    writeFileSync(join(ws, p), gunzipSync(readFileSync(gz)))
    rmSync(gz)
  }
  rmSync(f)
}

/**
 * Snapshot and push. Refuses when the home is not ready (an empty home must not replace a good backup) and when
 * the secret scan cannot run (nothing stays staged). It never forces a push. scrub redacts each secret it finds.
 * The result goes to home/backup.json.
 * `lock` guards the snapshot only: the memory snapshot and the add into the index. The scan, the redaction, the
 * gzip, the commit and the push read the index only, so they run after the lock is free (d289.21).
 * When it takes the lock, it removes backup.want, so the ticks start again.
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
  let redacted: string[] = []
  const held = lock()
  if (!held) return { skipped: 'lock' }
  rmSync(backupWant(join(cfg.ws, 'home')), { force: true })
  let release: (() => void) | undefined = held
  const free = () => {
    release?.()
    release = undefined
  }
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
    const staged: Staged[] = []
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const m = /^:\d+ (\d+) \S+ (\S+) /.exec(raw[i]!)
      if (m && m[1]!.startsWith('100')) staged.push({ mode: m[1]!, path: raw[i + 1]!, blob: m[2]! }) // regular files, no gitlink
    }
    // the blobs are in the object store now: a tick can change the home files again
    free()
    const scan = scrub(cfg, staged)
    if ('error' in scan) {
      git(cfg, ['reset', '-q'])
      return fail(scan.error)
    }
    redacted = scan.redacted
    const gz = gzipBig(cfg)
    if (gz) {
      git(cfg, ['reset', '-q'])
      return fail(gz)
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
    free()
  }
  try {
    // d289.20: local commits that the remote refused (for example GH001) must not go up again.
    // If the remote tip is absent or an ancestor of HEAD, push one commit of the HEAD tree on that tip
    const tip = remoteTip(cfg)
    if (tip && typeof tip === 'object') return fail(tip.error)
    const parent = git(cfg, ['rev-parse', '--verify', '-q', 'HEAD^']).out
    const behind = !tip || git(cfg, ['merge-base', '--is-ancestor', tip, 'HEAD']).ok
    if (behind && tip !== sha && parent !== (tip ?? '')) {
      const msg = git(cfg, ['log', '-1', '--format=%B', 'HEAD']).out
      const c = git(cfg, ['commit-tree', 'HEAD^{tree}', ...(tip ? ['-p', tip] : []), '-m', msg])
      if (!c.ok) return fail(`git commit-tree: ${c.err}`)
      git(cfg, ['update-ref', `refs/heads/${cfg.branch}`, c.out])
      sha = c.out
    }
    const push = git(cfg, ['push', '-q', remote, `HEAD:refs/heads/${cfg.branch}`], PUSH_MS)
    if (!push.ok) return fail(`git push: ${push.err.split('\n').at(-1)}`)
    // blob sizes come from the tree: a file that left the work tree after the commit cannot break this
    const tree = git(cfg, ['ls-tree', '-r', '-l', 'HEAD']).out.split('\n').filter(Boolean)
    const bytes = tree.reduce((n, l) => n + (Number((l.split('\t')[0] ?? '').trim().split(/\s+/)[3]) || 0), 0)
    const o = { sha, changed: dirty, ...(redacted.length && { redacted }) }
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
    // the backup writes only home/ and claude/projects/: any other path (backup.git/config, claude/CLAUDE.md, skills, .bashrc) is not ours
    const outside = names.out
      .split('\0')
      .filter(n => n && !n.startsWith('home/') && !n.startsWith('claude/projects/'))
    if (outside.length)
      return {
        error: `restore refused: the branch holds paths outside home/ and claude/projects/: ${outside.slice(0, 5).join(', ')}`,
      }
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
    const gz = gunzipBig(cfg.ws)
    if (gz) return { error: gz }
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
    writeFileSync(
      join(cfg.ws, 'home', '.migrated'),
      `restored ${sha}${cfg.launch ? ` launch=${cfg.launch}` : ''}\n`,
    )
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
