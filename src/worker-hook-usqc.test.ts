import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  denyReason,
  SHELL_ALIAS_REASON,
  SHELL_WORDS,
  shellSnapshotAliases,
  shellSnapshotFunctions,
  type HookGate,
} from './worker-hook'

// claude-factory-usqc: the shell expands an alias only in command position. A word after an external
// command word is not alias-scanned, unless some segment of the call is not a flat external command.
const TABLE = (): Map<string, string | null> =>
  new Map<string, string | null>([
    ['wget', 'wget -c'],
    ['gc', 'git commit'],
    ['gp', 'git push'],
    ['k', 'kubectl'],
    ['ls', 'eza'],
    ['bad', null],
  ])
const gateWith = (shellFunctions?: HookGate['shellFunctions']): HookGate => ({
  headOf: () => 'factory/x',
  originHead: () => 'main',
  gitAliases: () => new Map<string, string>(),
  ghAliases: () => new Map<string, string>(),
  shellAliases: TABLE,
  shellFunctions,
})
const U = gateWith(() => new Set(['myf']))
const verdict = (cmd: string, gate: HookGate = U) => denyReason(cmd, '/w', undefined, gate)

const WGET = `kubectl exec -n monitoring pod -- wget -qO- --post-data='query=count(m{a="b"})' http://x:8080/q`
const W = `kubectl exec p -- wget --post-data='q={a="b"}' u`
const AC1 = [
  WGET,
  "git log --format='%h %s' gc",
  "echo 'a b' gp",
  "bd show x gc | grep 'a b' wget",
  'echo bad',
]

test('AC1: an alias word after an external command word is allowed', () => {
  for (const row of AC1) expect(verdict(row)).toBeUndefined()
})

test('AC2: an alias word in command position still denies', () => {
  const rows = [
    'gp origin main',
    'echo x && gp',
    'echo x; gp',
    'echo x | gp',
    'echo x\ngp',
    '(gp)',
    '{ gp; }',
    'if gp; then :; fi',
    'FOO=1 gp',
    '>/tmp/x gp',
    'sudo gp',
    'env gp',
    'nohup gp',
    'time gp',
    'noglob gp',
    '- gp',
    'command gp',
    'builtin gp',
    'exec gp',
    'xargs gp',
    'timeout 5 gp',
    'eval gp',
    'trap gp EXIT',
    'echo $(gp)',
    'echo `gp`',
    'cat <(gp)',
    "bash -c 'gp'",
    'echo a &! gp',
    'echo a &| gp',
    'echo a |& gp',
    'echo a ;| gp',
    `wget --post-data='query=count(m{a="b"})' u`,
    'bad x',
    'MYF gp',
    'myf gp',
    'EVAL gp',
  ]
  for (const row of rows) expect([row, verdict(row)]).toEqual([row, SHELL_ALIAS_REASON])
})

test('AC3: a segment that is not a flat external command turns the skip off for the whole call', () => {
  const rows = [
    `${W}; if :; then :; fi`,
    `if :; then :; fi; ${W}`,
    `k exec p -- wget --post-data='q={a="b"}' u`,
    `FOO=1; ${W}`,
    `myf x; ${W}`,
    `eval x; ${W}`,
    `echo "$(if :; then :; fi)"; ${W}`,
  ]
  for (const row of rows) expect([row, verdict(row)]).toEqual([row, SHELL_ALIAS_REASON])
  expect(verdict(W)).toBeUndefined()
  const defs = [
    'f() { eval "$1"; }; f gp',
    'echo ${ f(){ eval $1;}; }; f gp',
    "eval 'f(){ eval $1;}'; f gp",
    'autoload -Uz f; f gp',
  ]
  for (const row of defs) expect([row, verdict(row)]).toEqual([row, expect.any(String)])
})

test('AC4: without a trusted function list every argument word is scanned', () => {
  const gates = [
    gateWith(),
    gateWith(() => undefined),
    gateWith(() => new Set(['command_not_found_handler'])),
    gateWith(() => new Set(['command_not_found_handle'])),
  ]
  for (const gate of gates)
    for (const row of AC1) expect([row, verdict(row, gate)]).toEqual([row, SHELL_ALIAS_REASON])
})

test('Q2: a path word, a variable word or a leading-dash word is not a flat command word', () => {
  for (const first of ['/usr/bin/kubectl', './kubectl', '$K', '-kubectl', 'k*'])
    expect([first, verdict(`${first} x; ${W}`)]).toEqual([first, SHELL_ALIAS_REASON])
})

test('Q5: a snapshot function name is not a flat command word, in any letter case', () => {
  expect(verdict("myf 'a b' gp")).toBe(SHELL_ALIAS_REASON)
  expect(verdict("MyF 'a b' gp")).toBe(SHELL_ALIAS_REASON)
  expect(verdict("other 'a b' gp")).toBeUndefined()
})

// AC5: the reader
const snapDir = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'usqc-'))
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
  return dir
}

test('AC5: shellSnapshotFunctions reads every function form', () => {
  const dir = snapDir({
    'snapshot-zsh-1.sh': [
      'a1 () {',
      '  echo x',
      '}',
      '\ta2 () {',
      'function a3 {',
      'function a4() {',
      '-- () {',
      '-ftb-x () {',
      "alias -- notfn='x () {'",
      'echo plain',
    ].join('\n'),
  })
  const got = shellSnapshotFunctions(dir)!
  expect([...got].sort()).toEqual(['--', '-ftb-x', 'a1', 'a2', 'a3', 'a4'])
})

test('AC5: shellSnapshotFunctions gives an empty Set for a missing folder and undefined for a read error', () => {
  expect(shellSnapshotFunctions(join(tmpdir(), 'usqc-missing-acme'))?.size).toBe(0)
  expect(
    shellSnapshotFunctions(snapDir({ 'snapshot-zsh-1.sh': 'x'.repeat(4 * 1024 * 1024 + 1) })),
  ).toBeUndefined()
  const bad = snapDir({})
  mkdirSync(join(bad, 'snapshot-zsh-1.sh'))
  expect(shellSnapshotFunctions(bad)).toBeUndefined()
})

test('AC5: both readers take the newest three files and share one read', () => {
  const dir = snapDir({})
  for (let i = 1; i <= 4; i++) {
    const p = join(dir, `snapshot-zsh-${i}.sh`)
    writeFileSync(p, `f${i} () {\nalias -- a${i}=x\n`)
    const t = new Date(2026, 0, i)
    utimesSync(p, t, t)
  }
  expect([...shellSnapshotFunctions(dir)!].sort()).toEqual(['f2', 'f3', 'f4'])
  expect([...shellSnapshotAliases(dir)!.keys()].sort()).toEqual(['a2', 'a3', 'a4'])
  let reads = 0
  const read = () => (reads++, ['g () {\nalias -- b=x\n'])
  expect([...shellSnapshotFunctions(dir, read)!]).toEqual(['g'])
  expect([...shellSnapshotAliases(dir, read)!.keys()]).toEqual(['b'])
  expect(reads).toBe(2)
})

test('AC5: denyReason reads shellFunctions once', () => {
  let n = 0
  const gate = gateWith(() => (n++, new Set<string>()))
  verdict("echo x && echo 'a b' gp; echo y | cat", gate)
  expect(n).toBe(1)
})

test('AC5: the spawned hook allows an argument alias word and denies a command alias word', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'cfg-'))
  mkdirSync(join(cfg, 'shell-snapshots'))
  writeFileSync(
    join(cfg, 'shell-snapshots', 'snapshot-zsh-1.sh'),
    "alias -- wget='wget -c'\nalias -- gp='git push'\nmyf () {\n}\n",
  )
  const call = async (command: string) => {
    const p = Bun.spawn(['bun', join(import.meta.dir, 'worker-hook.ts')], {
      stdin: new Blob([JSON.stringify({ tool_name: 'Bash', tool_input: { command } })]),
      stdout: 'pipe',
      env: {
        ...process.env,
        FACTORY_OUTBOX: '',
        FACTORY_FROM: '',
        FACTORY_SELF_UPDATE: '0',
        CLAUDE_CONFIG_DIR: cfg,
      },
    })
    return (await new Response(p.stdout).text()).trim()
  }
  expect(await call(WGET)).toBe('')
  expect(await call(`myf x; ${W}`)).toContain(SHELL_ALIAS_REASON.slice(0, 40))
  expect(await call('gp origin main')).toContain(SHELL_ALIAS_REASON.slice(0, 40))
}, 30_000)

// AC6: the shell word list
test('AC6: SHELL_WORDS holds every bash 5 builtin and reserved word', async () => {
  if (!Bun.which('bash')) return
  const out = await new Response(
    Bun.spawn(['bash', '-c', 'compgen -b; compgen -k'], { stdout: 'pipe' }).stdout,
  ).text()
  const words = out.split('\n').filter(Boolean)
  expect(words.length).toBeGreaterThan(50)
  expect(words.filter(w => !SHELL_WORDS.has(w))).toEqual([])
})

test('AC6: SHELL_WORDS holds every zsh builtin and reserved word (runs only where zsh is on PATH)', async () => {
  if (!Bun.which('zsh')) return
  const out = await new Response(
    Bun.spawn(['zsh', '-fc', 'print -l ${(k)builtins} ${(k)reswords}'], { stdout: 'pipe' }).stdout,
  ).text()
  const words = out.split('\n').filter(Boolean)
  expect(words.length).toBeGreaterThan(50)
  expect(words.filter(w => !SHELL_WORDS.has(w))).toEqual([])
})
