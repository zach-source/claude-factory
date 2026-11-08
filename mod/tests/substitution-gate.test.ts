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
