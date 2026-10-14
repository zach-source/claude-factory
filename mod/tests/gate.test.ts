import { expect, test } from 'claude-code/testing'

const DECIDE = '/repo/bin/factory decide lifecycle-abc ship "looks good"'
const ANSWER = '/repo/bin/factory decisions answer api api-7 "use postgres"'
const START_OWNED = '/repo/bin/factory start lifecycle api api-9 --owned'

test('the model decides a gate only after the person confirms it', async ($, on) => {
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

test('the model answers a bd decision or starts an owner-only bead only after the person confirms it', async (
  $,
  on,
) => {
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

  const deniedAnswer = await $.tool.call({ tool: 'Bash', command: ANSWER, description: 'answer a decision' })
  expect(deniedAnswer.deny).toContain('did not confirm')
  expect(ran).toBe(0)

  const deniedStart = await $.tool.call({ tool: 'Bash', command: START_OWNED, description: 'start owned bead' })
  expect(deniedStart.deny).toContain('did not confirm')
  expect(ran).toBe(0)

  answer = 'Allow'
  const allowedAnswer = await $.tool.call({ tool: 'Bash', command: ANSWER, description: 'answer a decision' })
  expect(allowedAnswer.deny).toBeUndefined()
  expect(ran).toBe(1)

  const allowedStart = await $.tool.call({ tool: 'Bash', command: START_OWNED, description: 'start owned bead' })
  expect(allowedStart.deny).toBeUndefined()
  expect(ran).toBe(2)

  expect(asked).toBe(4)

  // a start with no --owned is the model reading/queuing a run as usual: never gated
  await $.tool.call({ tool: 'Bash', command: '/repo/bin/factory start lifecycle api "fix the thing"', description: 'start' })
  expect(asked).toBe(4)
  expect(ran).toBe(3)
})

test('a line continuation or a quoted newline still gates the command', async ($, on) => {
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
  const denied1 = await $.tool.call({ tool: 'Bash', command: continuationDecide, description: 'decide a gate' })
  expect(denied1.deny).toContain('did not confirm')

  // an earlier argument carrying a real (not escaped) newline inside its quotes, before --owned
  const quotedNewlineStart = '/repo/bin/factory start lifecycle api "a\nmulti-line title" --owned'
  const denied2 = await $.tool.call({ tool: 'Bash', command: quotedNewlineStart, description: 'start owned bead' })
  expect(denied2.deny).toContain('did not confirm')

  expect(asked).toBe(2)
})
