import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as view from '../../mod/hooks/view'
import { GATED_KINDS, kindEnds } from '../../mod/hooks/view'
import { check, INSTALL_VERB, META_WRITE, PATROL_VERB, bdWrite, gatedCommand } from './guards'

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
  '/repo/bin/factory status',
  '/repo/bin/factory start lifecycle api "fix the thing"',
  "/repo/bin/factory mail r1 plan '$5'",
  '/repo/bin/factory wiki status',
  '/repo/bin/factory memory compact',
  '/repo/bin/factory settings set image.registry ghcr.io/acme',
  '/repo/bin/factory memory search image',
  '/repo/bin/factory token',
  '/repo/bin/factory token list',
  '/repo/bin/factory settings set token.read cmd',
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

test('the patrol rules preserve their order and exact reasons', () => {
  const bd =
    'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author'
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
