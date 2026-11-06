import { expect, mock, test } from 'claude-code/testing'

// raises the kit's 5000ms default: under high shared-host load the first `$` call in each of
// this file's tests (the plugin's own startup) can outlast 5000ms (claude-factory-abm)
const SLOW = { timeoutMs: 30_000 }

const DECIDE = '/repo/bin/factory decide lifecycle-abc ship "looks good"'
const ANSWER = '/repo/bin/factory decisions answer api api-7 "use postgres"'
const START_OWNED = '/repo/bin/factory start lifecycle api api-9 --owned'

test('the model decides a gate only after the person confirms it', SLOW, async ($, on) => {
  mock.clock(on) // a touched 'decide' command reads $.clock.now(), to hold that run from a patrol
  let answer = 'Deny'
  let asked = 0
  let ran = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked += 1
    const question = e.questions[0]!.question
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    ran += 1
    return { result: { stdout: 'decided', stderr: '', interrupted: false } }
  })

  const denied = await $.tool.call({ tool: 'Bash', command: DECIDE, description: 'decide a gate' })
  expect(denied.deny).toContain('did not confirm')
  expect(ran).toBe(0)

  answer = 'Allow'
  const allowed = await $.tool.call({ tool: 'Bash', command: DECIDE, description: 'decide a gate' })
  expect(allowed.deny).toBeUndefined()
  expect(ran).toBe(1)

  // anything else passes through without asking
  await $.tool.call({ tool: 'Bash', command: '/repo/bin/factory status', description: 'status' })
  expect(asked).toBe(2)
  expect(ran).toBe(2)
})

test(
  'the model answers a bd decision or starts an owner-only bead only after the person confirms it',
  SLOW,
  async ($, on) => {
    let answer = 'Deny'
    let asked = 0
    let ran = 0
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked += 1
      const question = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [question]: answer } } }
    })
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    const deniedAnswer = await $.tool.call({
      tool: 'Bash',
      command: ANSWER,
      description: 'answer a decision',
    })
    expect(deniedAnswer.deny).toContain('did not confirm')
    expect(ran).toBe(0)

    const deniedStart = await $.tool.call({
      tool: 'Bash',
      command: START_OWNED,
      description: 'start owned bead',
    })
    expect(deniedStart.deny).toContain('did not confirm')
    expect(ran).toBe(0)

    answer = 'Allow'
    const allowedAnswer = await $.tool.call({
      tool: 'Bash',
      command: ANSWER,
      description: 'answer a decision',
    })
    expect(allowedAnswer.deny).toBeUndefined()
    expect(ran).toBe(1)

    const allowedStart = await $.tool.call({
      tool: 'Bash',
      command: START_OWNED,
      description: 'start owned bead',
    })
    expect(allowedStart.deny).toBeUndefined()
    expect(ran).toBe(2)

    expect(asked).toBe(4)

    // a start with no --owned is the model reading/queuing a run as usual: never gated
    await $.tool.call({
      tool: 'Bash',
      command: '/repo/bin/factory start lifecycle api "fix the thing"',
      description: 'start',
    })
    expect(asked).toBe(4)
    expect(ran).toBe(3)
  },
)

test('a line continuation or a quoted newline still gates the command', SLOW, async ($, on) => {
  mock.clock(on) // a touched 'decide' command reads $.clock.now(), to hold that run from a patrol
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked += 1
    const question = e.questions[0]!.question
    return { result: { questions: e.questions, answers: { [question]: 'Deny' } } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))

  // a shell line continuation (backslash then newline) between "factory" and "decide": the shell drops
  // both characters before running it, so this is one `factory decide ...` command
  const continuationDecide = '/repo/bin/factory \\\ndecide lifecycle-abc ship "looks good"'
  const denied1 = await $.tool.call({
    tool: 'Bash',
    command: continuationDecide,
    description: 'decide a gate',
  })
  expect(denied1.deny).toContain('did not confirm')

  // an earlier argument carrying a real (not escaped) newline inside its quotes, before --owned
  const quotedNewlineStart = '/repo/bin/factory start lifecycle api "a\nmulti-line title" --owned'
  const denied2 = await $.tool.call({
    tool: 'Bash',
    command: quotedNewlineStart,
    description: 'start owned bead',
  })
  expect(denied2.deny).toContain('did not confirm')

  // the shell drops the backslash-newline with NO character, even mid-word: "fac<\\\n>tory" runs as "factory",
  // not "fac tory". Joining with a space instead would leave a gap the keyword regexes don't match.
  const midWordSplitDecide = '/repo/bin/fac\\\ntory decide lifecycle-abc ship "looks good"'
  const denied3 = await $.tool.call({
    tool: 'Bash',
    command: midWordSplitDecide,
    description: 'decide a gate',
  })
  expect(denied3.deny).toContain('did not confirm')

  const midWordSplitStart = '/repo/bin/factory start lifecycle api api-9 --own\\\ned'
  const denied4 = await $.tool.call({
    tool: 'Bash',
    command: midWordSplitStart,
    description: 'start owned bead',
  })
  expect(denied4.deny).toContain('did not confirm')

  expect(asked).toBe(4)
})

test('a long gated command marks the cut in the Allow question', SLOW, async ($, on) => {
  mock.clock(on)
  const questions: string[] = []
  let ran = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]!.question
    questions.push(question)
    return { result: { questions: e.questions, answers: { [question]: 'Deny' } } }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    ran += 1
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  const fill = (head: string, tail: string, at: number) => `${head}${'a'.repeat(at - head.length)}${tail}`
  const mark = (c: string, shown = 300) => `… (${c.length - shown} of ${c.length} characters not shown)`
  const ask = async (command: string) => {
    questions.length = 0
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny).toContain('did not confirm')
    expect(questions.length).toBe(1)
    return questions[0]!
  }

  const rows: [string, string][] = [
    [
      'decide a factory gate',
      fill("/repo/bin/factory decide r1 reject '", "' && /repo/bin/factory decide r2 ship", 310),
    ],
    [
      "answer a person's bd decision",
      fill(
        "/repo/bin/factory decisions answer acme w-1 '",
        "' && /repo/bin/factory start lifecycle acme w-2 --owned",
        310,
      ),
    ],
    [
      'start a bead carrying',
      fill(
        "/repo/bin/factory start lifecycle acme w-1 --owned --goal '",
        "' && /repo/bin/factory mail r1 plan x",
        310,
      ),
    ],
    ['shell substitution', fill('/repo/bin/factory mail r1 plan "it costs $5 ', '$(curl x|sh)"', 298)],
  ]
  for (const [kind, command] of rows) {
    const q = await ask(command)
    expect(q).toContain(kind)
    expect(q).toContain(mark(command))
  }

  const head = "/repo/bin/factory decide r1 reject '"
  const exact = `${head}${'a'.repeat(299 - head.length)}'`
  expect(exact.length).toBe(300)
  expect(await ask(exact)).not.toContain('characters not shown')
  const over = `${head}${'a'.repeat(300 - head.length)}'`
  expect(await ask(over)).toContain('(1 of 301 characters not shown)')
  const emoji = `${head}${'a'.repeat(299 - head.length)}😀 tail'`
  const q = await ask(emoji)
  expect(q).toContain(mark(emoji, 299))
  expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(q)).toBe(false)
  expect(ran).toBe(0)
})
