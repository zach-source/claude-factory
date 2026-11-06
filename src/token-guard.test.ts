import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKEN_READ_REASON, tokenPathReason, tokenReason } from './token-guard'

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tokenguard-')))
const home = join(tmp, 'home')
const root = join(tmp, 'root')
const codexHome = join(tmp, 'runs', 'r1', 'codex', 'plan')
const env = { home, codexHome, claudeConfigDir: join(home, '.claude') }
for (const d of [
  join(home, '.codex'),
  join(home, '.claude', 'plugins'),
  join(home, 'repos', 'x'),
  join(root, '.scratch'),
  join(root, 'fixtures'),
  join(root, 'src'),
  codexHome,
])
  mkdirSync(d, { recursive: true })
writeFileSync(join(home, '.codex', 'auth.json'), 'x')
writeFileSync(join(home, '.claude', '.credentials.json'), 'x')
writeFileSync(join(home, '.claude.json'), 'x')
writeFileSync(join(root, 'auth.json'), 'x')
writeFileSync(join(root, 'fixtures', 'auth.json'), 'x')
writeFileSync(join(root, 'src', 'cli.ts'), 'x')
symlinkSync(join(home, '.codex', 'auth.json'), join(codexHome, 'auth.json'))
symlinkSync(join(home, '.codex', 'auth.json'), join(root, '.scratch', 'x'))
symlinkSync(join(home, '.codex'), join(root, '.scratch', 'c'))
// rule 7 expands ~/ with the user's dir: point it at the fake dir so no row reads the real one
const realHome = process.env.HOME
process.env.HOME = home
afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmp, { recursive: true, force: true })
})

const deny = (c: string) => tokenReason(c, root, root)

const DENY = [
  ...[
    ['cd', '~', '&&'],
    ['cd', '&&'],
    ['cd', '$' + 'HOME;'],
    ['pushd', '\x7e;'],
    ['cd', '/Users/acme', '&&'],
  ].map(w => [...w, 'cat .claude.json'].join(' ')),
  'cat ~/.codex/auth.json',
  'cat $CODEX_HOME/auth.json',
  'cat "${CODEX_HOME}/auth.json"',
  'head -c 100 /Users/acme/.codex/auth.json',
  'sed -n 1p ~/.codex/auth.json',
  'tail ~/.claude/.credentials.json',
  'cat $CLAUDE_CONFIG_DIR/.credentials.json',
  'jq . ~/.claude.json',
  `bun -e "console.log(require('fs').readFileSync(process.env.HOME+'/.codex/auth.json','utf8'))"`,
  `python3 -c "print(open('/Users/acme/.codex/auth.json').read())"`,
  `python3 -c "import os;print(open(os.path.expanduser('~/.codex/auth.json')).read())"`,
  `python3 -c "import os;open(os.path.join(os.environ['HOME'],'.codex','auth.json'))"`,
  'ln -s ~/.codex/auth.json .scratch/a',
  'cat .scratch/c/auth.json',
  'cat .scratch/x',
  'cat ../auth.json',
  'cat ~/other/auth.json',
  'cat ~/.codex/config.toml',
  'cat /Users/acme/.codex/config.toml',
  'cat {x,~/.codex/auth.json}',
  'cat {x,~/other/auth.json}',
  'ls $CLAUDE_CONFIG_DIR',
  'ls .scratch/c',
  'cat $X/auth.json',
  'cat ~/.cl*.json',
  'cat .scratch/c/../auth.json',
  'cat ~/.CODEX/AUTH.JSON',
  "cat ~/.codex/'au'th.json",
  'cat ~/.co\\dex/auth.js\\on',
  'cat ~/.codex/auth.js\\\non',
  'cat ~/.codex/a*',
  'cat ~/.codex/auth.jso?',
  'cat ~/.codex/{auth,x}.json',
  'cat ~/.codex/{{auth,x},y}.json',
  'cat ~/.codex/auth.js[o]n',
  'cat ~/.c*/a*',
  'cat ~/.claude/.cred*',
  'tar cf - ~/.codex',
  'cp -r ~/.codex .scratch/c',
  'ls $CODEX_HOME',
  'find ~/.codex -type f',
  'grep -r x ~/.claude',
  'cd ~/.codex && cat auth.json',
  'cd /Users/acme/.codex; cat auth.json',
  'CODEX_HOME=/x cat auth.json',
  'cat ~/.codex/$(echo auth).json',
  "security find-generic-password -s 'Claude Code-credentials' -w",
  'security dump-keychain',
  'security FIND-INTERNET-PASSWORD',
]

const ALLOW = [
  'echo {a[0]} x',
  'printf %s {a[1]} y',
  'cat auth.json',
  'cat fixtures/auth.json',
  './fixtures/auth.json',
  'grep -n auth.json src/cli.ts',
  "git commit -m 'fix auth.json read'",
  'grep -n CODEX_HOME src/cli.ts',
  'ls .claude',
  'cat .claude/settings.json',
  'ls .codex',
  'ls ~/.claude/plugins',
  'echo $TMPDIR',
  'cd $TMPDIR',
  'ls src/*',
  'bun test src/codex-worker.test.ts',
  'security find-certificate -a',
]

describe('tokenReason', () => {
  test.each([20, 40])('%d brace groups before a token path deny fast', n => {
    const t0 = performance.now()
    const r = deny('cat ' + '{a,b}'.repeat(n) + ' ; cat ~/.codex/auth.json')
    expect(r).toBe(TOKEN_READ_REASON)
    expect(performance.now() - t0).toBeLessThan(50)
  })
  test.each([
    ['40 stars + qq', '*'.repeat(40) + 'qq'],
    ['40 bangs + qq', '!'.repeat(40) + 'qq'],
    ['200-brace nest', '{'.repeat(200) + 'a' + '}'.repeat(200)],
    ['5000 brackets + ab', '['.repeat(5000) + 'ab'],
  ])('a glob of %s before a token path denies fast', (_n, glob) => {
    const t0 = performance.now()
    expect(deny(`cat ${glob} ; cat ~/.codex/auth.json`)).toBe(TOKEN_READ_REASON)
    expect(performance.now() - t0).toBeLessThan(50)
  })
  test.each([
    'env -C ~ cat .claude.json',
    'env --chdir=/Users/acme cat .claude.json',
    'git -C ~ diff --no-index .claude.json /dev/null',
    'tar -C ~ -cf - .claude.json',
  ])('a chdir flag marks a relative token file: %s', c => expect(deny(c)).toBe(TOKEN_READ_REASON))
  test('git -C into the worktree still allows', () => expect(deny('git -C src log') == null).toBe(true))
  test.each(DENY)('denies %s', c => expect(deny(c)).toBe(TOKEN_READ_REASON))
  test.each(ALLOW)('allows %s', c => expect(deny(c) == null).toBe(true))
  test('a glued brace word is no wildcard, even where realpath of the root fails (Linux CI, EACCES on /root)', () => {
    expect(tokenReason('echo {a[0]} x', '/nonexistent/repo', undefined)).toBeUndefined()
    expect(tokenReason('echo {auth.json}', '/nonexistent/repo', undefined)).toBe(TOKEN_READ_REASON)
  })
  test('no root: nothing is inside', () => {
    expect(tokenReason('cat auth.json', root, undefined)).toBe(TOKEN_READ_REASON)
    expect(tokenReason('cat ./fixtures/auth.json', root, undefined)).toBe(TOKEN_READ_REASON)
  })
  test('a real symlink to a token file denies by path', () => {
    expect(deny(`cat ${codexHome}/auth.json`)).toBe(TOKEN_READ_REASON)
  })
  test('a pattern with a marker in the text denies a relative file', () => {
    expect(deny('ls .codex; cat auth.js*')).toBe(TOKEN_READ_REASON)
  })
  test('text over 8192 chars denies; 8192 chars with no token name allows', () => {
    expect(deny('cat ' + 'x'.repeat(8188))).toBeUndefined()
    expect(deny('cat ' + 'x'.repeat(8189))).toBe(TOKEN_READ_REASON)
  })
  const S = ' ; cat ~/.codex/auth.json'
  const fill = (head: string, unit: string) => {
    let c = head
    while (c.length + unit.length + S.length <= 8192) c += unit
    return c
  }
  test.each([
    ['8 brace groups', 'cat ' + '{a,b}'.repeat(8) + ' ' + 'x'.repeat(8000)],
    ['900 deep paths', Array.from({ length: 900 }, (_, i) => '/a/b/c/d/e/f/g/h/i/j/k' + i).join(' ')],
    ['2000 a* components', fill('cat ', 'a*/')],
    ['2000 $abc components', fill('cat ', '$abc/')],
    ['4000 [a then ]', fill('cat ', '[a') + ']'],
    ['8 brace pairs per component', fill('cat ', '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}/')],
  ])('the worst 8 KB shape %s ends in a token read and denies in under 1000 ms', (_n, body) => {
    const c = body.slice(0, 8192 - S.length) + S
    const t0 = performance.now()
    expect(deny(c)).toBe(TOKEN_READ_REASON)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
  test('an 8192-char command stays fast', () => {
    const t = Date.now()
    expect(deny('a/b '.repeat(2048))).toBeUndefined()
    expect(Date.now() - t).toBeLessThan(50)
  })
})

describe('tokenPathReason', () => {
  const read = (p: unknown) => tokenPathReason('Read', { file_path: p }, root, root, env)
  const grep = (p?: unknown) => tokenPathReason('Grep', p === undefined ? {} : { path: p }, root, root, env)
  test.each([
    join(home, '.codex', 'auth.json'),
    join(codexHome, 'auth.json'),
    join(home, '.claude', '.credentials.json'),
    join(home, '.claude.json'),
    join(root, '.scratch', 'x'),
    join(root, '.scratch', 'c', 'auth.json'),
    join(home, '.codex', 'sessions', 'a.jsonl'),
    join(home, '.CLAUDE.JSON'),
    undefined,
    '',
    7,
    'a\0b',
    '~bob/.codex/auth.json',
  ])('Read denies %p', p => expect(read(p)).toBe(TOKEN_READ_REASON))
  test('Read tilde path', () => {
    expect(read('~/.codex/auth.json')).toBe(TOKEN_READ_REASON)
  })
  test.each([
    join(root, 'src', 'cli.ts'),
    'a',
    join(root, 'fixtures', 'auth.json'),
    join(home, '.claude', 'plugins', 'p'),
  ])('Read allows %p', p => expect(read(p) == null).toBe(true))
  test.each([
    join(home, '.codex'),
    home,
    '/',
    join(home, '.claude'),
    codexHome,
    7,
    join(home, '.codex', 'x'),
  ])('Grep denies %p', p => expect(grep(p)).toBe(TOKEN_READ_REASON))
  test.each([undefined, join(root, 'src'), join(home, 'repos', 'x')])('Grep allows %p', p =>
    expect(grep(p) == null).toBe(true),
  )
})
