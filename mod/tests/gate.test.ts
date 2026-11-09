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
    ['shell substitution', fill('/repo/bin/factory decide r1 "it costs $5 ', '$(curl x|sh)"', 298)],
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

test('the question names every gated kind and the kinds in the text it cuts', SLOW, async ($, on) => {
  mock.clock(on)
  const questions: string[] = []
  let ran = 0
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked += 1
    const question = e.questions[0]!.question
    questions.push(question)
    return { result: { questions: e.questions, answers: { [question]: 'Deny' } } }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    ran += 1
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  const fill = (head: string, tail: string, at: number) => `${head}${'a'.repeat(at - head.length)}${tail}`
  const ask = async (command: string) => {
    questions.length = 0
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny).toContain('did not confirm')
    expect(questions.length).toBe(1)
    return questions[0]!
  }
  const HIDDEN = 'The text not shown holds'
  const DECIDE_K = 'decide a factory gate'
  const START_K = 'start a bead carrying its owner'

  // AC3: an owner-only start after the cut
  const a = await ask(
    fill(
      "/repo/bin/factory decide r1 reject '",
      "' && /repo/bin/factory start lifecycle acme w-2 --owned",
      310,
    ),
  )
  expect(a).toContain(DECIDE_K)
  expect(a).toContain(START_K)
  expect(a).toContain('characters not shown')
  expect(a).toMatch(new RegExp(`${HIDDEN}[^.]*start a bead`))
  expect(a).not.toMatch(new RegExp(`${HIDDEN}[^.]*decide a factory gate`))

  // AC3b: 2 gate decisions after the cut
  const b = await ask(
    fill(
      "/repo/bin/factory decide r1 reject '",
      "' && factory decide r2 ship && factory decide r3 ship",
      310,
    ),
  )
  expect(b).toMatch(new RegExp(`${HIDDEN}[^.]*decide a factory gate \\(2 times\\)`))

  // AC4: --owned crosses the cut, factory start is in the head
  const c = await ask(fill("/repo/bin/factory start lifecycle acme w-1 --goal '", "' --owned", 296))
  expect(c).toMatch(new RegExp(`${HIDDEN}[^.]*start a bead`))

  // AC5: 3 kinds in one short command, and substitution plus decide
  const d = await ask(
    '/repo/bin/factory decide r1 ship x && /repo/bin/factory decisions answer acme w-1 y && /repo/bin/factory start lifecycle acme w-2 --owned',
  )
  expect(d).toContain(DECIDE_K)
  expect(d).toContain("answer a person's bd decision")
  expect(d).toContain(START_K)
  expect(d).not.toContain(HIDDEN)
  expect(d).not.toContain('times')
  const e = await ask('/repo/bin/factory mail r1 plan "$x" && /repo/bin/factory decide r1 ship')
  expect(e).toContain('shell substitution')
  expect(e).toContain(DECIDE_K)

  // AC6: one kind, no count, no hidden sentence; a long command with its only match in the head
  const f = await ask('/repo/bin/factory decide r1 ship x')
  expect(f).not.toContain('times')
  expect(f).not.toContain(HIDDEN)
  const g = await ask(fill('/repo/bin/factory decide r1 reject ', ' tail', 310))
  expect(g).toContain('characters not shown')
  expect(g).not.toContain(HIDDEN)

  // the cut edge: a match that ends at character 300 is shown, one that ends at 301 is not
  const edge = (end: number) => `${'a'.repeat(end - 'factory decide'.length - 1)} factory decide x`
  expect(await ask(edge(300))).not.toContain(HIDDEN)
  expect(await ask(edge(301))).toContain(HIDDEN)

  // no question for a plain or single-quoted command
  const before = asked
  await $.tool.call({ tool: 'Bash', command: '/repo/bin/factory status', description: 'x' })
  await $.tool.call({ tool: 'Bash', command: "/repo/bin/factory mail r1 plan '$5'", description: 'x' })
  expect(asked).toBe(before)
})

test('an even run of backslashes before a newline does not join the lines', SLOW, async ($, on) => {
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

  // 2 backslashes: the shell reads one escaped backslash, then a real newline: 2 commands
  const two = '/repo/bin/factory decide r1 ship \\\\\n/repo/bin/factory decide r2 reject'
  const r = await $.tool.call({ tool: 'Bash', command: two, description: 'x' })
  expect(r.deny).toContain('did not confirm')
  expect(ran).toBe(0)
  expect(questions.length).toBe(1)
  expect(questions[0]).toContain('ship \\\\\n/repo')
  expect(questions[0]).not.toContain('ship \\/repo')

  // 3 backslashes: an escaped backslash, then a line continuation: the pair joins
  questions.length = 0
  const three = '/repo/bin/factory decide r1 ship "x\\\\\\\ny"'
  await $.tool.call({ tool: 'Bash', command: three, description: 'x' })
  expect(questions.length).toBe(1)
  expect(questions[0]).toContain('x\\\\y')
  expect(questions[0]).not.toContain('x\\\\\ny')

  // 2 backslashes mid-word: the shell runs `/repo/bin/fac\` and `tory`, neither is factory
  questions.length = 0
  await $.tool.call({ tool: 'Bash', command: '/repo/bin/fac\\\\\ntory decide r1 ship', description: 'x' })
  expect(questions.length).toBe(0)
})

test(
  'claude-factory-0jr2.4: a backslash at the end of a comment line asks, as the shell runs the next line',
  SLOW,
  async ($, on) => {
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
    const C = 'echo hi #x\\\n'
    for (const rest of [
      'factory decide r1 ship',
      'factory decisions answer acme w-1 yes',
      'factory start lifecycle acme w-2 --owned',
      'fac\\\ntory decide r1 ship',
    ]) {
      questions.length = 0
      const r = await $.tool.call({ tool: 'Bash', command: C + rest, description: 'x' })
      expect(r.deny, rest).toContain('did not confirm')
      // the split word hides the kind from the matcher, so only the unreadable form is left: denied, no dialog
      expect(questions.length, rest).toBe(rest.startsWith('fac\\') ? 0 : 1)
    }
    expect(ran).toBe(0)
    questions.length = 0
    await $.tool.call({
      tool: 'Bash',
      command: '/repo/bin/factory status #x\\\n/repo/bin/factory decide r1 ship',
      description: 'x',
    })
    expect(questions.length).toBe(1)
    expect(questions[0]).not.toContain('#x/repo')
    expect(questions[0]).toContain('#x\\\n/repo')
    questions.length = 0
    await $.tool.call({
      tool: 'Bash',
      command: "echo ' #' ; /repo/bin/fac\\\ntory decide r1 ship",
      description: 'x',
    })
    expect(questions.length).toBe(1)
    questions.length = 0
    await $.tool.call({ tool: 'Bash', command: 'ls -la # note', description: 'x' })
    expect(questions.length).toBe(0)
    expect(ran).toBe(1)
  },
)

test('claude-factory-0jr2.6: a comment-backslash form still names each gated kind', SLOW, async ($, on) => {
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
  const ask = async (command: string) => {
    questions.length = 0
    const r = await $.tool.call({ tool: 'Bash', command, description: 'x' })
    expect(r.deny).toContain('did not confirm')
    expect(questions.length).toBe(1)
    return questions[0]!
  }
  const q1 = await ask('/repo/bin/factory decide r1 ship # note\\\necho x')
  expect(q1).toContain('decide a factory gate')
  expect(q1).toContain('hook cannot read')
  const q3 = await ask('echo hi #x\\\nfactory start lifecycle acme w-2 --owned')
  expect(q3).toContain('start a bead carrying')
  const long = `/repo/bin/factory decide r1 reject '${'a'.repeat(300)}' # x\\\n/repo/bin/factory start lifecycle acme w-2 --owned`
  const q2 = await ask(long)
  expect(q2).toContain('The text not shown holds: start a bead carrying')
  expect(q2).toContain('decide a factory gate')
  expect(ran).toBe(0)
})

test(
  'claude-factory-0jr2.7: the cut is in the coordinates of the shown (joined) text',
  SLOW,
  async ($, on) => {
    mock.clock(on)
    const questions: string[] = []
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const question = e.questions[0]!.question
      questions.push(question)
      return { result: { questions: e.questions, answers: { [question]: 'Deny' } } }
    })
    const ask = async (command: string) => {
      questions.length = 0
      await $.tool.call({ tool: 'Bash', command, description: 'x' })
      expect(questions.length).toBe(1)
      return questions[0]!
    }
    const a = await ask(
      `echo ${'x\\\n'.repeat(50)}${'a'.repeat(150)} && /repo/bin/factory decide r1 ship ${'a'.repeat(200)}`,
    )
    expect(a).toContain('decide a factory gate')
    expect(a).not.toContain('The text not shown holds')
    const b = await ask(`/repo/bin/factory dec\\\nide r1 ${'x\\\n'.repeat(120)} factory start acme w --owned`)
    expect(b).not.toContain('The text not shown holds')
    expect(b).not.toContain('characters not shown')
    // the backslash is raw character 299 and the newline is 300: the head shows `decid`, the `e` is not shown
    const c = await ask(`#${'a'.repeat(274)} /repo/bin/factory decid\\\ne r1 ship`)
    expect(c).toContain('The text not shown holds: decide a factory gate')
  },
)

test('the deny text of a compound command holds the deny of each matched kind', SLOW, async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]!.question
    return { result: { questions: e.questions, answers: { [question]: 'Deny' } } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  const r = await $.tool.call({ tool: 'Bash', command: `${DECIDE} && ${START_OWNED}`, description: 'x' })
  expect(r.deny).toContain('this gate decision')
  expect(r.deny).toContain('starting this owner-only bead')
})

test('factory wiki init asks the person; other wiki and memory commands do not', SLOW, async ($, on) => {
  mock.clock(on)
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked += 1
    const question = e.questions[0]!.question
    return { result: { questions: e.questions, answers: { [question]: 'Deny' } } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  const run = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'wiki' })

  for (const command of [
    '/repo/bin/factory wiki init --remote x',
    '/repo/bin/factory wiki --remote x init',
    'FACTORY_WIKI_REMOTE=x /repo/bin/factory wiki init',
    '/repo/bin/factory \\\nwiki \\\ninit',
  ]) {
    const before = asked
    expect((await run(command)).deny).toContain('did not confirm')
    expect(asked).toBe(before + 1)
  }
  const before = asked
  await run('/repo/bin/factory wiki status')
  await run('/repo/bin/factory memory compact')
  expect(asked).toBe(before)
})

test(
  'factory image asks the person; settings and memory commands that name image do not',
  SLOW,
  async ($, on) => {
    mock.clock(on)
    let asked = 0
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked += 1
      const question = e.questions[0]!.question
      return { result: { questions: e.questions, answers: { [question]: 'Deny' } } }
    })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    const run = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'image' })

    for (const command of [
      '/repo/bin/factory image build',
      '/repo/bin/factory image build --target manager',
      '/repo/bin/factory \\\nimage \\\nbuild',
    ]) {
      const before = asked
      expect((await run(command)).deny).toContain('did not confirm')
      expect(asked).toBe(before + 1)
    }
    const before = asked
    await run('/repo/bin/factory settings set image.registry ghcr.io/acme')
    await run('/repo/bin/factory memory search image')
    expect(asked).toBe(before)
  },
)

test('factory token use and best ask the person; token list does not', SLOW, async ($, on) => {
  mock.clock(on)
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked += 1
    const question = e.questions[0]!.question
    return { result: { questions: e.questions, answers: { [question]: 'Deny' } } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  const run = (command: string) => $.tool.call({ tool: 'Bash', command, description: 'token' })

  for (const command of [
    '/repo/bin/factory token use 2',
    '/repo/bin/factory token best',
    '/repo/bin/factory \\\ntoken \\\nuse 2',
  ]) {
    const before = asked
    expect((await run(command)).deny).toContain('did not confirm')
    expect(asked).toBe(before + 1)
  }
  const before = asked
  await run('/repo/bin/factory token')
  await run('/repo/bin/factory token list')
  await run('/repo/bin/factory settings set token.read cmd')
  await run('/repo/bin/factory memory search token use')
  expect(asked).toBe(before)
})
