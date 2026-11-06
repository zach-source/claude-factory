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
  test.each(DENY)('denies %s', c => expect(deny(c)).toBe(TOKEN_READ_REASON))
  test.each(ALLOW)('allows %s', c => expect(deny(c) == null).toBe(true))
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
