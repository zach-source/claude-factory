import { expect, mock, test } from 'claude-code/testing'

// raises the kit's 5000ms default, as in gate.test.ts (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

const BT = '`'
const F = '/repo/bin/factory'

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

test('a substitution in a factory command asks the person and does not run on Deny', SLOW, async ($, on) => {
  const { n, questions } = harness(on, 'Deny')
  for (const command of [...GATED, ...UNREADABLE]) {
    const asked = n.asked
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny, command).toContain('shell substitution')
    expect(n.asked, command).toBe(asked + 1)
  }
  expect(n.ran).toBe(0)
  expect(questions[9]).toContain('shell substitution')
})

test('Allow runs a gated substitution command', SLOW, async ($, on) => {
  const { n } = harness(on, 'Allow')
  const r = await $.tool.call({ tool: 'Bash', command: GATED[0]!, description: 'x' })
  expect(r.deny).toBeUndefined()
  expect(n.ran).toBe(1)
})

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

test('the Allow question shows the first hit even after a long harmless prefix', SLOW, async ($, on) => {
  const { n, questions } = harness(on, 'Deny')
  const pad = 'a'.repeat(350)
  const rows: [string, string][] = [
    [`${F} mail r1 plan "${pad} $(id)"`, '$(id)'],
    [`${F} mail r1 plan "${pad} ${BT}id${BT}"`, `${BT}id${BT}`],
    [`${F} mail r1 plan ${pad}<<EOF\nit's $(id)\nEOF`, '<<EOF'],
    [`${F} mail r1 plan ${pad} 'open ${'b'.repeat(100)}`, "'open"],
  ]
  for (const [command, shown] of rows) {
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny, command).toContain('shell substitution')
    expect(questions.at(-1), command).toContain(shown)
  }
  expect(n.ran).toBe(0)
})

test('a short gated command shows in full in the question', SLOW, async ($, on) => {
  const { questions } = harness(on, 'Deny')
  await $.tool.call({ tool: 'Bash', command: GATED[0]!, description: 'x' })
  expect(questions[0]).toContain(GATED[0]!)
})

test('the question window does not split a surrogate pair', SLOW, async ($, on) => {
  const { questions } = harness(on, 'Deny')
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/
  for (let k = 0; k < 2; k++) {
    const command = `${F} mail r1 plan "${'a'.repeat(350)}${'😀'.repeat(30 + k)}${'a'.repeat(k)} $(id)"`
    await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(questions.at(-1)).toContain('$(id)')
    expect(questions.at(-1)).not.toMatch(lone)
  }
})

test('the question window is surrogate-safe at the end edge and at index 0', SLOW, async ($, on) => {
  const { questions } = harness(on, 'Deny')
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/
  const rows = [0, 2].map(k => `${F} mail r1 plan "$(id)${'a'.repeat(k)}${'😀'.repeat(30)}"`)
  rows.push(`\uDC00${F} mail r1 plan "$(id)"`)
  for (const command of rows) {
    await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(questions.at(-1)).toContain('$(id)')
    const around = questions.at(-1)!.split('«')[1]!
    expect(around).toContain('$(id)')
    if (!command.startsWith('\uDC00')) expect(lone.test(around)).toBe(false)
  }
})
