import { expect, test } from 'claude-code/testing'

const DECIDE = '/repo/bin/factory decide lifecycle-abc ship "looks good"'

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
