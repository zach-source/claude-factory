import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FACTORY_BIN, HOME_REASON, homeReason, protectedPath, rmQuiet, rmSafe } from './home-guard'
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
    `head -n 50 ${CLI}`,
    `bd create "t" -d "see src/home-guard.ts (the guard; it reads ${CLI}) & more | x"`,
    `bd comment x 'see src/home-guard.ts; $(no) \`no\`'`,
    `git blame ${CLI}`,
    `git status ${CLI}`,
    `git diff HEAD~1 HEAD^ -- ${CLI}`,
    `grep -n 'a|b' ${CLI}`,
    'bd create -d "see src/home-guard.ts"',
    `cat ${CLI} | head -n 5`,
    `cd /abs/wt && git diff ${CLI}`,
    `git diff ${CLI} 2>&1 | tail -n 3`,
    `grep -n "a\\|b" ${CLI} | head -5; grep -n "c\\(d\\)" ${WRK} | head -3`,
    `sed -n 1,140p ${CLI}; grep -n "x" ${CLI} | head -80`,
    `sed -n 1250,1275p ${CLI}; sed -n '1436,1465p;1p' ${CLI}`,
    `bd show x 2>&1 | head -40; grep -n "a" ${CLI} 2>/dev/null | head`,
    `git diff ${CLI}\ngrep x ${CLI}`,
    `cd /abs/wt; git diff origin/main...HEAD -- ${CLI} ${WRK}; echo ===X; grep -n "a\\|b" ${CLI} | head -40`,
    `ls x >/dev/null || cat ${CLI}`,
  ])('allows a read-only command that names a script: %s', cmd =>
    expect(homeReason(cmd, bad, H)).toBeUndefined(),
  )

  test.each([
    `git diff \\\n  ${CLI}`,
    `git \\\n diff ${CLI}`,
    `git diff ${CLI} &> /dev/null`,
    `(cd /abs/wt && git diff ${CLI})`,
  ])('denies a read command outside the one-command grammar: %s', cmd =>
    expect(homeReason(cmd, bad, H)).toBe(HOME_REASON),
  )

  test.each([
    `grep x ${CLI} | xargs ./x.sh`,
    `grep x ${CLI} | bash`,
    `sed -n 1p ${CLI} | sh`,
    `cat ${CLI} | tee x.sh`,
    `grep x ${CLI} |& ./x.sh`,
    `grep x ${CLI} 2>/tmp/f`,
    `git diff ${CLI} > out`,
    `grep x ${CLI} >/dev/null./x.sh`,
    `| head ${CLI}`,
    `cat ${CLI} ; ; head`,
    `grep "a\\" ${CLI}; ./x.sh; echo "`,
    `grep "a\\$(./x.sh)" ${CLI}`,
    `grep "a\\\\" ${CLI}`,
    `grep x ${CLI} | awk '{print}'`,
    `sed -i 1d ${CLI}`,
    `sed -n 1p ${CLI} -i`,
    `sed -n '1p;w out' ${CLI}`,
    `sed -n 'w x.sh' ${CLI}`,
    `sed -n 1e ${CLI}`,
    `sed -n -e 1p ${CLI}`,
    `sed -E -n 1p ${CLI}`,
    `sed --quiet 1p ${CLI}`,
    `sed -n '1p' -f x.sed ${CLI}`,
    `sed -n 1p ${CLI} > out`,
    `sed -n 1p ${CLI}; ./x.sh`,
    `sed -n 1p '-e' '1e ./x.sh' ${CLI}`,
    `sed -n 1p "--expression=1e ./x.sh" ${CLI}`,
    `sed -n 1p ''-i x.sh ${CLI}`,
  ])('denies a compound or sed form outside the grammar: %s', cmd =>
    expect(homeReason(cmd, bad, H)).toBe(HOME_REASON),
  )

  // a path word without a script extension, and a word before ':'
  const ABS = '/abs/wt/.scratch/x'
  test.each([
    ABS,
    `${ABS} --all`,
    '.scratch/x',
    'bash .scratch/x',
    "'/wt/x' a",
    '"/wt/x"',
    'nohup /abs/x',
    'cat a; .scratch/x',
    `factory mutate ${CLI}:1 a b -- bun test`,
    `bun test ${CLI}:12:3`,
    'PATH=/a:/b/x.sh foo',
    'bash x.sh>o',
    'bash .scratch/x>o',
    '.scratch/x>/dev/null',
    'bash<.scratch/x',
    'bash <.scratch/x',
    'sh<x.sh',
  ])('denies a path word that holds a home delete: %s', cmd =>
    expect(homeReason(cmd, bad, H)).toBe(HOME_REASON),
  )

  test('reads the bare path, without the :line', () => {
    const cases: [string, string][] = [
      [ABS, ABS],
      ['.scratch/x', '.scratch/x'],
      ["'/wt/x' a", '/wt/x'],
      [`bun test ${CLI}:12:3`, CLI],
      ['PATH=/a:/b/x.sh foo', '/b/x.sh'],
      ['bash .scratch/x', '.scratch/x'],
      ['"/wt/x"', '/wt/x'],
      ['nohup /abs/x', '/abs/x'],
      ['cat a; .scratch/x', '.scratch/x'],
      [`${ABS} --all`, ABS],
      [`factory mutate ${CLI}:1 a b -- bun test`, CLI],
      ['bash x.sh>o', 'x.sh'],
      ['bash<.scratch/x', '.scratch/x'],
    ]
    for (const [cmd, path] of cases) {
      const seen: string[] = []
      homeReason(cmd, p => (seen.push(p), undefined), H)
      expect(seen).toContain(path)
    }
  })

  test.each([ABS, `bun test ${CLI}:1`])('allows a path word to a benign file: %s', cmd =>
    expect(homeReason(cmd, () => 'echo ok', H)).toBeUndefined(),
  )

  test('a read-only command with a path or :line reads no file', () => {
    let reads = 0
    const count = () => (reads++, undefined)
    homeReason(`git diff origin/main -- ${CLI}`, count, H)
    homeReason(`grep -n x ${CLI}:1`, count, H)
    expect(reads).toBe(0)
  })

  test.each(['curl https://example.com/a/b', 'git push origin main'])(
    'a path word that does not read is no deny: %s',
    cmd => expect(homeReason(cmd, () => undefined, H)).toBeUndefined(),
  )

  test('5000 path words return fast', () => {
    const cmd = Array.from({ length: 5000 }, (_, i) => `.scratch/a${i}`).join(' ') + ' bash x'
    let reads = 0
    const t0 = performance.now()
    homeReason(cmd, () => (reads++, undefined), H)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(reads).toBeGreaterThanOrEqual(5000)
  })

  test('a 100000-char reader pipeline returns fast', () => {
    const cmd = `grep -n "a\\|b" ${CLI} | `.repeat(5000) + 'head'
    const t0 = performance.now()
    homeReason(cmd, bad, H)
    expect(performance.now() - t0).toBeLessThan(200)
  })

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
    'echo "\\" \'"\n./x.sh\necho \'',
    "cat x \\'\n./x.sh\necho '",
    'bd create -d "!! x.sh"',
    "'git' diff ./x.sh",
    'g""it diff ./x.sh',
  ])(
    "denies a fake quote: an unquoted #, $', <<, a nested quote in ${} or an even backslash run before a newline: %j",
    cmd => expect(homeReason(cmd, bad, H)).toBe(HOME_REASON),
  )

  test('allows a # inside double quotes', () => {
    expect(homeReason('bd create -d "issue #12 see x.sh"', bad, H)).toBeUndefined()
  })

  // verbs that never run a file they name: allowed with no script read
  const NON_RUNNER_OK = [
    `git add ${CLI} ${WRK}`,
    `git -C /abs/wt add -- ${CLI}`,
    `git --no-pager add ${CLI}`,
    `git add ${CLI} && git commit -m x`,
    `git commit -q -F .scratch/msg.txt ${CLI}`,
    `git commit -am "fix ${CLI}"`,
    `git checkout -- ${CLI}`,
    `git restore --staged ${CLI}`,
    `git fetch -q origin main && git diff origin/main -- ${CLI}`,
    `bunx prettier@3.9.9 --write ${CLI} ${WRK}`,
    `bunx prettier --check ${CLI} 2>&1 | tail -7`,
    `${FACTORY_BIN} report run-1 2 ready "see ${CLI} and ${WRK}"`,
    `factory report run-1 2 ready --summary-file .scratch/s.md ${CLI}`,
    `factory memory add --from r/plan --kind fact --rig acme "x" "see ${CLI}"`,
    `factory mail run-1 manager 'see ${CLI}; $(no)'`,
    `mkdir -p .scratch && git add ${CLI}`,
    `cd /abs/wt; bunx prettier@3.9.9 -w ${CLI}`,
    // one row per set member, so removing a member turns a row red
    ...['-A', '--all', '-u', '--update', '-N', '--intent-to-add', '-v', '-f'].map(f => `git add ${f} ${CLI}`),
    ...['-a', '-q', '--quiet', '--amend', '--no-edit', '-s', '-v'].map(f => `git commit ${f} ${CLI}`),
    `git commit -m x ${CLI}`,
    `git commit -F x.txt ${CLI}`,
    `git commit -- ${CLI}`,
    ...['-q', '-b', '-B'].map(f => `git checkout ${f} ${CLI}`),
    ...['--staged', '--worktree', '-S', '-W', '-q'].map(f => `git restore ${f} ${CLI}`),
    `git restore -- ${CLI}`,
    ...['-q', '--quiet', '--prune', '-p', '--all', '--tags', '--no-tags'].map(f => `git fetch ${f} ${CLI}`),
    ...['--write', '-w', '--check', '-c', '-l', '--list-different'].map(f => `bunx prettier ${f} ${CLI}`),
    ...['report', 'mail', 'memory add', 'memory search', 'memory helped'].map(s => `factory ${s} x ${CLI}`),
    ...['--summary-file', '--from', '--kind', '--rig', '--until', '--supersedes'].map(
      f => `factory memory add ${f} x ${CLI}`,
    ),
    ...['-p', '-v'].map(f => `mkdir ${f} d ${CLI}`),
  ]

  test.each(NON_RUNNER_OK)('allows a non-runner command that names a script: %s', cmd =>
    expect(homeReason(cmd, bad, H)).toBeUndefined(),
  )

  const NON_RUNNER_DENY = [
    `bun test ${CLI}`,
    `bun run ${CLI}`,
    `bunx tsx ${CLI}`,
    `bunx prettier --plugin ./x.js ${CLI}`,
    `bunx prettier --config x.js ${CLI}`,
    `bunx --bun prettier ${CLI}`,
    `npx prettier --write ${CLI}`,
    `cp x.sh .git/hooks/pre-commit && git commit -m x`,
    `cp ${CLI} y.ts`,
    `git fetch --upload-pack=./x.sh origin`,
    `git fetch --upload-pack ./x.sh origin`,
    `git fetch 'ext::sh x.sh'`,
    `git -c core.hooksPath=. commit -m x ${CLI}`,
    `git commit --template x.sh`,
    `git commit -m x ${CLI} && bash x.sh`,
    `git add ${CLI} | bash`,
    `git push origin x.sh`,
    `git rebase --exec ./x.sh`,
    `git checkout -p ${CLI}`,
    `git add ''-x ${CLI}`,
    `factory check factories/x.ts`,
    `factory mutate ${CLI} 1 a b -- bun test`,
    `./factory report r 1 ready "x.ts"`,
    `/abs/bin/factory report r 1 ready x`,
    `/abs/wt/.scratch/factory report r 1 ready x.sh`,
    `.scratch/factory report r 1 ready x`,
    `'/wt/factory' report r 1 ready x`,
    `'${FACTORY_BIN}' report r 1 ready x`,
    'factory report r 1 ready "`bash x.sh`"',
    'factory report r 1 ready "$(bash x.sh)"',
    `factory report r 1 ready --summary-file=x.sh`,
    `factory memory compact x.ts`,
    `mkdir -m 700 x.sh`,
    `GIT_DIR=x git add ${CLI}`,
    `git commit -m"'" --template=x.sh`,
    `factory report r 1 ready --summary-file"'" --x=x.sh`,
    `bunx prettier3 ${CLI}`,
    `git toString -x ${CLI}`,
    `git __proto__ ${CLI}`,
    `git constructor ${CLI}`,
  ]

  test.each(NON_RUNNER_DENY)('denies a non-runner verb outside its closed grammar: %s', cmd =>
    expect(homeReason(cmd, bad, H)).toBe(HOME_REASON),
  )

  test('a non-runner command reads no file; any other command that names a script reads one', () => {
    let reads = 0
    const count = () => {
      reads++
      return undefined
    }
    for (const cmd of NON_RUNNER_OK) homeReason(cmd, count, H)
    expect(reads).toBe(0)
    for (const cmd of NON_RUNNER_DENY.filter(c => /\.(ts|sh|js)\b|\.\//.test(c))) {
      reads = 0
      homeReason(cmd, count, H)
      expect(reads).toBeGreaterThan(0)
    }
  })

  test('the command text check runs before the non-runner check', () => {
    // the delete word is built at run time
    const del = 'r' + 'm -rf'
    expect(homeReason(`factory report r 1 ready "${del} ~"`, undefined, H)).toBe(HOME_REASON)
    expect(homeReason(`git commit -m "${del} $HOME"`, undefined, H)).toBe(HOME_REASON)
  })

  test('the worker hook allows git checkout of the guard source', () => {
    const read = (p: string) => {
      try {
        return readFileSync(join(import.meta.dir, '..', p), 'utf8')
      } catch {
        return undefined
      }
    }
    expect(
      denyReason('git checkout -- src/home-guard.ts', join(import.meta.dir, '..'), undefined, {
        readFile: read,
      }),
    ).toBeUndefined()
  })

  test('a prototype key as the git sub does not throw and does not hide a later push', () => {
    const root = join(import.meta.dir, '..')
    const got = denyReason('git toString -x; git push --force origin main', root, undefined, {
      readFile: () => undefined,
    })
    expect(got).toBeDefined()
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

  const mk = () => mkdtempSync(join(tmpdir(), 'home-guard-rm-'))
  const opts = { recursive: true, force: true }

  test('throws when the rm keeps the tree (3 tries)', () => {
    const dir = mk()
    let n = 0
    expect(() => rmSafe(dir, opts, () => void n++)).toThrow(/still exists after 3 tries/)
    expect(() => rmSafe(dir, opts, () => {})).toThrow(dir)
    expect(n).toBe(3)
    expect(existsSync(dir)).toBe(true)
    rmSync(dir, opts)
  })

  test('rmQuiet swallows a kept dir, so a finally block keeps the try error', () => {
    const dir = mk()
    const f = () => {
      try {
        throw new Error('try error')
      } finally {
        rmQuiet(dir, opts, () => {})
      }
    }
    expect(f).toThrow('try error')
    expect(existsSync(dir)).toBe(true)
    rmSync(dir, opts)
  })

  test('retries when the first rm keeps the tree', () => {
    const dir = mk()
    let n = 0
    rmSafe(dir, opts, (p, o) => {
      if (++n === 2) rmSync(p, o)
    })
    expect(n).toBe(2)
    expect(existsSync(dir)).toBe(false)
  })

  test('does not delete a new dir that took the same path', () => {
    const dir = mk()
    let n = 0
    rmSafe(dir, opts, (p, o) => {
      n++
      rmSync(p, o)
      mkdirSync(p)
    })
    expect(n).toBe(1)
    expect(existsSync(dir)).toBe(true)
    rmSync(dir, opts)
  })

  test('a missing path: force is a no-op, no force throws ENOENT, a real dir is deleted once', () => {
    const dir = join(mk(), 'gone')
    expect(() => rmSafe(dir, opts)).not.toThrow()
    expect(() => rmSafe(dir, { recursive: true })).toThrow(/ENOENT/)
    const real = mk()
    let n = 0
    rmSafe(real, opts, (p, o) => {
      n++
      rmSync(p, o)
    })
    expect(n).toBe(1)
    expect(existsSync(real)).toBe(false)
  })

  test('a protected path never reaches the rm', () => {
    const fake = mk()
    const old = process.env.HOME
    process.env.HOME = fake
    let n = 0
    try {
      expect(() => rmSafe(fake, opts, () => void n++)).toThrow(/refusing/)
    } finally {
      process.env.HOME = old
    }
    expect(n).toBe(0)
    rmSync(fake, opts)
  })
})
