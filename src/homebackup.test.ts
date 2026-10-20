import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, backupAge, EXCLUDES, restore, secretFile, type BackupCfg } from './homebackup'

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
  expect(readFileSync(join(b, 'home', '.migrated'), 'utf8')).toContain(`restored ${out.sha}`)
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
    'home/settings.json',
    'home/rigs.json.bak',
    'home/tick.lock',
    'home/gc.lock',
    'home/bin/factory',
    'home/devenv/x',
    'home/herdr.log',
    'home/backup.json',
    'home/runs/r1/worktrees/acme/f.txt',
    `claude/.credentials.json`,
    `claude/projects/${SLUG}/other.jsonl`,
  ]
  for (const f of never) put(join(ws, f), 'x')
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
  const files = sh('--git-dir', r, 'ls-tree', '-r', '--name-only', 'manager-home').split('\n')
  for (const f of never) expect(files).not.toContain(f)
  expect(files).toContain('home/rigs.json')
})

test('AC2: each exclude rule is needed', () => {
  // a rule removed from EXCLUDES lets its file in
  const rules = EXCLUDES.filter(x => !x.startsWith('#'))
  expect(rules.length).toBeGreaterThanOrEqual(10)
  const probes: Record<string, string> = {
    '.claude.json': 'home/.claude.json',
    '.credentials.json': 'home/.credentials.json',
    'settings*.json': 'home/settings.json',
    'rigs.json.*': 'home/rigs.json.bak',
    '*.lock': 'home/tick.lock',
    '/home/bin/': 'home/bin/factory',
    '/home/devenv/': 'home/devenv/x',
    '/home/herdr.log': 'home/herdr.log',
    '/home/backup.json': 'home/backup.json',
    '/home/manager-host.log': 'home/manager-host.log',
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

test('AC3: a secret in a staged file stops the commit and the push, and the error names the file', () => {
  const r = remote()
  const ws = workspace()
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
  const before = sh('--git-dir', r, 'rev-parse', 'manager-home')
  const token = 'ghp_' + 'a'.repeat(36)
  put(join(ws, 'home', 'memory', 'leak.md'), `token ${token}`)
  const out = backup(cfg(ws, r), true)
  expect(out.error).toContain('home/memory/leak.md')
  expect(out.error).not.toContain(token)
  expect(sh('--git-dir', r, 'rev-parse', 'manager-home')).toBe(before)
  // nothing stays staged: the next backup without the file works
  rmSync(join(ws, 'home', 'memory', 'leak.md'))
  expect(backup(cfg(ws, r), true).error).toBeUndefined()
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

test('AC12: a token in a work tree memory file, binary too, stops the backup and names the file', () => {
  for (const body of [
    Buffer.from('ghp_' + 'a'.repeat(36)),
    Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('ghp_' + 'a'.repeat(36))]),
  ]) {
    const r = remote()
    const a = workspace()
    memGit(a, 'init', '-q')
    writeFileSync(join(a, 'home', 'memory', 'x.bin'), body)
    const out = backup(cfg(a, r), true)
    expect(out.error).toContain('home/memory/x.bin')
    expect(pushed(r)).toBe(false)
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

test('the scan reads the staged blob: a token in a binary memory file stops the backup', () => {
  const r = remote()
  const ws = workspace()
  put(join(ws, 'home', 'memory', 'b.bin'), 'a\0b ghp_' + 'a'.repeat(36))
  const out = backup(cfg(ws, r), true)
  expect(out.error).toContain('home/memory/b.bin')
  expect(out.error).not.toContain('ghp_')
  expect(sh('--git-dir', r, 'branch', '--list')).toBe('')
})

test('a nested repo at home/.git is refused, not saved as a gitlink', () => {
  const r = remote()
  const ws = workspace()
  sh('init', '-q', join(ws, 'home'))
  const out = backup(cfg(ws, r), true)
  expect(out.error).toContain('home/.git')
  expect(sh('--git-dir', r, 'branch', '--list')).toBe('')
})
