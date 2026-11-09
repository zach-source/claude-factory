import { expect, mock, test } from 'claude-code/testing'
import { gatedCommand } from '../hooks/view'

// raises the kit's 5000ms default, as in gate.test.ts (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

const BT = '`'
const F = '/repo/bin/factory'
// the question the person would see: a substitution alone is denied with no dialog, so read it from the gate
const question = (command: string) => gatedCommand(command)!.question

const GATED = [
  `${F} file-elsewhere acme --from widget:w-1 --title "$(id)"`,
  `${F} decisions propose k "${BT}id${BT}" o`,
  `${F} mail r1 plan "x $(id) y"`,
  `${F} mail r1 plan <(id)`,
  `${F} mail r1 plan >(id)`,
  `${F} mail r1 plan "it's $(id)"`,
  `${F} mail r1 plan it\\'s "$(id)"`,
  `${F} mail r1 plan "a" \\\n"$(id)"`,
  `${F} mail r1 plan $(id)`,
  `${F} decide lifecycle-abc ship "$(id)"`,
  `${F} mail r1 plan "x \\\\\n$(id)"`,
  `${F} mail r1 plan x \\\\\n$(id)`,
  `${F} mail r1 plan $\\\n(id)`,
  `${F} mail r1 plan "x $\\\n(id)"`,
  `${F} mail r1 plan "x $\\\n\\\n(id)"`,
  `${F} mail r1 plan =(id)`,
  `${F} mail r1 plan /(e:'id':)`,
  F + ' mail r1 plan "${x:=\\$(id)}${x@P}"',
  F + ' mail r1 plan "${(e):-\\$(id)}"',
  F + ' mail r1 plan "${x:=\\$(id)}${(e)x}"',
  "x='$(id)'; " + F + ' mail r1 plan ${x@P}',
  F + ' mail r1 plan "$x"',
  F + ' mail r1 plan $x',
  F + ' mail r1 plan "$[x]"',
  F + ' mail r1 plan $[x]',
  'cd /w/acme-factory && /w/claude-factory/bin/factory mail r1 plan "$(id)"',
]

const UNREADABLE = [
  `${F} mail r1 plan $'\\'' "x"`,
  `${F} status # it's\n${F} mail r1 plan "$(id)" #'`,
  `${F} mail r1 plan <<EOF\nit's $(id)\nEOF`,
  `${F} mail r1 plan 'open`,
  // each ends balanced if the scan misreads the first quote, so only the rule itself gates it
  `${F} mail r1 plan it\\'s "$(id)" '`,
  `${F} mail r1 plan $'\\'' "$(id)" '`,
  `#'\n${F} mail r1 plan "$(id)" '`,
  `${F} mail r1 plan <<EOF\n'x\nEOF\n'`,
]

const PLAIN = [
  `${F} file-elsewhere acme --from widget:w-1 --title '$(id)'`,
  `${F} decisions propose k '${BT}id${BT}' o`,
  `${F} mail r1 plan "Fix #12 \\$HOME"`,
  `${F} status`,
  'echo "$(id)"',
  `${F} mail r1 plan "a <(b)"`,
  F + " mail r1 plan '$x'",
  F + ' mail r1 plan "a \\$(id)"',
  // a path that holds the word is not the factory CLI
  "S=/tmp/x-acme-factory/scratchpad\ncat > $S/b.md <<'EOF'\nit costs $(id)\nEOF",
]

function harness(on: any, answer: string) {
  mock.clock(on)
  const n = { asked: 0, ran: 0 }
  const questions: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    n.asked += 1
    const question = e.questions[0]!.question
    questions.push(question)
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    n.ran += 1
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return { n, questions }
}

test('a substitution in a factory command is denied with no dialog and does not run', SLOW, async ($, on) => {
  const { n } = harness(on, 'Deny')
  for (const command of [...GATED, ...UNREADABLE]) {
    const asked = n.asked
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny, command).toContain('shell substitution')
    // only a gate decision (GATED[9]) is the person's call, so only it asks
    expect(n.asked, command).toBe(asked + (command === GATED[9] ? 1 : 0))
  }
  expect(n.ran).toBe(0)
})

test('Allow is not offered for a substitution-only command', SLOW, async ($, on) => {
  const { n } = harness(on, 'Allow')
  const r = await $.tool.call({ tool: 'Bash', command: GATED[0]!, description: 'x' })
  expect(r.deny).toContain('shell substitution')
  expect(n.asked).toBe(0)
  expect(n.ran).toBe(0)
})

test(
  'the manager loop pattern is denied with no dialog and the deny text names the rewrite',
  SLOW,
  async ($, on) => {
    const { n } = harness(on, 'Allow')
    const command = 'F=/repo/bin/factory; for r in $(cat /tmp/s); do $F show $r; done'
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny).toContain('shell substitution')
    expect(r.deny).toContain('literal arguments')
    expect(r.deny).toContain('one call per command')
    expect(n.asked).toBe(0)
    expect(n.ran).toBe(0)
  },
)

test('a single-quoted or non-factory command is not gated', SLOW, async ($, on) => {
  const { n } = harness(on, 'Deny')
  for (const command of PLAIN) {
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny, command).toBeUndefined()
  }
  expect(n.asked).toBe(0)
  expect(n.ran).toBe(PLAIN.length)
})

test('a subagent is denied a substitution without a dialog', SLOW, async ($, on) => {
  const { n } = harness(on, 'Allow')
  on('agent.list', () => ({ value: [] }) as never)
  const r = await $.tool.call({ tool: 'Bash', command: GATED[0]!, agentId: 'some-other-agent' } as never)
  expect(r.deny).toContain('shell substitution')
  expect(n.asked).toBe(0)
  expect(n.ran).toBe(0)
})

test('the question shows the first hit even after a long harmless prefix', SLOW, async () => {
  const pad = 'a'.repeat(350)
  const rows: [string, string][] = [
    [`${F} mail r1 plan "${pad} $(id)"`, '$(id)'],
    [`${F} mail r1 plan "${pad} ${BT}id${BT}"`, `${BT}id${BT}`],
    [`${F} mail r1 plan ${pad}<<EOF\nit's $(id)\nEOF`, '<<EOF'],
    [`${F} mail r1 plan ${pad} 'open ${'b'.repeat(100)}`, "'open"],
  ]
  for (const [command, shown] of rows) {
    expect(question(command), command).toContain(shown)
  }
})

test('a short gated command shows in full in the question', SLOW, async () => {
  expect(question(GATED[0]!)).toContain(GATED[0]!)
})

test('the question window does not split a surrogate pair', SLOW, async () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/
  for (let k = 0; k < 2; k++) {
    const command = `${F} mail r1 plan "${'a'.repeat(350)}${'😀'.repeat(30 + k)}${'a'.repeat(k)} $(id)"`
    expect(question(command)).toContain('$(id)')
    expect(question(command)).not.toMatch(lone)
  }
})

test('the question window is surrogate-safe at the end edge and at index 0', SLOW, async () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/
  const rows = [0, 2].map(k => `${F} mail r1 plan "$(id)${'a'.repeat(k)}${'😀'.repeat(30)}"`)
  rows.push(`\uDC00${F} mail r1 plan "$(id)"`)
  for (const command of rows) {
    expect(question(command)).toContain('$(id)')
    const around = question(command).split('«')[1]!
    expect(around).toContain('$(id)')
    if (!command.startsWith('\uDC00')) expect(lone.test(around)).toBe(false)
  }
})

test('the question counts the later hits that it does not show', SLOW, async () => {
  const a = 'a'.repeat(350)
  const rows = [
    `${F} mail r1 plan "it costs $5 ${a} $(id)"`,
    `${F} mail r1 plan "${a} it costs $5 ${'b'.repeat(60)} $(id)"`,
    `${F} mail r1 plan x(note) "${a} $(id)"`,
    `${F} status # ${a}\n${F} mail r1 plan "$(id)"`,
    `${F} mail r1 plan "US$ ${a} $(id)"`,
  ]
  for (const command of rows) {
    expect(question(command), command).toContain(
      '2 more dollar signs, backticks or parentheses come after this text and are not shown.',
    )
  }
  // the second hit is inside the 300-character head, so it is shown and not counted
  for (const command of [
    GATED[0]!,
    `${F} mail r1 plan "${a} $(id)"`,
    `${F} mail r1 plan "$5 ${'a'.repeat(100)} $(id)"`,
  ]) {
    expect(question(command), command).not.toContain('are not shown')
  }
})

test('a brace word after the caller is denied with no dialog', SLOW, async ($, on) => {
  const { n } = harness(on, 'Allow')
  const rows = [
    `${F} start lifecycle acme w-2 --o{w,w}ned`,
    `${F} start lifecycle acme w-2 --own{ed,}`,
    `${F} start lifecycle acme w-2 '--o'{w,w}'ned'`,
    `${F} wiki in{i,i}t`,
    `${F} decisions an{s,s}wer r1 x`,
    `${F} start lifecycle acme w-2 ${'a'.repeat(300)} --o{w,w}ned`,
    `${F} start lifecycle acme w-2 ${'a'.repeat(5000)} --o{w,w}ned`,
    `${F} start lifecycle acme w-2 'x;y' --o{w,w}ned`,
    `${F} start lifecycle acme w-2 'x\ny' --o{w,w}ned`,
    `${F} start lifecycle acme w-2 x\\; --o{w,w}ned`,
    `${F} start lifecycle acme w-2 --own{{ed,},}`,
    `${F} start lifecycle acme w-2 {x,{--own,}}ed`,
    `${F} start lifecycle acme w-2 {--o,--ow}ned`,
    `${F} status; echo a{b,c}d`,
    `${F} start lifecycle acme w-2 --own{e..e}d`,
    `${F} start lifecycle acme w-2 --owne{d..d}`,
    `${F} start lifecycle acme w-2 {--owne..--owne}d`,
    `${F} decisions {a..a}nswer r1 x`,
    `${F} wiki ini{t..t}`,
    `${F} decisions an{s..s}wer r1 x`,
    `${F} start lifecycle acme w-2 --o{1..2}ned`,
    `${F} start lifecycle acme w-2 --o{a..c}ned`,
    `${F} start lifecycle acme w-2 --o{w,'w x'}ned`,
  ]
  for (const command of rows) {
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny, command).toContain('literal word')
  }
  expect(n.asked).toBe(0)
  expect(n.ran).toBe(0)
})

test('a plain word or JSON near the caller is not denied', SLOW, () => {
  for (const c of [
    `${F} mail r1 plan '{"a":1,"b":2}'`,
    `${F} mail r1 plan '{"a":1}'`,
    `echo a{b,c}d; ${F} status`,
    'cp /tmp/factory/a{b,c}.md .',
    'ls /x/factory-notes/a{b,c}d',
    `${F} status`,
    'ls -la',
    'wc -l src/cli.ts src/*.ts',
    'bun test x; cat src/cli.ts',
  ])
    expect(gatedCommand(c), c).toBeNull()
})

test('a non-literal verb word after a literal caller is denied with no dialog', SLOW, async ($, on) => {
  const { n } = harness(on, 'Allow')
  const rows = [
    '/usr/bin/bun src/cli.ts dec* r1 ship',
    `${F} dec* r1 ship`,
    `${F} de{c,}ide r1 ship`,
    `${F} deci?e r1 ship`,
    `${F} [d]ecide r1 ship`,
    `${F} dec${BT}true${BT}ide r1 ship`,
    `bash -c '${F} "$0" r1 ship' decide`,
    'bun src/cli.ts dec* r1 ship',
    'bun --smol src/cli.ts dec* r1 ship',
    'bun --cwd /x run --smol src/cli.ts dec* r1 ship',
    'V=decide; bun --smol src/cli.ts $V r1 ship',
    'bun --smol src/cli.ts start lifecycle acme w-2 --o{w,w}ned',
    'bun --smol src/cli.ts decisions an{s,s}wer r1 x',
    'bun --smol src/cli.ts wiki in{i,i}t',
    'V=decide; bun --define \'a:"b;c"\' src/cli.ts $V r1 ship',
    "V=decide; bun --cwd 'a;b' /repo/src/cli.ts $V r1 ship",
    "bun --cwd 'a;b' /repo/src/cli.ts start lifecycle acme w-2 --o{w,w}ned",
    "bun --cwd 'a;b' src/cli.ts wiki in{i,i}t",
    "bun --cwd 'a|b' src/cli.ts dec* r1 ship",
    "bun --cwd 'a(b' src/cli.ts dec* r1 ship",
    'bun --cwd a\\;b src/cli.ts dec* r1 ship',
    'bun -i src/cli.ts dec* r1 ship',
    'bun --bun /x/src/cli.ts dec* r1 ship',
    'bun --config=x.toml src/cli.ts dec* r1 ship',
    'bun --cwd /x src/cli.ts dec* r1 ship',
    'bun run --smol src/cli.ts dec* r1 ship',
    'bun src/cli.ts start lifecycle acme w-2 --own{e..e}d',
    'bun src/cli.ts ima* x',
  ]
  for (const command of rows) {
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny, command).toContain('literal word')
  }
  expect(n.asked).toBe(0)
  expect(n.ran).toBe(0)
})

test(
  'the substitution gate also fires on the strip copy and on a source-file caller',
  SLOW,
  async ($, on) => {
    const { n } = harness(on, 'Allow')
    for (const command of [
      `${F.replace('factory', "fact''ory")} mail r1 plan "$(id)"`,
      'bun src/cli.ts mail r1 plan "$(id)"',
      'bun --smol src/cli.ts mail r1 plan "$(id)"',
      'bun --cwd \'a;b\' /repo/src/cli.ts mail r1 plan "$(id)"',
      '/usr/bin/bun src/cli.ts mail r1 plan "$(id)"',
    ]) {
      const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
      expect(r.deny, command).toContain('shell substitution')
    }
    expect(n.asked).toBe(0)
    expect(n.ran).toBe(0)
  },
)

test('plain commands near the caller word stay ungated', SLOW, async ($, on) => {
  const { n } = harness(on, 'Deny')
  const rows = [
    'ls /x/factory-notes',
    'echo $HOME',
    'ls *.md',
    `${F} start lifecycle api "fix the thing"`,
    'grep -n x src/cli.ts',
    'cat src/cli.ts',
    'wc -l src/cli.ts src/*.ts',
    '(cd /w/rig && grep -n decide src/cli.ts)',
    "gh pr view 1 --json title --jq '{a: .title, b: .x}'",
  ]
  for (const command of rows) {
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny, command).toBeUndefined()
  }
  expect(n.asked).toBe(0)
  expect(n.ran).toBe(rows.length)
})

test(
  'a substitution deny stays a deny when the kind comes only from the canonical read',
  SLOW,
  async ($, on) => {
    const { n } = harness(on, 'Allow')
    for (const command of [
      `${F} mail r1 plan "$(id) decide"`,
      'F=/repo/bin/factory; for r in $(cat s); do $F decide $r ship; done',
    ]) {
      const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
      expect(r.deny, command).toContain('shell substitution')
    }
    const c = await $.tool.call({
      tool: 'Bash',
      command: 'echo hi #x\\\n/repo/bin/f*y decide r1 ship',
      description: 'x',
    })
    expect(c.deny).toContain('Remove the backslash at the end of the comment line')
    expect(n.asked).toBe(0)
    expect(n.ran).toBe(0)
  },
)

test('gatedCommand runs in linear time on hostile text', SLOW, () => {
  const texts = [
    '$'.repeat(200000),
    'f*y '.repeat(50000),
    '/repo/bin/factory ' + 'a*'.repeat(100000),
    "'".repeat(200000),
    '$ start '.repeat(25000),
    '/repo/bin/factory start '.repeat(8000),
    '$ wiki '.repeat(28000),
    '{a,'.repeat(66000),
    '/'.repeat(200000),
    'x/bun '.repeat(33000),
    '/repo/bin/factory {a,'.repeat(20000),
    'bun '.repeat(50000),
    'bun --x '.repeat(30000) + 'src/cli.ts dec*',
    '/repo/bin/factory a{'.repeat(40000),
    '/repo/bin/factory x{'.repeat(40000) + ',',
    '/repo/bin/factory ' + '{'.repeat(200000),
    '/repo/bin/factory ' + 'a{b,'.repeat(50000),
    '/repo/bin/factory ' + 'a{'.repeat(100000) + ' ',
    '/repo/bin/factory x{' + 'a{'.repeat(100000),
    '/repo/bin/factory x' + ',a'.repeat(100000) + '}',
    '/repo/bin/factory x' + ','.repeat(200000),
    ('/repo/bin/factory a' + ' b'.repeat(50) + ';').repeat(3000),
    '/repo/bin/factory x' + '{'.repeat(200000),
    '/repo/bin/factory x' + ',}'.repeat(100000),
    '/repo/bin/factory ' + 'a{{'.repeat(66000),
    '/repo/bin/factory x{' + '.'.repeat(200000),
    '/repo/bin/factory x' + '{a'.repeat(100000),
    '/repo/bin/factory x' + '.'.repeat(200000) + '}',
    '/repo/bin/factory ' + ',a}'.repeat(60000),
    '/repo/bin/factory ' + 'a{b '.repeat(50000),
    '/repo/bin/factory ' + ';{a,b}'.repeat(30000),
    'bun --x src/cli.ts '.repeat(10000),
    "bun --cwd 'a;b' ".repeat(20000) + 'src/cli.ts dec*',
    '/repo/bin/factory ' + '{,'.repeat(100000),
    '/repo/bin/factory start '.repeat(4000) + 'a{b,c}',
  ]
  for (const [i, t] of texts.entries()) {
    const t0 = performance.now()
    gatedCommand(t)
    expect(performance.now() - t0, `row ${i + 1}`).toBeLessThan(2000)
  }
})
