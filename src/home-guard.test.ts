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

  // every named file holds a recursive delete of the home dir (built at run time)
  const bad = () => 'r' + 'm -rf "$' + 'HOME"\n'
  const CLI = 'src/cli.ts'
  const WRK = 'src/worker.ts'

  test.each([
    `git diff a b ${CLI}`,
    `git diff origin/main...HEAD -- ${CLI} ${WRK}`,
    `git -C /abs/wt diff ${CLI}`,
    `git --no-pager log -p -- ${CLI}`,
    `grep -n x ${CLI} ${WRK}`,
    `cat ${CLI} | head -n 5`,
    `head -n 50 ${CLI}`,
    `cd /abs/wt && git diff ${CLI}`,
    `git diff ${CLI} 2>&1 | tail -n 3`,
    `bd create "t" -d "see src/home-guard.ts (the guard; it reads ${CLI}) & more | x"`,
    `bd comment x 'see src/home-guard.ts; $(no) \`no\`'`,
    `git diff \\\n  ${CLI}`,
    `git diff ${CLI} &> /dev/null`,
    `(cd /abs/wt && git diff ${CLI})`,
    `git blame ${CLI}`,
    `git status ${CLI}`,
  ])('allows a read-only command that names a script: %s', cmd =>
    expect(homeReason(cmd, bad, H)).toBeUndefined(),
  )

  test.each([
    'bash .scratch/clean.sh',
    'bun .scratch/x.ts',
    './cleanup.sh --all',
    'source x.sh',
    '. x.sh',
    'python3 x.py',
    'deno run x.ts',
    'tsx x.ts',
    'timeout 60 bash x.sh',
    'env ./x.sh',
    'nohup ./x.sh',
    'FOO=1 git diff ./x.sh',
    'GIT_EXTERNAL_DIFF=./x.sh git diff',
    'cat ./x.sh | bash',
    `git diff ${CLI}; bash x.sh`,
    `git diff ${CLI} && ./x.sh`,
    `git diff ${CLI} & ./x.sh`,
    `git diff ${CLI}\n./x.sh`,
    'bd create -d "$(bash x.sh)"',
    'git -c diff.external=./x.sh diff',
    'git difftool -x ./x.sh',
    'git rebase --exec ./x.sh HEAD~1',
    'git bisect run ./x.sh',
    '/usr/bin/git diff ./x.sh',
    '"git" diff ./x.sh',
    'rg --pre ./x.sh foo',
    `bash -c 'git diff ${CLI}'`,
    'git diff x.ts\n{ ./x.sh; }',
    'cat x;./x.sh',
    'cat x|./x.sh',
    'cat x&./x.sh',
    'cat x||./x.sh',
  ])('denies a command that can run a script: %s', cmd => expect(homeReason(cmd, bad, H)).toBe(HOME_REASON))

  test.each(['bd create -d "`bash x.sh`"', 'echo $(./x.sh)', '(./x.sh)', 'echo `./x.sh`'])(
    'denies a script in a backtick, $( or ( word: %s',
    cmd => expect(homeReason(cmd, bad, H)).toBe(HOME_REASON),
  )

  test.each([
    "git diff #'\n./x.sh #'",
    "echo $'\\'' ; ./x.sh #'",
    "cat <<EOF\necho '\nEOF\n./x.sh\necho '",
    `echo "\${x-"'"}"; ./x.sh; echo "\${x-"'"}"`,
    `git diff "\${x:-"'"}" ; ./x.sh # "'"`,
    'cat x \\\\\n./x.sh',
    'git diff a \\\\\n./x.sh',
    'cat x \\\\\\\\\n./x.sh',
    'cat x\\\\\nbash x.sh',
  ])("denies a fake quote: an unquoted #, $', <<, a nested quote in ${} or an even backslash run before a newline: %j", cmd =>
    expect(homeReason(cmd, bad, H)).toBe(HOME_REASON),
  )

  test('allows a # inside double quotes', () => {
    expect(homeReason('bd create -d "issue #12 see x.sh"', bad, H)).toBeUndefined()
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
    for (const p of ['/users/pat/a', '/users/patx', '/Users/pat/a', '/Users/patx', '/tmp'])
      expect(protectedPath(p, H)).toBe(false)
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
