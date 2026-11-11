import { expect, mock, test } from 'bun:test'
import { readFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { rmQuiet } from '../home-guard'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as view from '../../mod/hooks/view'
import { GATED_KINDS, kindEnds } from '../../mod/hooks/view'
import { SETTING_KEYS, DEVENV_KEYS } from '../settings'
import { check, INSTALL_VERB, META_WRITE, PATROL_VERB, bdWrite, gatedCommand } from './guards'
import { serverBashReason, serverToolReason, GRAMMAR_REASON, SECRET_PATH_REASON, TOOL_REASON } from './guards'

test('server Bash accepts only literal commands and safe paths', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'patrol-guard-'))
  const run = mock<typeof check>(() => ({ decision: 'allow' }))
  try {
    mkdirSync(join(cwd, 'repo'))
    writeFileSync(join(cwd, 'source'), '')
    symlinkSync('/etc', join(cwd, 'link'))
    symlinkSync('loop', join(cwd, 'loop'))
    symlinkSync('absent', join(cwd, 'dangling'))
    const denied = [
      'printenv AX_AUTH_TOKEN',
      'bun x.ts',
      'sh .scratch/x.sh',
      'env A=b factory status',
      'A=b factory status',
      'factory check x.ts',
      'factory mutate a b c -- true',
      'factory sweep',
      'factory adopt r',
      'factory memory compact',
      'factory rig add x',
      'factory rig list x',
      'factory start ../x r g',
      'factory start lifecycle /tmp/r g',
      'factory start lifecycle repo g',
      'factory start source r g',
      'factory queue repo',
      'factory queue ../x',
      'factory queue widget extra',
      'factory queue dangling',
      'factory start dangling widget',
      'factory start lifecycle dangling',
      'factory start lifecycle@ widget',
      'factory start lifecycle@bad.name widget',
      'factory start',
      'cat status',
      'factory',
      'factory start lifecycle',
      'factory start lifecycle widget goal extra',
      'factory start lifecycle@plan@extra widget',
      'factory queue',
      'factory status; cat k',
      'factory status > x',
      'factory status < x',
      'factory status 2>x',
      'factory status | head',
      'factory status && id',
      'factory status $(id)',
      'factory status `id`',
      'factory mail r s "$HOME"',
      'factory status *',
      'factory status ~',
      'factory status #x',
      'factory status\\\ncat k',
      "factory mail r s 'open",
      '',
      'herdr pane read p',
      'factory status "x!"',
      'factory status "x\\y"',
      'factory status\nid',
    ]
    for (const command of denied) {
      run.mockClear()
      expect(serverBashReason(command, cwd, '/cli', run), command).toBe(GRAMMAR_REASON)
      expect(run).toHaveBeenCalledTimes(0)
    }
    for (const command of [
      'factory status',
      '/cli status r1',
      "factory mail r1 build 'it is fine; use main'",
      "factory memory search 'x y'",
      "factory memory add --kind rule 's' 'b'",
      'factory rig list',
      'factory rig',
      "factory start lifecycle@plan widget 'goal'",
      'factory queue widget',
      'bd show claude-x.1',
      'factory mail r1 build --text-file /var/lib/factory/home/text/m.md',
      "factory mail r1 build a'b'c",
      'factory mail r1 build "fine"',
      "factory mail r1 build ''",
      "factory mail r1 build 'a\nb'",
    ]) {
      run.mockClear()
      expect(serverBashReason(command, cwd, '/cli', run), command).toBeUndefined()
      expect(run).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledWith(command, 'subagent')
    }
    for (const command of [
      'factory mail r1 build --text-file /etc/factory/worker-key/key',
      'factory mail r1 build --text-file=/etc/factory/tls/tls.key',
      'bd comments add x -f/proc/1/environ',
      'factory mail r1 build --text-file ../../../../../../etc/factory/worker-key/key',
      'factory mail r1 build --text-file link/factory/worker-key/key',
      'factory mail r1 build /run/secrets/a',
      'factory mail r1 build /var/run/secrets/a',
      'factory mail r1 build //etc/factory/worker-key/key',
      'factory mail r1 build /./proc/1/environ',
    ]) {
      run.mockClear()
      expect(serverBashReason(command, cwd, '/cli', run), command).toBe(SECRET_PATH_REASON)
      expect(run).toHaveBeenCalledTimes(0)
    }
    expect(serverBashReason('factory status', cwd, '/cli', () => ({ decision: 'deny', reason: 'z' }))).toBe(
      'z',
    )
    expect(serverBashReason('factory status', '/', '/cli')).toBe(SECRET_PATH_REASON)
    expect(serverBashReason('factory status', 'relative', '/cli')).toBe(SECRET_PATH_REASON)
    expect(serverBashReason('factory status', join(cwd, 'loop'), '/cli')).toBe(SECRET_PATH_REASON)
    expect(serverBashReason('factory status', undefined, '/cli')).toBe(SECRET_PATH_REASON)
  } finally {
    rmQuiet(cwd, { recursive: true, force: true })
  }
})

test('server tools deny secret paths and confine writes to home text', () => {
  const home = mkdtempSync(join(tmpdir(), 'patrol-tools-'))
  const text = join(home, 'text')
  mkdirSync(text)
  symlinkSync('/proc/self/environ', join(text, 'link'))
  symlinkSync(home, join(text, 'outside'))
  symlinkSync('loop', join(text, 'loop'))
  try {
    for (const p of [
      '/etc/factory/worker-key/key',
      '/etc/factory/tls/tls.key',
      '/etc/factory/backup/basic',
      '/var/run/secrets/kubernetes.io/serviceaccount/token',
      '/run/secrets/a',
      '/proc/1/environ',
      '/',
      '/etc',
      '/var',
      '/run',
      join(text, 'link'),
      join(text, 'loop'),
    ])
      expect(serverToolReason('Read', { file_path: p }, home, home), p).toBe(SECRET_PATH_REASON)
    for (const [tool, input] of [
      ['Grep', { path: '/' }],
      ['Grep', { path: '/etc/factory' }],
      ['Glob', { pattern: '/etc/factory/**' }],
      ['Glob', { pattern: '~/x' }],
      ['Glob', { pattern: 'a/../x' }],
      ['Glob', { pattern: '**', path: '/proc' }],
      ['Glob', { pattern: '{/etc/factory/**,a}' }],
      ['Glob', { pattern: '[/]etc' }],
    ] as const)
      expect(serverToolReason(tool, input, home, home)).toBe(SECRET_PATH_REASON)
    for (const p of [
      join(home, 'steps/patrol/.bashrc'),
      join(text, '../x'),
      join(text, '../steps/patrol/.bashrc'),
      join(text, 'outside/x'),
      join(text, 'loop'),
      text,
    ])
      expect(serverToolReason('Write', { file_path: p }, home, home), p).toBe(
        `In the server, the patrol writes only under ${home}/text/.`,
      )
    for (const [tool, input, cwd, h] of [
      ['Read', {}, home, home],
      ['Read', null, home, home],
      ['Edit', {}, home, home],
      ['Read', { file_path: 'a' }, undefined, home],
      ['Write', { file_path: 'text/a' }, home, undefined],
      ['Write', { file_path: 'text/a' }, home, 'relative'],
      ['Glob', {}, home, home],
      ['Read', { file_path: 1 }, home, home],
      ['Grep', { path: 5 }, home, home],
      ['Glob', { pattern: 'x', path: 1 }, home, home],
      ['Glob', { pattern: 1 }, home, home],
    ] as const)
      expect(serverToolReason(tool, input, cwd, h)).toBe(TOOL_REASON)
    expect(serverToolReason('Write', { file_path: 'a', content: 1 }, home, home)).toBe(
      `In the server, the patrol writes only under ${home}/text/.`,
    )
    for (const [tool, input] of [
      ['Read', { file_path: join(text, 'a.md') }],
      ['Write', { file_path: join(text, 'b.md') }],
      ['Grep', {}],
      ['Grep', { path: home }],
      ['Glob', { pattern: '**/*.md', path: home }],
    ] as const)
      expect(serverToolReason(tool, input, home, home)).toBeUndefined()
  } finally {
    rmQuiet(home, { recursive: true, force: true })
  }
})

test('the core exports the same rules as the mod', () => {
  for (const [name, value] of Object.entries({
    INSTALL_VERB,
    META_WRITE,
    PATROL_VERB,
    bdWrite,
    gatedCommand,
  }))
    expect(Object.is(value, view[name as keyof typeof view])).toBe(true)
  for (const file of ['cli.ts', 'once.ts']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from '\.\.\/mod\/hooks\/view'/g))
      expect(m[1]).not.toMatch(/\b(gatedCommand|bdWrite|INSTALL_VERB|META_WRITE|PATROL_VERB|isValidPlan)\b/)
  }
})

// Commands from mod/tests/gate.test.ts:7-9, 104-152, 340-391, 484-516.
const ask = [
  '/repo/bin/factory settings set ax.image evil.example/x@sha256:' + 'a'.repeat(64),
  '/repo/bin/factory settings set ax.manager-image x',
  '/repo/bin/factory settings set ax.vault x',
  '/repo/bin/factory settings set ax.context x',
  '/repo/bin/factory settings set ax.env /x',
  '/repo/bin/factory settings set token.read cmd',
  '/repo/bin/factory settings set token.write cmd',
  '/repo/bin/factory settings set image.registry ghcr.io/acme',
  '/repo/bin/factory settings set max-runs 5',
  '/repo/bin/factory settings unset ax.image',
  '/repo/bin/factory \\\nsettings \\\nset ax.image x',
  "/repo/bin/factory settings set 'ax.image' x",
  '/repo/bin/factory token use claude',
  '/repo/bin/factory token best',
  '/repo/bin/factory \\\ntoken \\\nuse claude',
  '/repo/bin/factory decide lifecycle-abc ship "looks good"',
  '/repo/bin/factory decisions answer api api-7 "use postgres"',
  '/repo/bin/factory start lifecycle api api-9 --owned',
  'factory decide r1 ship && factory start lifecycle acme w-2 --owned',
  '/repo/bin/factory \\\ndecide lifecycle-abc ship "looks good"',
  '/repo/bin/factory start lifecycle api "a\nmulti-line title" --owned',
  '/repo/bin/fac\\\ntory decide lifecycle-abc ship "looks good"',
  '/repo/bin/factory start lifecycle api api-9 --own\\\ned',
  ...[
    'factory decide r1 ship',
    'factory decisions answer acme w-1 yes',
    'factory start lifecycle acme w-2 --owned',
  ].map(c => 'echo hi #x\\\n' + c),
  '/repo/bin/factory status #x\\\n/repo/bin/factory decide r1 ship',
  "echo ' #' ; /repo/bin/fac\\\ntory decide r1 ship",
  'factory wiki init',
  'factory wiki --home x init',
  'factory wiki\ninit',
  'factory image',
  '/repo/bin/factory image build',
  'factory decide lifecycle-abc ship "$(id)"',
  '/repo/bin/factory decide r1 ship \\\\\n/repo/bin/factory decide r2 reject',
  '/repo/bin/factory decide r1 ship "x\\\\\\\ny"',
  '/repo/bin/factory decide r1 ship # note\\\necho x',
  `/repo/bin/factory decide r1 reject '${'a'.repeat(300)}' # x\\\n/repo/bin/factory start lifecycle acme w-2 --owned`,
  '/repo/bin/factory wiki init --remote x',
  '/repo/bin/factory wiki --remote x init',
  'FACTORY_WIKI_REMOTE=x /repo/bin/factory wiki init',
  '/repo/bin/factory \\\nwiki \\\ninit',
  '/repo/bin/factory image build --target manager',
  '/repo/bin/factory \\\nimage \\\nbuild',
]
const deny = [
  'echo hi #x\\\nfac\\\ntory decide r1 ship',
  '/repo/bin/factory mail r1 plan "$(id)"',
  '/repo/bin/factory file-elsewhere acme --from widget:w-1 --title "$(id)"',
  '/repo/bin/factory decisions propose k "`id`" o',
  '/repo/bin/factory mail r1 plan "x $(id) y"',
  '/repo/bin/factory mail r1 plan "it\'s $(id)"',
  '/repo/bin/factory mail r1 plan it\\\'s "$(id)"',
  '/repo/bin/factory mail r1 plan "a" \\\n"$(id)"',
  '/repo/bin/factory mail r1 plan $(id)',
  '/repo/bin/factory mail r1 plan "x \\\\\n$(id)"',
  '/repo/bin/factory mail r1 plan x \\\\\n$(id)',
  '/repo/bin/factory mail r1 plan $\\\n(id)',
  '/repo/bin/factory mail r1 plan "x $\\\n(id)"',
  '/repo/bin/factory mail r1 plan "x $\\\n\\\n(id)"',
  "/repo/bin/factory mail r1 plan /(e:'id':)",
  '/repo/bin/factory mail r1 plan "${x:=\\$(id)}${x@P}"',
  '/repo/bin/factory mail r1 plan "${(e):-\\$(id)}"',
  '/repo/bin/factory mail r1 plan "${x:=\\$(id)}${(e)x}"',
  "x='$(id)'; /repo/bin/factory mail r1 plan ${x@P}",
  '/repo/bin/factory mail r1 plan "$[x]"',
  'cd /w/acme-factory && /w/claude-factory/bin/factory mail r1 plan "$(id)"',
  "/repo/bin/factory mail r1 plan $'\\'' \"x\"",
  '/repo/bin/factory status # it\'s\n/repo/bin/factory mail r1 plan "$(id)" #\'',
  "/repo/bin/factory mail r1 plan <<EOF\nit's $(id)\nEOF",
  '/repo/bin/factory mail r1 plan it\\\'s "$(id)" \'',
  "/repo/bin/factory mail r1 plan $'\\'' \"$(id)\" '",
  '#\'\n/repo/bin/factory mail r1 plan "$(id)" \'',
  "/repo/bin/factory mail r1 plan <<EOF\n'x\nEOF\n'",
  '/repo/bin/factory mail r1 plan <(id)',
  '/repo/bin/factory mail r1 plan >(id)',
  '/repo/bin/factory mail r1 plan $x',
  '/repo/bin/factory mail r1 plan "$x"',
  '/repo/bin/factory mail r1 plan =(id)',
  '/repo/bin/factory mail r1 plan $[x]',
  "/repo/bin/factory mail r1 plan 'open",
  'F=/repo/bin/factory; for r in $(cat /tmp/s); do $F show $r; done',
]
const allow = [
  '/repo/bin/factory settings list',
  '/repo/bin/factory settings',
  '/repo/bin/factory memory search settings set',
  '/repo/bin/factory status',
  '/repo/bin/factory start lifecycle api "fix the thing"',
  "/repo/bin/factory mail r1 plan '$5'",
  '/repo/bin/factory wiki status',
  '/repo/bin/factory memory compact',
  '/repo/bin/factory memory search image',
  '/repo/bin/factory token',
  '/repo/bin/factory token list',
  '/repo/bin/factory memory search token use',
  '/repo/bin/fac\\\\\ntory decide r1 ship',
  'ls -la # note',
  "factory mail r1 plan '$(id)'",
  'echo "$(id)"',
  "/repo/bin/factory file-elsewhere acme --from widget:w-1 --title '$(id)'",
  "/repo/bin/factory decisions propose k '`id`' o",
  '/repo/bin/factory mail r1 plan "Fix #12 \\$HOME"',
  '/repo/bin/factory mail r1 plan "a <(b)"',
  "/repo/bin/factory mail r1 plan '$x'",
  '/repo/bin/factory mail r1 plan "a \\$(id)"',
  "S=/tmp/x-acme-factory/scratchpad\ncat > $S/b.md <<'EOF'\nit costs $(id)\nEOF",
]

test('the manager keeps the mod gate decisions and texts', () => {
  for (const [commands, decision] of [
    [ask, 'ask'],
    [deny, 'deny'],
    [allow, 'allow'],
  ] as const)
    for (const command of commands) {
      const g = gatedCommand(command)
      const expected =
        decision === 'allow'
          ? { decision }
          : decision === 'ask'
            ? { decision, question: g!.question, reason: g!.deny }
            : { decision, reason: g!.deny }
      expect([command, check(command, 'manager')]).toEqual([command, expected])
      const subagent = check(command, 'subagent')
      expect(subagent.decision).not.toBe('ask')
      if (decision !== 'allow') expect(subagent.decision).toBe('deny')
    }
})

test('factory settings set and unset ask the person for every key', () => {
  for (const key of [...SETTING_KEYS.map(s => s.key), ...DEVENV_KEYS])
    for (const command of [
      `/repo/bin/factory settings set ${key} v`,
      `/repo/bin/factory settings unset ${key}`,
    ]) {
      const g = gatedCommand(command)
      expect(g?.ask).toBe(true)
      expect(g!.question).toContain('change a factory setting')
      expect(g!.deny).toContain('did not confirm this settings change')
    }
})

test('the patrol rules preserve their order and exact reasons', () => {
  const bd =
    'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author. Write a bd command in literal words with bd as its first word: no $, backtick, glob, brace, # or <. Put other comment text in a file: bd comments add <id> -f <file>'
  const install =
    'a subagent never installs or rejects a skill or proposal: only the manager or the person installs'
  for (const [command, reason] of [
    ['bd label add x y', bd],
    ['bd close x', bd],
    ['bd update x --add-label y', bd],
    ['factory skills install x', install],
    ['/repo/bin/factory proposals reject x', install],
    ['bd update x --set-metadata a=b', 'a subagent never writes bead metadata'],
    [
      'factory decide r1 ok',
      'The person did not confirm this gate decision. Ask them which outcome they want. A patrol never decides this: leave it for the person.',
    ],
  ] as const)
    expect(check(command, 'subagent')).toEqual({ decision: 'deny', reason })
  for (const command of ['factory status', 'bd show x', 'bd comments x', 'bd list --metadata-field a=b'])
    expect(check(command, 'subagent')).toEqual({ decision: 'allow' })
})

const repeated = 'factory start factory wiki '.repeat(Math.ceil((256 * 1024) / 27))
const speed = [repeated, '#x\\\n' + repeated, '--owned init ' + repeated]

test('the lazy gate kinds finish within one second', () => {
  for (const command of speed) {
    const start = performance.now()
    check(command, 'manager')
    const ms = performance.now() - start
    console.log(`guard.check: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(1000)
  }
}, 30000)

test('the tail cut preserves each old match end', () => {
  const old = [/\bfactory\s+start\b[\s\S]*?--owned\b/g, /\bfactory\s+wiki\b[\s\S]*?\binit\b/g]
  const rows = [
    'factory start x --owned factory start y',
    'factory start --owned--owned factory start a --owned_x --owned',
    'factory wiki reinit init factory wiki initx',
    '--owned factory start a',
    'init factory wiki a',
    'factory start a factory wiki b',
    ...speed.map(t => t.slice(0, 4096)),
  ]
  for (const kind of GATED_KINDS) {
    const index = old.findIndex(re => re.source === kind.re.source)
    if (index < 0) {
      expect(kind.tail).toBeUndefined()
      continue
    }
    expect(kind.tail?.source).toBe(index === 0 ? '--owned\\b' : '\\binit\\b')
    for (const text of rows)
      expect(kindEnds(text, kind.re, kind.tail)).toEqual(
        [...text.matchAll(old[index]!)].map(m => m.index! + m[0].length),
      )
  }
  expect(old.every(re => GATED_KINDS.some(k => k.re.source === re.source))).toBe(true)
})

const BD_DENY_REASON =
  'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author. Write a bd command in literal words with bd as its first word: no $, backtick, glob, brace, # or <. Put other comment text in a file: bd comments add <id> -f <file>'

test('a subagent bd command with a shell expansion or a hidden bd argv is denied', () => {
  const DENY = [
    'bd comment acme-1 approved --ac$()tor zperson',
    String.raw`bd comment acme-1 approved $'\x2d\x2dactor' zperson`,
    String.raw`printf '\x2d\x2dactor\nzperson\n' | xargs bd comment acme-1 approved`,
    'x=; bd comment acme-1 approved --ac${x}tor zperson',
    'BEADS_AC$()TOR=zperson bd comment acme-1 approved',
    'bd comments add acme-1 approved -$()a zperson',
    'bd comments add acme-1 approved --au$()thor zperson',
    'bd comment acme-1 approved --ac{t,}or zperson',
    'bd comments add acme-1 approved -{a,} zperson',
    'bd show acme-1 {x',
    'bd show acme-1 x}',
    'bd comment acme-1 approved --ac$X',
    'bd comment acme-1 approved --ac?or zperson',
    'bd comment acme-1 approved --ac*',
    'bd comment acme-1 approved --ac[t]or zperson',
    'bd comment acme-1 approved ~/x',
    'bd comment acme-1 approved "--ac$(echo)tor" zperson',
    'bd comment acme-1 approved "--ac`echo`tor" zperson',
    'bd show acme-1 \\',
    String.raw`sh -c x\;bd comment acme-1 approved --ac'$()'tor zperson`,
    String.raw`echo x \| bd show acme-1`,
    'bd comments add acme-1 -f - <<EOF\nx\nEOF',
    'bd comments add acme-1 -f - <<<x',
    'bd show acme-1 # x',
    'bd show acme-1\r',
    'bd show acme-1 é',
    "bd comment acme-1 'open",
    'bd show acme-1 !x',
    'bd show acme-1 (x)',
    'env bd comment acme-1 approved',
    'command bd show acme-1',
    'xargs bd show',
    'echo acme-1 | xargs -n1 bd show',
    "sh -c 'bd show acme-1'",
    "sh -c 'x;bd comment acme-1 approved --ac$()tor zperson'",
    "eval 'x;bd show acme-1'",
    "bash -c '\nbd comment acme-1 approved --ac$()tor zperson'",
    'bash -c "x;bd comment acme-1 approved --ac{t,}or zperson"',
    "'bd' show acme-1",
    '"/usr/local/bin/"bd show acme-1',
    'timeout 5 bd show acme-1',
    'FOO=1 bd show acme-1',
    "bd comment acme-1 'ran bd show'",
    'echo tag acme-1 factory | xargs bd\nshow',
    'bd\nshow acme-1',
    'bd \t\nready',
    'echo tag acme-1 factory | xargs bd\r\nshow',
    'bd ready --claim --label factory',
    'bd ready --claim',
    'bd ready --claim=true --json',
    'bd ready --json --claim',
    "bd ready '--claim'",
    'bd ready --clai',
    'bd ready --cla',
    'acme-bd show acme-1',
    'echo \\\\\nbd comment acme-1 approved zz',
  ]
  const ALLOW = [
    'bd list --json | jq',
    'bd show acme-1',
    "bd list --json | jq '.[] | .id'",
    "bd list --json | jq -r '.[0].id'",
    'bd comment acme-1 "queued it; P2 (see PR 9)"',
    '/usr/local/bin/bd show acme-1',
    'bd show acme-1\nbd ready --json',
    'grep -rn -- --claim src',
    '/Users/x/.nix-profile/bin/BD show acme-1',
    'cd /repo/acme; bd ready --json',
    'bd show acme-1 && bd list --label factory',
    'ls $HOME',
    'echo "$(date)"',
    String.raw`bd comment acme-1 approved "a\"b"`,
    String.raw`bd comment acme-1 approved \x`,
    String.raw`bd comment acme-1 'it'\''s queued'`,
    String.raw`bd comment acme-1 approved --ac\$\(\)tor`,
  ]
  expect(DENY.filter(r => check(r, 'subagent').decision !== 'deny')).toEqual([])
  expect(ALLOW.filter(r => check(r, 'subagent').decision !== 'allow')).toEqual([])
  for (const r of DENY)
    expect([r, check(r, 'subagent')]).toEqual([r, { decision: 'deny', reason: BD_DENY_REASON }])
  for (const r of ALLOW) expect([r, check(r, 'subagent')]).toEqual([r, { decision: 'allow' }])
})

test('the subagent bd guard finishes within one second', () => {
  for (const row of [
    'bd show x; '.repeat(30000),
    '/bd'.repeat(100000),
    '-bd'.repeat(100000),
    'bd/'.repeat(100000),
  ]) {
    const t0 = Date.now()
    check(row, 'subagent')
    expect(Date.now() - t0, row.slice(0, 12)).toBeLessThan(1000)
  }
}, 30000)
