import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_REASON, homeReason, protectedPath, rmSafe } from './home-guard'
import { denyReason } from './worker-hook'

const H = ['/Users/pat']

describe('homeReason', () => {
  test.each([
    'rm -rf ~',
    'rm -rf ~/',
    'rm -rf ~/*',
    'rm -rf "$HOME"',
    'rm -rf ${HOME}/',
    'rm -rf /Users/pat',
    "rm -rf '/Users/pat/'",
    'rm -rf /Users',
    'rmdir ~',
    'find ~ -delete',
    'find $HOME -mindepth 1 -delete',
    'rsync -a --delete empty/ ~/',
    'cd ~ && git clean -fdx',
    'git worktree remove --force $HOME',
    'mv ~ /tmp/x',
    `python3 -c "import shutil,os; shutil.rmtree(os.path.expanduser('~'))"`,
    `bun -e "require('fs').rmSync(require('os').homedir(), {recursive: true})"`,
    'X=$HOME; rm -rf $X',
  ])('denies %s', cmd => expect(homeReason(cmd, undefined, H)).toBe(HOME_REASON))

  test.each([
    'rm -f build/out.o',
    'rm -rf ~/.cache/factory-x',
    'rm $HOME/.zshrc.bak',
    'ls ~',
    'cat ~/notes.md',
    'echo $HOME',
    'find . -name "*.tmp" -delete',
    'rm -rf /Users/pat/repos/w/node_modules',
    'git worktree remove ../wt-123',
  ])('allows %s', cmd => expect(homeReason(cmd, undefined, H)).toBeUndefined())

  const rmtree = (p: string) => `python3 -c "import shutil; shutil.rmtree('${p}')"`
  const FORMS = ['/Users/pat', '/users/pat', '/users/PAT', '/USERS/pat', '/Uſers/pat']
  test.each(FORMS)('denies a folded home path in rmtree: %s', p =>
    expect(homeReason(rmtree(p), undefined, H)).toBe(HOME_REASON),
  )
  test.each(FORMS)('denies a folded home path in mv: %s', p =>
    expect(homeReason(`mv ${p} /tmp/x`, undefined, H)).toBe(HOME_REASON),
  )
  test.each(['/Users', '/users', '/USERS/'])('denies a folded parent dir: %s', p => {
    expect(homeReason(rmtree(p), undefined, H)).toBe(HOME_REASON)
    expect(homeReason(`mv ${p} /tmp/x`, undefined, H)).toBe(HOME_REASON)
  })
  test.each(['/Users/jess', '/Users/jeß'])('denies a multi-char fold: %s', p =>
    expect(homeReason(rmtree(p), undefined, ['/Users/jess'])).toBe(HOME_REASON),
  )
  test.each(['MV ~ /tmp/x', '/bin/MV ~ /tmp/x', 'RM -rf $HOME', 'MV /users/pat /tmp/x'])(
    'denies an upper-case delete word: %s',
    cmd => expect(homeReason(cmd, undefined, H)).toBe(HOME_REASON),
  )
  test.each([
    'rm -rf /users/pat/repos/w/node_modules',
    'mv /USERS/pat/a.txt /tmp/x',
    'ls /users/pat',
    'cat /Uſers/pat/notes.md',
    'echo $home',
    'rm -rf /users/patx',
  ])('allows a folded form that is not the whole home: %s', cmd =>
    expect(homeReason(cmd, undefined, H)).toBeUndefined(),
  )
  test('denies a folded home path in a script file', () => {
    expect(homeReason('bash c.sh', () => 'rm -rf /users/PAT\n', H)).toBe(HOME_REASON)
  })
  test('the worker hook denies the folded real home', () => {
    expect(denyReason(rmtree(homedir().toLowerCase()), '/nonexistent/wt')).toBe(HOME_REASON)
  })

  test('denies a script that the command runs, by its text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-guard-'))
    writeFileSync(join(dir, 'cleanup.sh'), 'for w in $(git worktree list); do :; done\nrm -rf "${HOME}"\n')
    writeFileSync(join(dir, 'ok.sh'), 'rm -rf ./build\n')
    const read = (p: string) => {
      try {
        return readFileSync(join(dir, p), 'utf8')
      } catch {
        return undefined
      }
    }
    expect(homeReason('bash cleanup.sh', read, H)).toBe(HOME_REASON)
    expect(homeReason('./cleanup.sh --all', read, H)).toBe(HOME_REASON)
    expect(homeReason('bash ok.sh', read, H)).toBeUndefined()
  })

  test('the worker hook gives HOME_REASON first', () => {
    expect(denyReason('find ~ -delete', '/Users/pat/wt')).toBe(HOME_REASON)
  })
})

describe('rmSafe', () => {
  test('protects /, the home dir and every dir above it', () => {
    for (const p of ['/', '/Users', '/Users/', '/Users/pat', '/Users/pat/', '/Users/pat/a/..'])
      expect(protectedPath(p, H)).toBe(true)
    for (const p of ['/users/pat', '/USERS', '/Uſers/PAT/']) expect(protectedPath(p, H)).toBe(true)
    for (const p of ['/users/pat/a', '/users/patx', '/Users/pat/a', '/Users/patx', '/tmp']) expect(protectedPath(p, H)).toBe(false)
  })

  // never call rmSafe on the real home dir in a test: a broken guard would delete it. $HOME points
  // at a temp dir here, so a broken guard deletes only that dir
  test('throws on $HOME and deletes a normal dir', () => {
    expect(protectedPath(homedir())).toBe(true)
    const fake = mkdtempSync(join(tmpdir(), 'home-guard-home-'))
    const old = process.env.HOME
    process.env.HOME = fake
    try {
      expect(() => rmSafe(fake, { recursive: true, force: true })).toThrow(/refusing/)
      expect(existsSync(fake)).toBe(true)
    } finally {
      process.env.HOME = old
    }
    const dir = mkdtempSync(join(tmpdir(), 'home-guard-'))
    rmSafe(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
  })
})
