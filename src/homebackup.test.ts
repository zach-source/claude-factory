import { afterEach, expect, test } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authEnv,
  backup,
  backupAge,
  backupWant,
  backupWanted,
  EXCLUDES,
  restore,
  SECRETS,
  secretFile,
  type BackupCfg,
} from './homebackup'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'homebackup-'))
  dirs.push(d)
  return d
}
const sh = (...a: string[]) => {
  const p = Bun.spawnSync(['git', ...a])
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}
const remote = () => {
  const d = tmp()
  sh('init', '-q', '--bare', d)
  return d
}
const put = (f: string, s = 'x') => {
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, s)
}
const SLUG = '-workspace-w'
/** a manager workspace: home/ and the Claude config dir, with one session */
function workspace() {
  const ws = tmp()
  const home = join(ws, 'home')
  put(join(home, 'rigs.json'), '[{"name":"acme"}]')
  put(join(home, 'runs', 'r1', 'state.json'), '{}')
  put(join(home, 'memory', 'a.md'), 'note')
  put(join(home, 'decisions.json'), '[]')
  put(join(home, 'metrics.jsonl'), '{}\n')
  put(join(home, 'manager-sessions.json'), JSON.stringify([{ session: 's1', cwd: '/workspace/w' }]))
  put(join(ws, 'claude', 'projects', SLUG, 's1.jsonl'), '{"a":1}\n')
  put(join(ws, 'claude', 'projects', SLUG, 'memory', 'm.md'), 'mem')
  put(join(ws, 'claude', '.credentials.json'), 'login')
  return ws
}
const cfg = (ws: string, r: string | undefined): BackupCfg => ({ ws, remote: r, branch: 'manager-home' })
const empty = () => {
  const ws = tmp()
  mkdirSync(join(ws, 'home'))
  return ws
}

test('d289.19: a staged file over 50 MB goes up as <path>.gz and comes back byte-equal; a small file stays plain', () => {
  const r = remote()
  const a = workspace()
  const line = (i: number) => `{"n":${i},"text":"metrics line ${i} ünï ✓"}\n`
  const big = Buffer.from(Array.from({ length: 1_400_000 }, (_, i) => line(i)).join(''))
  expect(big.length).toBeGreaterThan(60 * 1024 * 1024)
  writeFileSync(join(a, 'home', 'metrics.jsonl'), big)
  const session = join(a, 'claude', 'projects', SLUG, 's1.jsonl')
  writeFileSync(session, big)
  const out = backup(cfg(a, r), true)
  expect(out.error).toBeUndefined()
  expect(out.sha).toBeTypeOf('string')
  expect(out.sha).not.toBe('')
  const tree = sh('--git-dir', r, 'ls-tree', '-r', '-l', 'manager-home')
  expect(tree).toContain('\thome/metrics.jsonl.gz')
  expect(tree).toContain(`\tclaude/projects/${SLUG}/s1.jsonl.gz`)
  expect(tree).not.toContain('\thome/metrics.jsonl\n')
  expect(tree).toContain('\thome/rigs.json\n')
  // no blob in the pushed tree is over 50 MB
  for (const l of tree.split('\n')) expect(Number(l.split(/\s+/)[3]) || 0).toBeLessThan(50 * 1024 * 1024)
  // A second backup with the same files makes no commit.
  const tip = sh('--git-dir', r, 'rev-parse', 'manager-home')
  expect(tip).toBe(out.sha!)
  const second = backup(cfg(a, r), true)
  expect(second.error).toBeUndefined()
  expect(second.sha).toBeTypeOf('string')
  expect(second.sha).not.toBe('')
  expect(second.sha).toBe(out.sha)
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(tip)
  expect(second.changed).toBe(false)
  const b = empty()
  expect(restore(cfg(b, r)).error).toBeUndefined()
  expect(readFileSync(join(b, 'home', 'metrics.jsonl')).equals(big)).toBe(true)
  expect(readFileSync(join(b, 'claude', 'projects', SLUG, 's1.jsonl')).equals(big)).toBe(true)
  expect(readFileSync(join(b, 'home', 'rigs.json'), 'utf8')).toBe('[{"name":"acme"}]')
  for (const f of ['home/metrics.jsonl.gz', 'home/.backup-gz.json'])
    expect(existsSync(join(b, f))).toBe(false)
}, 120_000)

test('d289.21: backup.want is fresh for 10 min; the backup removes it at the lock and scans after the lock is free', () => {
  const r = remote()
  const ws = workspace()
  const home = join(ws, 'home')
  expect(backupWanted(home)).toBe(false)
  writeFileSync(backupWant(home), '')
  expect(backupWanted(home)).toBe(true)
  expect(backupWanted(home, Date.now() + 601_000)).toBe(false)
  // a gitleaks stand-in that marks when it runs and finds nothing
  const mark = join(tmp(), 'scanned')
  const bin = join(tmp(), 'gitleaks')
  writeFileSync(bin, `#!/bin/sh\ntouch '${mark}'\necho '[]'\n`, { mode: 0o755 })
  const seen: string[] = []
  const lock = () => {
    seen.push(`take want=${existsSync(backupWant(home))}`)
    return () => {
      put(join(home, 'decisions.json'), '[3]')
      seen.push(`free scanned=${existsSync(mark)}`)
    }
  }
  const out = backup({ ...cfg(ws, r), gitleaks: bin }, true, lock)
  expect(out.error).toBeUndefined()
  expect(seen).toEqual(['take want=true', 'free scanned=false'])
  expect(existsSync(mark)).toBe(true)
  expect(existsSync(backupWant(home))).toBe(false)
  // a home change after the lock is free does not go into this commit
  expect(pushedFile(r, 'home/decisions.json')).toBe('[]')
})

test('d289.20: after the remote rejects a commit, the next backup pushes a fixed tree without that commit', () => {
  const r = remote()
  // like GH001: refuse a push when any new commit holds home/huge.txt
  const hook = join(r, 'hooks', 'pre-receive')
  writeFileSync(
    hook,
    '#!/bin/sh\nwhile read old new ref; do\n' +
      '  for c in $(git rev-list "$new" --not --all); do\n' +
      '    git ls-tree -r --name-only "$c" | grep -qx home/huge.txt && { echo "GH001 large file" >&2; exit 1; }\n' +
      '  done\ndone\nexit 0\n',
    { mode: 0o755 },
  )
  for (const first of [true, false]) {
    const rr = first ? r : remote()
    if (!first) expect(Bun.spawnSync(['cp', hook, join(rr, 'hooks', 'pre-receive')]).exitCode).toBe(0)
    const a = workspace()
    // the second pass starts with a good backup on the remote
    const initial = first ? null : backup(cfg(a, rr), true)
    if (initial) {
      expect(initial.error).toBeUndefined()
      expect(initial.skipped).toBeUndefined()
      expect(initial.sha).toBeTruthy()
    }
    const good = initial?.sha ?? null
    put(join(a, 'home', 'huge.txt'), 'too big')
    const refused = backup(cfg(a, rr), true)
    expect(refused.error).toContain('git push')
    const failedRecord = JSON.parse(readFileSync(join(a, 'home/backup.json'), 'utf8'))
    expect(failedRecord.sha).toBe(good ?? undefined)
    expect(failedRecord.error).toBe(refused.error)
    const rejected = sh('--git-dir', join(a, 'backup.git'), 'rev-parse', 'HEAD')
    rmSync(join(a, 'home', 'huge.txt'))
    put(join(a, 'home', 'decisions.json'), '[1]')
    const out = backup(cfg(a, rr), true)
    expect(out.error).toBeUndefined()
    expect(out.skipped).toBeUndefined()
    expect(out.sha).toBeTruthy()
    expect(out.sha).toBe(sh('--git-dir', rr, 'rev-parse', 'manager-home'))
    const parents = sh('--git-dir', rr, 'rev-list', '--parents', '-n', '1', 'manager-home')
      .split(' ')
      .slice(1)
    expect(parents).toEqual(good ? [good] : [])
    expect(pushedFile(rr, 'home/decisions.json')).toBe('[1]')
    // a later backup goes on top as usual
    put(join(a, 'home', 'decisions.json'), '[2]')
    const next = backup(cfg(a, rr), true)
    expect(next.error).toBeUndefined()
    expect(next.skipped).toBeUndefined()
    expect(next.sha).toBeTruthy()
    expect(sh('--git-dir', rr, 'rev-parse', 'manager-home^')).toBe(out.sha!)
    expect(next.changed).toBe(true)
    expect(next.sha).toBe(sh('--git-dir', rr, 'rev-parse', 'manager-home'))
    expect(pushedFile(rr, 'home/decisions.json')).toBe('[2]')
    const ancestors = sh('--git-dir', join(a, 'backup.git'), 'rev-list', next.sha!).split('\n')
    expect(ancestors).not.toContain(rejected)
    if (good) expect(ancestors).toContain(good)
  }
})

test('ohn03: a memory index update must not hide a racy home edit', () => {
  const r = remote()
  const ws = workspace()
  const file = join(ws, 'home/decisions.json')
  const gd = join(ws, 'backup.git')
  const time = new Date('2000-01-01T00:00:00Z')
  put(file, '[1]')
  utimesSync(file, time, time)
  const first = backup(cfg(ws, r), true)
  expect(first.error).toBeUndefined()
  expect(first.skipped).toBeUndefined()
  expect(first.sha).toBeTruthy()
  // Model a coarse stat cache. The index time makes this entry racy, so Git must read its content.
  sh('--git-dir', gd, 'config', 'core.checkStat', 'minimal')
  sh('--git-dir', gd, 'config', 'core.trustctime', 'false')
  utimesSync(join(gd, 'index'), time, time)
  put(file, '[2]')
  utimesSync(file, time, time)
  const control = join(gd, 'control.index')
  copyFileSync(join(gd, 'index'), control)
  utimesSync(control, time, time)
  const add = Bun.spawnSync(['git', '--git-dir', gd, '--work-tree', ws, 'add', '-A', '--', 'home'], {
    env: { ...process.env, GIT_INDEX_FILE: control },
  })
  expect(add.exitCode).toBe(0)
  const blob = sh('--git-dir', gd, 'hash-object', file)
  expect(
    Bun.spawnSync(['git', '--git-dir', gd, 'show', ':home/decisions.json'], {
      env: { ...process.env, GIT_INDEX_FILE: control },
    }).stdout.toString(),
  ).toBe('[2]')
  const next = backup(cfg(ws, r), true)
  expect(next.error).toBeUndefined()
  expect(next.skipped).toBeUndefined()
  expect(next.changed).toBe(true)
  expect(next.sha).toBe(sh('--git-dir', r, 'rev-parse', 'manager-home'))
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home^')).toBe(first.sha!)
  expect(pushedFile(r, 'home/decisions.json')).toBe('[2]')
  expect(sh('--git-dir', gd, 'rev-parse', 'HEAD:home/decisions.json')).toBe(blob)
  const same = backup(cfg(ws, r), true)
  expect(same.error).toBeUndefined()
  expect(same.changed).toBe(false)
  expect(same.sha).toBe(next.sha)
  expect(JSON.parse(readFileSync(join(ws, 'home/backup.json'), 'utf8'))).toMatchObject({
    sha: next.sha,
    error: '',
  })
})

test('AC1: a backup restores into an empty home with the same state', () => {
  const r = remote()
  const a = workspace()
  const out = backup(cfg(a, r), true)
  expect(out.error).toBeUndefined()
  expect(out.sha).toBe(sh('--git-dir', r, 'rev-parse', 'manager-home'))
  const b = empty()
  const got = restore(cfg(b, r))
  expect(got.restored).toBe(out.sha)
  for (const f of [
    'home/rigs.json',
    'home/runs/r1/state.json',
    'home/memory/a.md',
    'home/decisions.json',
    'home/metrics.jsonl',
    'home/manager-sessions.json',
    `claude/projects/${SLUG}/s1.jsonl`,
    `claude/projects/${SLUG}/memory/m.md`,
  ])
    expect(readFileSync(join(b, f), 'utf8')).toBe(readFileSync(join(a, f), 'utf8'))
  expect(readFileSync(join(b, 'home', '.migrated'), 'utf8')).toBe(`restored ${out.sha}\n`)
  // the next backup from the restored home pushes on top
  put(join(b, 'home', 'memory', 'b.md'), 'more')
  expect(backup(cfg(b, r), true).error).toBeUndefined()
})

test('AC2: the login files, locks, bin, devenv, logs and rigs.json backups stay out', () => {
  const r = remote()
  const ws = workspace()
  const never = [
    'home/.claude.json',
    'home/.credentials.json',
    `claude/projects/${SLUG}/memory/settings.json`,
    'home/rigs.json.bak',
    'home/tick.lock',
    'home/gc.lock',
    'home/bin/factory',
    'home/devenv/x',
    'home/herdr.log',
    'home/backup.json',
    'home/beads/acme/.beads/x',
    'home/runs/r1/worktrees/acme/f.txt',
    `claude/.credentials.json`,
    `claude/projects/${SLUG}/other.jsonl`,
  ]
  for (const f of never) put(join(ws, f), 'x')
  put(join(ws, 'home/settings.json'), '{}')
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
  const files = sh('--git-dir', r, 'ls-tree', '-r', '--name-only', 'manager-home').split('\n')
  for (const f of never) expect(files).not.toContain(f)
  expect(files).toContain('home/rigs.json')
  expect(files).toContain('home/settings.json')
})

test('AC2: each exclude rule is needed', () => {
  // a rule removed from EXCLUDES lets its file in
  const rules = EXCLUDES.filter(x => !x.startsWith('#'))
  expect(rules.length).toBeGreaterThanOrEqual(10)
  const probes: Record<string, string> = {
    '.claude.json': 'home/.claude.json',
    '.credentials.json': 'home/.credentials.json',
    '/claude/**/settings*.json': `claude/projects/${SLUG}/memory/settings.json`,
    'rigs.json.*': 'home/rigs.json.bak',
    '*.lock': 'home/tick.lock',
    '/home/bin/': 'home/bin/factory',
    '/home/devenv/': 'home/devenv/x',
    '/home/herdr.log': 'home/herdr.log',
    '/home/backup.json': 'home/backup.json',
    '/home/manager-host.log': 'home/manager-host.log',
    '/home/ui-cache/': 'home/ui-cache/rig.json',
    '/home/beads/': 'home/beads/acme/.beads/x',
    '/home/steps/': 'home/steps/patrol/.claude/x',
    'worktrees/': 'home/runs/r1/worktrees/acme/f.txt',
  }
  for (const [rule, file] of Object.entries(probes)) {
    expect(rules).toContain(rule)
    const r = remote()
    const ws = workspace()
    put(join(ws, file), 'x')
    expect(backup({ ...cfg(ws, r), excludes: rules.filter(x => x !== rule) }, true).error).toBeUndefined()
    expect(sh('--git-dir', r, 'ls-tree', '-r', '--name-only', 'manager-home').split('\n')).toContain(file)
  }
})

// a fake token with enough entropy for the gitleaks github-pat rule
const TOKEN = 'ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5'
const pushedFile = (r: string, path: string) => sh('--git-dir', r, 'show', `manager-home:${path}`)

test('d289.19: gitleaks finds secrets in the staged blobs; the push has them redacted, the work tree keeps them', () => {
  const r = remote()
  const ws = workspace()
  const leak = `line one\n  token=${TOKEN} end\n`
  put(join(ws, 'home', 'memory', 'leak.md'), leak)
  const auth = Buffer.from(`x:${TOKEN}`).toString('base64')
  const docker = Buffer.from(JSON.stringify({ auths: { 'ghcr.io': { auth } } })).toString('base64')
  put(join(ws, 'home', 'runs', 'r1', 'pull.json'), `{".dockerconfigjson":"${docker}"}\n`)
  const pg = 'postgres://postgres:postgres@localhost:5432/db\n'
  put(join(ws, 'home', 'runs', 'r1', 'prompt.md'), pg)
  const out = backup(cfg(ws, r), true)
  expect(out.error).toBeUndefined()
  expect(pushedFile(r, 'home/memory/leak.md')).toBe('line one\n  token=[REDACTED] end')
  expect(pushedFile(r, 'home/runs/r1/pull.json')).toBe('{".dockerconfigjson":"[REDACTED]"}')
  expect(pushedFile(r, 'home/runs/r1/prompt.md')).toBe(pg.trim())
  expect(readFileSync(join(ws, 'home', 'memory', 'leak.md'), 'utf8')).toBe(leak)
  // the log names the rule and the path, never the value
  expect(out.redacted).toContain('github-pat home/memory/leak.md')
  expect(out.redacted!.some(x => x.endsWith(' home/runs/r1/pull.json'))).toBe(true)
  expect(JSON.stringify(out)).not.toContain(TOKEN)
  expect(JSON.stringify(out)).not.toContain(docker)
})

test('d289.19: a file over 1 MB, a secret past the first chunk, multibyte chars before it: all redacted', () => {
  const r = remote()
  const ws = workspace()
  const body = 'MIIEowIBAAKCAQEA7q9Zx3Lk2Vb8Hn4Rt6Yp1Ws5Dq0Fj3Gm8Kc2Xe7Ua9Ni4Ho6Bl1Tv5Rz3Qy8Pw2Js0'
  const key = `-----BEGIN RSA PRIVATE KEY-----\\n${body}\\n${body}\\n-----END RSA PRIVATE KEY-----`
  const filler = Array.from({ length: 30_000 }, (_, i) => `{"n":${i},"text":"plain metrics line ${i}"}`).join(
    '\n',
  )
  const long = `{"note":"${'ünïcødé ✓ — '.repeat(800)}","key":"${key}","t":"${TOKEN}"}`
  const big = `${filler}\n${long}\n${filler}\n{"last":"ëñd ${TOKEN}"}\n`
  expect(Buffer.byteLength(big)).toBeGreaterThan(1_000_000)
  put(join(ws, 'home', 'metrics.jsonl'), big)
  const out = backup(cfg(ws, r), true)
  expect(out.error).toBeUndefined()
  const got = pushedFile(r, 'home/metrics.jsonl')
  expect(got).not.toContain(TOKEN)
  expect(got).not.toContain(body)
  expect(got).toContain(`{"last":"ëñd [REDACTED]"}`)
  expect(got).toContain(`${'ünïcødé ✓ — '.repeat(800)}","key":"`)
  expect(got.split('\n').length).toBe(big.trim().split('\n').length) // no other text is lost
  expect(JSON.stringify(out)).not.toContain(body)
})

test('d289.19: with no gitleaks the backup refuses, and nothing stays staged', () => {
  const r = remote()
  const ws = workspace()
  expect(backup({ ...cfg(ws, r), gitleaks: '/no/gitleaks' }, true).error).toBe(
    'backup refused: gitleaks is missing',
  )
  expect(sh('--git-dir', join(ws, 'backup.git'), 'ls-files')).toBe('')
  const good = backup(cfg(ws, r), true)
  expect(good.error).toBeUndefined()
  put(join(ws, 'home/decisions.json'), '[1]')
  const refused = backup({ ...cfg(ws, r), gitleaks: '/no/gitleaks' }, true)
  expect(refused.error).toBe('backup refused: gitleaks is missing')
  expect(JSON.parse(readFileSync(join(ws, 'home/backup.json'), 'utf8'))).toMatchObject({
    sha: good.sha,
    error: refused.error,
  })
})

test('secretFile finds the usual token shapes and no plain text', () => {
  const hit = [
    'ghp_' + 'a'.repeat(36),
    'github_pat_' + 'a'.repeat(30),
    'sk-ant-' + 'a'.repeat(30),
    'AKIA' + 'A'.repeat(16),
    'xoxb-1234567890-abcdef',
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    'Authorization: Basic ' + 'QUJD'.repeat(6),
  ]
  for (const s of hit) expect(secretFile(Buffer.from(`x ${s} y`))).toBe(true)
  expect(secretFile(Buffer.from('plain notes about ghp and sk'))).toBe(false)
})

test('AC4: an unready home never pushes, and a rejected push never forces', () => {
  const r = remote()
  const ws = workspace()
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
  const good = sh('--git-dir', r, 'rev-parse', 'manager-home')
  const e = empty()
  expect(backup(cfg(e, r), false).error).toContain('not ready')
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(good)
  // someone else moved the branch: a second workspace with the same remote has diverged history
  const other = workspace()
  expect(backup(cfg(other, remote()), true).error).toBeUndefined() // local history, not the remote's
  expect(backup(cfg(other, r), true).error).toContain('git push')
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(good)
})

test('a restore for a launch writes its launch id into .migrated', () => {
  const r = remote()
  const out = backup(cfg(workspace(), r), true)
  const b = empty()
  expect(restore({ ...cfg(b, r), launch: 'id-1' }).restored).toBe(out.sha)
  expect(readFileSync(join(b, 'home', '.migrated'), 'utf8')).toBe(`restored ${out.sha} launch=id-1\n`)
})

test('AC5: restore does nothing to a used home', () => {
  const r = remote()
  expect(backup(cfg(workspace(), r), true).error).toBeUndefined()
  for (const f of ['rigs.json', 'runs/x/state.json', '.migrated']) {
    const ws = empty()
    put(join(ws, 'home', f), 'mine')
    const out = restore(cfg(ws, r))
    expect(out.restored).toBeUndefined()
    expect(out.skipped).toBe('used')
    expect(readFileSync(join(ws, 'home', f), 'utf8')).toBe('mine')
    expect(existsSync(join(ws, 'home', 'memory'))).toBe(false)
  }
})

test('AC6: no remote and no branch fall back without an error', () => {
  const ws = empty()
  expect(restore(cfg(ws, undefined)).skipped).toBe('no remote')
  expect(backup(cfg(workspace(), undefined), true).skipped).toBe('no remote')
  const out = restore(cfg(ws, remote()))
  expect(out.skipped).toBe('no backup')
  expect(existsSync(join(ws, 'home', '.migrated'))).toBe(false)
})

const G = ['-c', 'user.name=t', '-c', 'user.email=t@x']
const memGit = (ws: string, ...x: string[]) => sh('-C', join(ws, 'home', 'memory'), ...G, ...x)
const tree = (r: string) => sh('--git-dir', r, 'ls-tree', '-r', '--name-only', 'manager-home').split('\n')
const pushed = (r: string) =>
  Bun.spawnSync(['git', '--git-dir', r, 'rev-parse', '--verify', 'manager-home']).exitCode === 0

test('AC10: a memory repo with commits, uncommitted notes and a .gitignore backs up as plain files', () => {
  const r = remote()
  const a = workspace()
  memGit(a, 'init', '-q')
  put(join(a, 'home', 'memory', '.gitignore'), 'skip.md\n')
  memGit(a, 'add', '-A')
  memGit(a, 'commit', '-q', '-m', 'one')
  put(join(a, 'home', 'memory', 'new.md'), 'uncommitted')
  put(join(a, 'home', 'memory', 'skip.md'), 'ignored')
  const out = backup(cfg(a, r), true)
  expect(out.error).toBeUndefined()
  const files = tree(r)
  expect(files).toContain('home/memory/a.md')
  expect(files).toContain('home/memory/new.md')
  expect(files).toContain('home/memory/.gitignore')
  expect(files).not.toContain('home/memory/skip.md')
  expect(files.some(f => f.includes('.git/') || f.endsWith('memory.bundle'))).toBe(false)
  const b = empty()
  expect(restore(cfg(b, r)).restored).toBe(out.sha)
  expect(readFileSync(join(b, 'home', 'memory', 'new.md'), 'utf8')).toBe('uncommitted')
  expect(existsSync(join(b, 'home', 'memory', 'skip.md'))).toBe(false)
  // the next backup from the restored home pushes on top
  put(join(b, 'home', 'memory', 'more.md'), 'm')
  expect(backup(cfg(b, r), true).error).toBeUndefined()
})

test('AC11: plain memory files, then git init, then a second backup, then restore', () => {
  const r = remote()
  const a = workspace()
  expect(backup(cfg(a, r), true).error).toBeUndefined()
  expect(tree(r)).toContain('home/memory/a.md')
  memGit(a, 'init', '-q')
  memGit(a, 'add', '-A')
  memGit(a, 'commit', '-q', '-m', 'one')
  put(join(a, 'home', 'memory', 'b.md'), 'b')
  const out = backup(cfg(a, r), true)
  expect(out.error).toBeUndefined()
  expect(tree(r).filter(f => f.startsWith('home/memory'))).toEqual(['home/memory/a.md', 'home/memory/b.md'])
  const b = empty()
  expect(restore(cfg(b, r)).restored).toBe(out.sha)
  expect(existsSync(join(b, 'home', 'memory', '.git'))).toBe(true)
  expect(readFileSync(join(b, 'home', 'memory', 'a.md'), 'utf8')).toBe('note')
  expect(readFileSync(join(b, 'home', 'memory', 'b.md'), 'utf8')).toBe('b')
})

test('AC12: a token in an old memory commit is not in the remote tree, a token in a work tree file stops the push', () => {
  const r = remote()
  const a = workspace()
  const token = 'ghp_' + 'a'.repeat(36)
  memGit(a, 'init', '-q')
  put(join(a, 'home', 'memory', 'leak.md'), token)
  memGit(a, 'add', '-A')
  memGit(a, 'commit', '-q', '-m', 'one')
  put(join(a, 'home', 'memory', 'leak.md'), 'clean')
  memGit(a, 'commit', '-q', '-am', 'two')
  expect(backup(cfg(a, r), true).error).toBeUndefined()
  const g = Bun.spawnSync(['git', '--git-dir', r, 'grep', '-q', token, 'manager-home'])
  expect(g.exitCode).toBe(1) // 1 means no blob holds the token
})

test('AC12: a token in a work tree memory file, binary too, is redacted in the push', () => {
  for (const head of [Buffer.alloc(0), Buffer.from([0, 1, 2, 0])]) {
    const r = remote()
    const a = workspace()
    memGit(a, 'init', '-q')
    writeFileSync(join(a, 'home', 'memory', 'x.bin'), Buffer.concat([head, Buffer.from(TOKEN)]))
    const out = backup(cfg(a, r), true)
    expect(out.redacted).toEqual(['github-pat home/memory/x.bin'])
    const g = Bun.spawnSync(['git', '--git-dir', r, 'grep', '-q', '-a', TOKEN, 'manager-home'])
    expect(g.exitCode).toBe(1) // 1 means no blob holds the token
  }
})

test('AC13: a restore marker makes restore run again, and blocks a backup until it ends', () => {
  const r = remote()
  const out = backup(cfg(workspace(), r), true)
  const b = empty()
  put(join(b, 'home', 'rigs.json'), 'part') // a crash after a part checkout
  put(join(b, 'home', '.restoring'), '')
  expect(backup(cfg(b, remote()), true).error).toContain('restore')
  expect(restore(cfg(b, r)).restored).toBe(out.sha)
  expect(existsSync(join(b, 'home', '.restoring'))).toBe(false)
  expect(readFileSync(join(b, 'home', 'rigs.json'), 'utf8')).toBe('[{"name":"acme"}]')
  // no marker, rigs.json there: the home counts as used again
  expect(restore(cfg(b, r)).skipped).toBe('used')
})

test('AC13: a failed restore keeps the marker, and the home is not ready', () => {
  const r = remote()
  const out = backup(cfg(workspace(), r), true)
  const b = empty()
  put(join(b, 'home', 'memory', '.git'), 'not a repo') // the memory step fails after the checkout
  const got = restore(cfg(b, r))
  expect(got.error).toBeDefined()
  expect(existsSync(join(b, 'home', '.restoring'))).toBe(true)
  rmSync(join(b, 'home', 'memory', '.git'))
  expect(restore(cfg(b, r)).restored).toBe(out.sha)
})

test('AC14: after a restore the last dream commit time equals home/memory-dream.at', () => {
  const r = remote()
  const a = workspace()
  memGit(a, 'init', '-q')
  memGit(a, 'add', '-A')
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
    GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
  }
  const c = Bun.spawnSync(
    ['git', '-C', join(a, 'home', 'memory'), ...G, 'commit', '-q', '-m', 'dream: notes'],
    { env },
  )
  expect(c.exitCode).toBe(0)
  expect(backup(cfg(a, r), true).error).toBeUndefined()
  const at = readFileSync(join(a, 'home', 'memory-dream.at'), 'utf8').trim()
  expect(at).toBe(String(Date.parse('2026-01-02T03:04:05Z') / 1000))
  const b = empty()
  expect(restore(cfg(b, r)).restored).toBeDefined()
  expect(sh('-C', join(b, 'home', 'memory'), 'log', '-1', '--grep=^dream:', '--format=%at')).toBe(at)
  // a backup of the restored home keeps the value
  expect(backup(cfg(b, r), true).error).toBeUndefined()
  expect(readFileSync(join(b, 'home', 'memory-dream.at'), 'utf8').trim()).toBe(at)
})

test('AC15: manager-host.log is not in the tree', () => {
  const r = remote()
  const a = workspace()
  put(join(a, 'home', 'manager-host.log'), 'line')
  expect(backup(cfg(a, r), true).error).toBeUndefined()
  expect(tree(r)).not.toContain('home/manager-host.log')
})

test('a failing remote is an error in restore, an empty remote is "no backup"', () => {
  const ws = empty()
  const out = restore(cfg(ws, join(tmp(), 'missing.git')))
  expect(out.error).toBeDefined()
  expect(out.skipped).toBeUndefined()
  expect(restore(cfg(ws, remote())).skipped).toBe('no backup')
  // a remote that works after the failure restores
  const r = remote()
  expect(backup(cfg(workspace(), r), true).error).toBeUndefined()
  expect(restore(cfg(ws, r)).restored).toBeDefined()
})

test('a first backup after a skipped restore goes on top of the remote branch', () => {
  const r = remote()
  const first = backup(cfg(workspace(), r), true)
  const b = workspace() // migrated by hand: no local history, the remote has a branch
  put(join(b, 'home', 'memory', 'new.md'), 'n')
  const out = backup(cfg(b, r), true)
  expect(out.error).toBeUndefined()
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(out.sha!)
  expect(sh('--git-dir', r, 'merge-base', '--is-ancestor', first.sha!, out.sha!)).toBe('')
})

test('the lock is free during the push, and a held lock skips the backup', () => {
  const r = remote()
  const ws = workspace()
  expect(backup(cfg(ws, r), true, () => null).skipped).toBe('lock')
  let pushedAtRelease: boolean | undefined
  const out = backup(cfg(ws, r), true, () => () => {
    pushedAtRelease =
      Bun.spawnSync(['git', '--git-dir', r, 'rev-parse', '--verify', 'manager-home']).exitCode === 0
  })
  expect(out.error).toBeUndefined()
  expect(pushedAtRelease).toBe(false) // released before the push
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(out.sha!)
})

test('the file and byte counts come from the tree', () => {
  const r = remote()
  const ws = workspace()
  const out = backup(cfg(ws, r), true)
  expect(out.error).toBeUndefined()
  const j = JSON.parse(readFileSync(join(ws, 'home', 'backup.json'), 'utf8'))
  expect(j.files).toBeGreaterThan(0)
  expect(j.bytes).toBeGreaterThan(0)
})

test('a backup with no change makes no commit; backup.json records the last run', () => {
  const r = remote()
  const ws = workspace()
  const a = backup(cfg(ws, r), true)
  const b = backup(cfg(ws, r), true)
  expect(b.sha).toBe(a.sha)
  expect(b.changed).toBe(false)
  const j = JSON.parse(readFileSync(join(ws, 'home', 'backup.json'), 'utf8'))
  expect(j.sha).toBe(a.sha)
  expect(backupAge(join(ws, 'home'), Date.parse(j.at) + 5000)).toBe(5000)
  expect(backupAge(tmp(), Date.now())).toBeUndefined()
})

test('restore refuses a branch that holds excluded paths and writes nothing', () => {
  const r = remote()
  const src = workspace()
  expect(backup(cfg(src, r), true).error).toBeUndefined()
  // a worker pushes a tree with Claude hooks and a bin on top of the good branch
  const w = tmp()
  sh('clone', '-q', '-b', 'manager-home', r, w)
  put(join(w, 'claude', 'settings.json'), '{"hooks":{}}')
  put(join(w, 'home', 'bin', 'factory'), '#!/bin/sh')
  sh('-C', w, ...G, 'add', '-Af', '.')
  sh('-C', w, ...G, 'commit', '-q', '-m', 'x')
  sh('-C', w, 'push', '-q', 'origin', 'manager-home')
  const ws = empty()
  const out = restore(cfg(ws, r))
  expect(out.restored).toBeUndefined()
  expect(out.error).toContain('claude/settings.json')
  expect(existsSync(join(ws, 'claude', 'settings.json'))).toBe(false)
  expect(existsSync(join(ws, 'home', '.restoring'))).toBe(false)
  expect(existsSync(join(ws, 'home', 'rigs.json'))).toBe(false)
})

test('restore refuses paths outside home/ and claude/projects/', () => {
  const r = remote()
  const src = workspace()
  expect(backup(cfg(src, r), true).error).toBeUndefined()
  const w = tmp()
  sh('clone', '-q', '-b', 'manager-home', r, w)
  put(join(w, 'backup.git', 'config'), '[core]\n\tfsmonitor = false\n')
  put(join(w, 'claude', 'CLAUDE.md'), 'x')
  put(join(w, 'claude', 'skills', 'x', 'SKILL.md'), 'x')
  sh('-C', w, ...G, 'add', '-Af', '.')
  sh('-C', w, ...G, 'commit', '-q', '-m', 'x')
  sh('-C', w, 'push', '-q', 'origin', 'manager-home')
  const ws = empty()
  const out = restore(cfg(ws, r))
  expect(out.restored).toBeUndefined()
  expect(out.error).toContain('backup.git/config')
  expect(existsSync(join(ws, 'claude', 'CLAUDE.md'))).toBe(false)
  expect(existsSync(join(ws, 'home', '.restoring'))).toBe(false)
  expect(existsSync(join(ws, 'home', 'rigs.json'))).toBe(false)
})

test('secretFile finds URL userinfo, JWT and the other vendor token shapes', () => {
  const hit = [
    'https://bob:hunter2pass@example.com/x',
    'eyJ' + 'a'.repeat(12) + '.eyJ' + 'b'.repeat(12) + '.sig',
    'sk-proj-' + 'a'.repeat(30),
    'lin_api_' + 'a'.repeat(30),
    'glpat-' + 'a'.repeat(24),
    'AIza' + 'a'.repeat(35),
    'ops_' + 'a'.repeat(40),
    'npm_' + 'a'.repeat(36),
    'xapp-1-ABCDEFGHIJ',
    'PRIVATE-TOKEN: ' + 'a'.repeat(20),
  ]
  for (const s of hit) expect(secretFile(Buffer.from('x ' + s + ' y'))).toBe(true)
  expect(secretFile(Buffer.from('see https://example.com/a and user@host'))).toBe(false)
})

const wrap = (s: string) => Buffer.from('x ' + s + ' y')
const timed = (b: Buffer) => {
  const t = performance.now()
  const got = secretFile(b)
  return { got, ms: performance.now() - t }
}

test('JWT shape: 1 MiB of eyJ text returns in under 1 s', () => {
  const r = timed(Buffer.from('eyJ'.repeat(349_526)))
  expect(r.got).toBe(false)
  expect(r.ms).toBeLessThan(1000)
})

test('JWT shape: 1 MiB of eyJa text returns in under 1 s', () => {
  const r = timed(Buffer.from('eyJa'.repeat(262_144)))
  expect(r.got).toBe(false)
  expect(r.ms).toBeLessThan(1000)
})

const tok = 'zq' + 'a'.repeat(20)

test('tlgw: secretFile finds a quoted Authorization header and an ASIA key id', () => {
  const hit = [
    `"Authorization": "Bearer ${tok}"`,
    `"Authorization":"Bearer ${tok}"`,
    `Authorization: "Bearer ${tok}"`,
    `'Authorization': 'Basic ${tok}'`,
    `"authorization": "bearer ${tok}"`,
    `Authorization: Bearer ${tok}`,
    'ASIA' + 'Z'.repeat(16),
  ]
  for (const s of hit) expect([s, secretFile(wrap(s))]).toEqual([s, true])
})

test('tlgw: secretFile leaves the near misses', () => {
  const miss = [
    '"Authorization": "Bearer short"',
    `"Authorization": "Token ${tok}"`,
    `Authorization = Bearer ${tok}`,
    `"Authorization"" : "Bearer ${tok}"`,
    'ASIA' + 'Z'.repeat(15),
    'AGPA' + 'Z'.repeat(16),
    'asia' + 'z'.repeat(16),
  ]
  for (const s of miss) expect([s, secretFile(wrap(s))]).toEqual([s, false])
})

test('tlgw: the Authorization and ASIA shapes return in under 1 s on 1 MiB', () => {
  const inputs = [
    '"Authorization": '.repeat(65_536),
    "\"Authorization'  :  '".repeat(52_429),
    ('ASIA' + 'Z'.repeat(15) + ' ').repeat(52_429),
  ]
  for (const s of inputs) {
    const r = timed(Buffer.from(s))
    expect(r.got).toBe(false)
    expect(r.ms).toBeLessThan(1000)
  }
})

test('JWT shape: real-shape JWTs match', () => {
  const jwt = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJ' + 'zdWIiOiIxMjM0In0' + '.' + 'sig'
  const long = 'eyJ' + 'a'.repeat(6000) + '.eyJ' + 'b'.repeat(6000) + '.sig'
  for (const s of [jwt, 'tok' + jwt, 'a-b_' + jwt, long]) expect(secretFile(wrap(s))).toBe(true)
})

test('JWT shape: near misses do not match', () => {
  const miss = [
    'eyJ' + 'a'.repeat(9) + '.eyJ' + 'b'.repeat(12) + '.',
    'eyJ' + 'a'.repeat(12) + '.eyJ' + 'b'.repeat(9) + '.',
    'eyJ' + 'a'.repeat(12) + '.eyJ' + 'b'.repeat(12),
    'eyJ' + 'a'.repeat(12) + '.xeyJ' + 'b'.repeat(12) + '.',
  ]
  for (const s of miss) expect(secretFile(wrap(s))).toBe(false)
  const r = timed(Buffer.from('.eyJ'.repeat(262_144)))
  expect(r.got).toBe(false)
  expect(r.ms).toBeLessThan(1000)
})

test('JWT shape: the new pattern agrees with the old one', () => {
  const old = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./
  const cur = SECRETS.find(p => p.source.includes('eyJ'))!
  const r = ((a: number) => () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  })(1)
  const al = ['eyJ', 'eyJ', 'eyJ', 'aaaa', 'aaaaaaaaaa', 'aaaaaaaaaa', '.', '.', 'x', ' ', '-', 'J']
  let hits = 0
  for (let i = 0; i < 20_000; i++) {
    const n = Math.floor(r() * 16)
    let s = ''
    for (let j = 0; j < n; j++) s += al[Math.floor(r() * al.length)]
    expect(cur.test(s)).toBe(old.test(s))
    if (old.test(s)) hits++
  }
  expect(hits).toBeGreaterThanOrEqual(20)
})

test('the scan reads the staged blob: a token in a binary memory file is redacted', () => {
  const r = remote()
  const ws = workspace()
  put(join(ws, 'home', 'memory', 'b.bin'), `a\0b ${TOKEN}`)
  const out = backup(cfg(ws, r), true)
  expect(out.error).toBeUndefined()
  expect(pushedFile(r, 'home/memory/b.bin')).toBe('a\0b [REDACTED]')
})

test('a nested repo at home/.git is refused, not saved as a gitlink', () => {
  const r = remote()
  const ws = workspace()
  sh('init', '-q', join(ws, 'home'))
  const out = backup(cfg(ws, r), true)
  expect(out.error).toContain('home/.git')
  expect(sh('--git-dir', r, 'branch', '--list')).toBe('')
})

test('a962: the backup auth header goes only to git calls under the backup remote, never to a log', async () => {
  const dir = tmp()
  const rec = join(dir, 'rec')
  writeFileSync(rec, '')
  const script =
    "const s=Bun.serve({port:0,fetch(r){require('fs').appendFileSync(process.env.REC_FILE,new URL(r.url).pathname+' '+(r.headers.get('authorization')??'none')+'\\n');return new Response('no',{status:404})}});console.log(s.port)"
  const srv = Bun.spawn(['bun', '-e', script], { env: { ...process.env, REC_FILE: rec }, stdout: 'pipe' })
  try {
    const port = Number(
      (
        await srv.stdout
          .getReader()
          .read()
          .then(r => Buffer.from(r.value!).toString())
      ).trim(),
    )
    const lines = () => readFileSync(rec, 'utf8').split('\n')
    const bin = join(tmp(), 'gitleaks')
    writeFileSync(bin, "#!/bin/sh\necho '[]'\n", { mode: 0o755 })
    const mk = () => {
      const ws = tmp()
      put(join(ws, 'home', 'rigs.json'), '[]')
      return ws
    }
    const url = `http://127.0.0.1:${port}/acme/widget.git`
    const ws = mk()
    const c = { ws, remote: url, branch: 'server-home', auth: 'eHE6enE=', gitleaks: bin }
    const out = backup(c, true)
    expect(lines().find(l => l.startsWith('/acme/widget.git/info/refs'))).toBe(
      '/acme/widget.git/info/refs Basic eHE6enE=',
    )
    expect(out.error ?? '').not.toContain('eHE6enE')
    expect(readFileSync(join(ws, 'home', 'backup.json'), 'utf8')).not.toContain('eHE6enE')
    // no auth: no header
    writeFileSync(rec, '')
    backup({ ...c, ws: mk(), auth: undefined }, true)
    expect(lines().find(l => l.startsWith('/acme/widget.git/info/refs'))).toBe(
      '/acme/widget.git/info/refs none',
    )
    // another URL on the same host gets none
    writeFileSync(rec, '')
    const ls = Bun.spawn(['git', 'ls-remote', `http://127.0.0.1:${port}/acme/other.git`], {
      env: { ...process.env, ...authEnv(c), GIT_TERMINAL_PROMPT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await ls.exited
    expect(lines().find(l => l.startsWith('/acme/other.git/info/refs'))).toBe(
      '/acme/other.git/info/refs none',
    )
    expect(authEnv({ ws, branch: 'b' })).toEqual({})
  } finally {
    srv.kill()
  }
})

/** a gitleaks stand-in that logs the size of each file it is given, then runs the real one */
function countingGitleaks() {
  const d = tmp()
  const log = join(d, 'sizes.log')
  const bin = join(d, 'gitleaks')
  const real = Bun.which('gitleaks')!
  writeFileSync(bin, `#!/bin/sh\nfind "$2" -type f -exec wc -c {} + >> '${log}'\nexec '${real}' "$@"\n`)
  Bun.spawnSync(['chmod', '755', bin])
  return {
    bin,
    scanned: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    reset: () => rmSync(log, { force: true }),
  }
}
const biggest = (s: string) =>
  Math.max(
    0,
    ...s
      .split('\n')
      .flatMap(l =>
        /^\s*(\d+)\s+\S+$/.exec(l) && !l.includes('total') ? [Number(l.trim().split(/\s+/)[0])] : [],
      ),
  )

test('d289.27: an append-only file over 1 MB scans only the appended tail; a secret in it is redacted', () => {
  const r = remote()
  const ws = workspace()
  const g = countingGitleaks()
  const c = { ...cfg(ws, r), gitleaks: g.bin }
  const filler =
    Array.from({ length: 30_000 }, (_, i) => `{"n":${i},"text":"plain line ${i}"}`).join('\n') + '\n'
  put(join(ws, 'home', 'metrics.jsonl'), filler)
  expect(backup(c, true).error).toBeUndefined()
  expect(biggest(g.scanned())).toBeGreaterThan(1_000_000) // the first backup scans the whole file
  g.reset()
  const tail = `{"t":"${TOKEN}"}\n{"n":"after"}\n`
  put(join(ws, 'home', 'metrics.jsonl'), filler + tail)
  const out = backup(c, true)
  expect(out.error).toBeUndefined()
  expect(biggest(g.scanned())).toBeLessThan(10_000)
  const got = pushedFile(r, 'home/metrics.jsonl')
  expect(got).not.toContain(TOKEN)
  expect(got).toContain('{"t":"[REDACTED]"}\n{"n":"after"}')
  expect(got.startsWith(filler.slice(0, 1000))).toBe(true)
  expect(out.redacted).toContain('github-pat home/metrics.jsonl')
  // a later append goes on from the redacted copy
  g.reset()
  put(join(ws, 'home', 'metrics.jsonl'), filler + tail + '{"n":"more"}\n')
  expect(backup(c, true).error).toBeUndefined()
  expect(biggest(g.scanned())).toBeLessThan(10_000)
  expect(pushedFile(r, 'home/metrics.jsonl')).toContain('{"t":"[REDACTED]"}\n{"n":"after"}\n{"n":"more"}')
})

test('d289.27: a secret already in the scanned part stays redacted when the file grows', () => {
  const r = remote()
  const ws = workspace()
  const g = countingGitleaks()
  const c = { ...cfg(ws, r), gitleaks: g.bin }
  const filler =
    Array.from({ length: 30_000 }, (_, i) => `{"n":${i},"text":"plain line ${i}"}`).join('\n') + '\n'
  put(join(ws, 'home', 'metrics.jsonl'), `{"t":"${TOKEN}"}\n${filler}`)
  expect(backup(c, true).error).toBeUndefined()
  g.reset()
  put(join(ws, 'home', 'metrics.jsonl'), `{"t":"${TOKEN}"}\n${filler}{"n":"more"}\n`)
  expect(backup(c, true).error).toBeUndefined()
  expect(biggest(g.scanned())).toBeLessThan(10_000)
  const got = pushedFile(r, 'home/metrics.jsonl')
  expect(got).not.toContain(TOKEN)
  expect(got.startsWith('{"t":"[REDACTED]"}\n{"n":0')).toBe(true)
  expect(got.endsWith('{"n":"more"}')).toBe(true)
})

test('d289.27: a rewritten file (not an append) is scanned whole, and a secret in it is found', () => {
  const r = remote()
  const ws = workspace()
  const g = countingGitleaks()
  const c = { ...cfg(ws, r), gitleaks: g.bin }
  const filler =
    Array.from({ length: 30_000 }, (_, i) => `{"n":${i},"text":"plain line ${i}"}`).join('\n') + '\n'
  put(join(ws, 'home', 'metrics.jsonl'), filler)
  expect(backup(c, true).error).toBeUndefined()
  g.reset()
  put(join(ws, 'home', 'metrics.jsonl'), `{"t":"${TOKEN}"}\n${filler}{"n":"more"}\n`)
  expect(backup(c, true).error).toBeUndefined()
  expect(biggest(g.scanned())).toBeGreaterThan(1_000_000)
  expect(pushedFile(r, 'home/metrics.jsonl')).not.toContain(TOKEN)
})
