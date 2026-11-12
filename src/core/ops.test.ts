import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CATALOG, OpError, type Ctx, type Input, type Port } from './catalog'

type Call = [string, ...unknown[]]
const fake = () => {
  const calls: Call[] = []
  const cli: string[][] = []
  const port: Port = {
    gcPass: () => {},
    gcWorktreesPass: () => {},
    gcRigs: () => [],
    gcHold: () => () => {},
    gcStamp: () => {},
    imageBuild: async target => (calls.push(['imageBuild', target]), 'ref'),
    show: async id => (calls.push(['show', id]), { ok: 1 }),
    status: async (id, print) => (calls.push(['status', id]), print('line')),
    backlog: async () => (calls.push(['backlog']), []),
    prs: async () => (calls.push(['prs']), []),
    decisionsList: () => (calls.push(['decisionsList']), {}),
    planShowText: () => (calls.push(['planShowText']), 'plan'),
    gateBriefFacts: async id => (calls.push(['gateBriefFacts', id]), {}),
    records: () => (calls.push(['records']), []),
    flowData: async () => ({
      def: { name: 'f', start: 'a', nodes: { a: { prompt: 'p', next: { done: 'done' } } } },
      runs: [],
    }),
    refreshMerges: async recs => (calls.push(['refreshMerges', recs]), recs),
    managerUsage: since => (calls.push(['managerUsage', typeof since]), []),
    rigList: async print => (calls.push(['rigList']), print('rig')),
    decide: async (id, outcome, note, print) => (calls.push(['decide', id, outcome, note]), print('decided')),
    decisionsAnswer: (rig, bead, text, print) => (
      calls.push(['decisionsAnswer', rig, bead, text]),
      print('answered')
    ),
    goto: async (id, node, print) => (calls.push(['goto', id, node]), print('queued')),
    abort: id => void calls.push(['abort', id]),
    screen: async id => (calls.push(['screen', id]), 'screen text'),
    say: text => void calls.push(['say', text]),
    managerImage: async image => void calls.push(['managerImage', image]),
    managerSuspend: async on => void calls.push(['managerSuspend', on]),
    mail: async (m, who, print) => (calls.push(['mail', m, who]), print('mailed')),
    chatRun: async () => ({ code: 0, out: '' }),
    chatModel: async () => ({
      isOk: true,
      text: '',
      reason: 'success',
      durationMs: 0,
      commands: [],
      calls: [],
    }),
  }
  const home = mkdtempSync(join(tmpdir(), 'ops-'))
  const ctx = (env: Record<string, string | undefined> = {}): Ctx => ({
    home,
    env,
    port,
    board: () => ({}),
    cli: async argv => (cli.push(argv), { code: 0, out: '', err: '' }),
  })
  return { calls, cli, ctx }
}
const run = (name: string, ctx: Ctx, input: Input) => CATALOG.find(o => o.name === name)!.run(ctx, input)

describe('n69b2 core gc', () => {
  const setup = (env: Record<string, string | undefined> = {}, held = false, broken = false) => {
    const t = fake()
    const effects: unknown[][] = []
    const ctx = t.ctx(env)
    ctx.port = new Proxy(t.ctx().port, {
      get: (target, key) => {
        if (!String(key).startsWith('gc')) return Reflect.get(target, key)
        return (...args: any[]) => {
          effects.push([key, ...args.filter(a => typeof a !== 'function')])
          if (key === 'gcHold') return held ? undefined : () => effects.push(['release'])
          if (key === 'gcRigs') return ['acme']
          if (key === 'gcPass' || key === 'gcWorktreesPass') {
            args[2](String(key))
            args[3]('diagnostic')
            if (broken) throw new Error('pass failed')
          }
        }
      },
    })
    return { ...t, ctx, effects }
  }
  const gc = (t: ReturnType<typeof setup>, i: unknown = {}) => run('gc.run', t.ctx, i as Input)

  test('n69b2 AC1 AC2 defaults, modes, output isolation, and no CLI bridge', async () => {
    const rows: [Input, Record<string, string>, unknown[][]][] = [
      [{}, {}, [['gcHold', 'gc.lock'], ['gcStamp', 'gc.stamp'], ['gcPass', 7, false], ['release']]],
      [
        { dryRun: true },
        { FACTORY_GC_DAYS: '.5' },
        [['gcHold', 'gc.lock'], ['gcStamp', 'gc.stamp'], ['gcPass', 0.5, true], ['release']],
      ],
      [
        { days: '+1e2' },
        { FACTORY_GC_DAYS: 'invalid' },
        [['gcHold', 'gc.lock'], ['gcStamp', 'gc.stamp'], ['gcPass', 100, false], ['release']],
      ],
      [
        { worktrees: true },
        { FACTORY_GC_DAYS: 'invalid' },
        [
          ['gcHold', 'gc-worktrees.lock'],
          ['gcStamp', 'gc-worktrees.stamp'],
          ['gcWorktreesPass', false, undefined],
          ['release'],
        ],
      ],
      [
        { worktrees: true, rig: 'acme', dryRun: true },
        {},
        [['gcRigs'], ['gcHold', 'gc-worktrees.lock'], ['gcWorktreesPass', true, 'acme'], ['release']],
      ],
    ]
    for (const [input, env, effects] of rows) {
      const t = setup(env)
      const mode = input.worktrees ? 'gcWorktreesPass' : 'gcPass'
      for (let n = 0; n < 2; n++) {
        expect(await gc(t, input)).toEqual({ code: 0, out: `${mode}\n`, err: 'diagnostic\n' })
      }
      expect(t.effects).toEqual([...effects, ...effects])
      expect(t.cli).toEqual([])
    }
  })

  test('n69b2 AC2 rejects malformed input before any protected effect', async () => {
    const bad: unknown[] = [
      null,
      [],
      'gc',
      { home: '/x' },
      { dryRun: false },
      { worktrees: false },
      { dryRun: 'true' },
      { worktrees: 1 },
      { days: 7 },
      { rig: 'acme' },
      { worktrees: true, days: '7' },
      { worktrees: true, rig: '../acme' },
      { worktrees: true, rig: '' },
      { worktrees: true, rig: 1 },
      ...['0', '-1', 'NaN', 'Infinity', '1e999', ' 7', '7 ', '0x7', '7days', ''].map(days => ({ days })),
    ]
    for (const input of bad) {
      const t = setup()
      expect((await gc(t, input)).code).toBe(1)
      expect(t.effects).toEqual([])
    }
    for (const days of ['0', 'Infinity', ' 7', '0x7']) {
      const t = setup({ FACTORY_GC_DAYS: days })
      expect((await gc(t)).code).toBe(1)
      expect(t.effects).toEqual([])
    }
  })

  test('n69b2 AC2 each caller marker refuses both modes, including preview', async () => {
    for (const env of [
      { FACTORY_FROM: 'implement' },
      { FACTORY_RUN: 'r1' },
      { FACTORY_DEF_NAME: 'lifecycle' },
      { BEADS_ACTOR: 'factory/r1/implement' },
      { FACTORY_PATROL: '1' },
    ]) {
      for (const input of [{}, { dryRun: true }, { worktrees: true }, { worktrees: true, dryRun: true }]) {
        const t = setup(env)
        expect((await gc(t, input)).code).toBe(1)
        expect(t.effects).toEqual([])
      }
    }
  })

  test('n69b2 AC4 held locks skip effects, errors release locks, and unknown rigs fail before locks', async () => {
    for (const worktrees of [false, true]) {
      const input = worktrees ? { worktrees: true } : {}
      const held = setup({}, true)
      const result = await gc(held, input)
      expect(result.code).toBe(0)
      expect(result.out).toContain('skipped this one')
      expect(held.effects).toEqual([['gcHold', worktrees ? 'gc-worktrees.lock' : 'gc.lock']])
      const broken = setup({}, false, true)
      expect(await gc(broken, input)).toEqual({
        code: 1,
        out: `${worktrees ? 'gcWorktreesPass' : 'gcPass'}\n`,
        err: 'diagnostic\nfactory: pass failed\n',
      })
      expect(broken.effects.at(-1)).toEqual(['release'])
    }
    const t = setup()
    expect((await gc(t, { worktrees: true, rig: 'unknown' })).code).toBe(1)
    expect(t.effects).toEqual([['gcRigs']])
  })
})

describe('moved reads run in process (AC1)', () => {
  const rows: [string, Input, Call[]][] = [
    ['runs.show', { id: 'r1' }, [['show', 'r1']]],
    ['runs.screen', { id: 'r1' }, [['screen', 'r1']]],
    ['runs.status', { run: 'r1' }, [['status', 'r1']]],
    ['runs.status', {}, [['status', undefined]]],
    ['prs.show', {}, [['prs']]],
    ['backlog.show', {}, [['backlog']]],
    ['decisions.list', {}, [['decisionsList']]],
    ['plan.show', {}, [['planShowText']]],
    ['gates.brief', { id: 'r1' }, [['gateBriefFacts', 'r1']]],
    ['lease.show', {}, []],
    ['rigs.list', {}, [['rigList']]],
    ['gates.decide', { id: 'r1', outcome: 'approve', note: 'ok' }, [['decide', 'r1', 'approve', 'ok']]],
    ['gates.decide', { id: 'r1', outcome: 'approve' }, [['decide', 'r1', 'approve', '']]],
    [
      'decisions.answer',
      { rig: 'acme', bead: 'b1', text: 'yes' },
      [['decisionsAnswer', 'acme', 'b1', 'yes']],
    ],
    ['runs.goto', { id: 'r1', node: 'plan' }, [['goto', 'r1', 'plan']]],
    ['runs.abort', { id: 'r1' }, [['abort', 'r1']]],
    ['runners.show', {}, []],
    ['mail.list', {}, []],
    ['steps.reports', {}, []],
    ['metrics.show', {}, [['records'], ['refreshMerges', []]]],
    [
      'metrics.show',
      { since: '7d', tokens: true },
      [['records'], ['refreshMerges', []], ['managerUsage', 'number']],
    ],
  ]
  for (const [name, input, want] of rows)
    test(`${name} ${JSON.stringify(input)} calls the port and never ctx.cli`, async () => {
      const t = fake()
      const r = await run(name, t.ctx(), input)
      expect(r.code).toBe(0)
      expect(t.calls).toEqual(want)
      expect(t.cli).toEqual([])
    })

  test('the operations that still call ctx.cli are the changes', async () => {
    const dummy = (k: string, values?: string[]) =>
      k === 'enum' ? values![0]! : k === 'flag' ? true : k === 'path' ? '/x' : 'r1'
    const bridged: string[] = []
    for (const op of CATALOG) {
      const t = fake()
      const input: Input = {}
      for (const f of op.inputs) if (f.required) input[f.name] = dummy(f.kind, f.values)
      await op.run(t.ctx(), input).catch(e => {
        if (!(e instanceof OpError)) throw e // the dummy input fails a validator: no CLI call
      })
      if (t.cli.length) bridged.push(op.name)
    }
    expect(bridged).toEqual([
      'backlog.queue',
      'factory.halt',
      'gates.setbrief',
      'memory.add',
      'memory.search',
      'plan.facts',
      'plan.set',
      'review.facts',
      'review.set',
      'rigs.adopt',
      'rigs.set',
      'rigs.unhold',
      'runs.fork',
      'runs.poke',
      'runs.remove',
      'runs.retry',
      'runs.start',
    ])
  })
})

describe('a failure gives the CLI line (inProc)', () => {
  test('a thrown Error gives code 1, the lines before it and factory: on err', async () => {
    const t = fake()
    const ctx = t.ctx()
    ctx.port.status = async (_id, print) => {
      print('first')
      throw new Error('no run "x"')
    }
    expect(await run('runs.status', ctx, { run: 'x' })).toEqual({
      code: 1,
      out: 'first\n',
      err: 'factory: no run "x"\n',
    })
  })
  test('flows.show gives the graph as JSON; a bad since gives a reason', async () => {
    const r = await run('flows.show', fake().ctx(), { since: '1h' })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toMatchObject({ factory: 'f', nodes: [{ id: 'a', rank: 0 }], moves: [] })
    expect((await run('flows.show', fake().ctx(), { since: 'soon' })).err).toContain('since must be')
  })
  test('a bad since gives the usage line', async () => {
    const r = await run('metrics.show', fake().ctx(), { since: '0d' })
    expect(r).toEqual({
      code: 1,
      out: '',
      err: 'factory: usage: factory metrics [--rig r] [--since <days>d] [--json] [--tokens]\n',
    })
  })
})

describe('runners.show and mail.list read the board', () => {
  const withBoard = (b: unknown): Ctx => ({ ...fake().ctx(), board: () => b })
  for (const name of ['runners.show', 'mail.list'])
    for (const b of [null, undefined])
      test(`${name} with board ${b} throws 503 no tick yet`, async () => {
        const e = await run(name, withBoard(b), {}).catch(x => x)
        expect(e).toBeInstanceOf(OpError)
        expect(e.status).toBe(503)
        expect(e.message).toBe('no tick yet')
      })
  test('runners.show of an empty board has the herdr group', async () => {
    expect((await run('runners.show', withBoard({}), {})).out).toBe(
      '[{"name":"herdr","busy":0,"rigs":[],"runs":[]}]\n',
    )
  })
  test('runners.show projects the rigs and the runs', async () => {
    const rigs = [
      { name: 'a', repo: '/x', factory: 'lifecycle' },
      {
        name: 'b',
        runner: 'ax',
        sandboxClass: 'kata',
        maxRuns: 0,
        env: { K: 'zqsecret' },
        goal: 'g',
        repo: '/y',
        factory: 'lifecycle',
      },
    ]
    const runs = [
      { id: 'r1', rig: 'a', node: 'verify', sub: 'working', model: 'm1', pane: 'p1' },
      {
        id: 'r2',
        rig: 'b',
        node: 'g',
        sub: 'working',
        gate: { question: 'q', outcomes: ['approve'] },
        pane: null,
      },
      { id: 'r3', rig: 'a', node: 'done' },
      { id: 'r4', error: 'boom' },
      { id: 'r5', node: 'plan', sub: 'waiting', pane: 'ax://t1' },
    ]
    const r = await run('runners.show', withBoard({ rigs, runs }), {})
    expect(r.out).toBe(
      '[{"name":"herdr","busy":1,"rigs":[{"name":"a"}],"runs":[{"id":"r1","rig":"a","node":"verify","sub":"working","model":"m1","pane":"p1"}]},{"name":"ax","busy":0,"rigs":[{"name":"b","runner":"ax","sandboxClass":"kata","maxRuns":0}],"runs":[{"id":"r2","rig":"b","node":"g","sub":"working","pane":null},{"id":"r5","node":"plan","sub":"waiting","pane":"ax://t1"}]}]\n',
    )
    for (const w of ['zqsecret', 'goal', '/y']) expect(r.out).not.toContain(w)
  })
  test('runners.show counts rigs or runs that are not arrays as empty', async () => {
    expect((await run('runners.show', withBoard({ rigs: 'x', runs: 'x' }), {})).out).toBe(
      '[{"name":"herdr","busy":0,"rigs":[],"runs":[]}]\n',
    )
  })
  test('mail.list gives the manager mail as one JSON line', async () => {
    const m = [
      { from: 'a', text: 'x' },
      { from: 'b', text: 'y' },
    ]
    expect((await run('mail.list', withBoard({ manager: m }), {})).out).toBe(JSON.stringify(m) + '\n')
    expect((await run('mail.list', withBoard({}), {})).out).toBe('[]\n')
    expect((await run('mail.list', withBoard({ manager: 'x' }), {})).out).toBe('[]\n')
  })
})

describe('steps.reports reads the last entry of each step log', () => {
  const files = {
    patrol: 'patrol-log.jsonl',
    pm: 'pm-log.jsonl',
    brief: 'brief-log.jsonl',
    review: 'review-log.jsonl',
  }
  test('no log files gives four nulls', async () => {
    const r = await run('steps.reports', fake().ctx(), {})
    expect(r.out).toBe('{"patrol":null,"pm":null,"brief":null,"review":null}\n')
  })
  test('each key gives the last entry that parses of its own file', async () => {
    const ctx = fake().ctx()
    for (const [k, f] of Object.entries(files))
      writeFileSync(
        join(ctx.home, f),
        `${JSON.stringify({ k, n: 1 })}\n${JSON.stringify({ k, n: 2 })}\n{"k":"${k}","n":`,
      )
    const r = await run('steps.reports', ctx, {})
    expect(JSON.parse(r.out)).toEqual({
      patrol: { k: 'patrol', n: 2 },
      pm: { k: 'pm', n: 2 },
      brief: { k: 'brief', n: 2 },
      review: { k: 'review', n: 2 },
    })
  })
  test('a file with only bad lines gives null', async () => {
    const ctx = fake().ctx()
    writeFileSync(join(ctx.home, files.pm), 'x\n{\n')
    expect(JSON.parse((await run('steps.reports', ctx, {})).out).pm).toBeNull()
  })
})

describe('lease.show keeps the worker rules (AC6)', () => {
  const worker = /^factory: a worker cannot run factory lease \(/
  const rows: [Record<string, string>, RegExp][] = [
    [{ FACTORY_FROM: 'x' }, worker],
    [{ FACTORY_RUN: 'x' }, worker],
    [{ FACTORY_DEF_NAME: 'x' }, worker],
    [{ BEADS_ACTOR: 'factory/x' }, worker],
    [{ FACTORY_PATROL: '1' }, /^factory: a patrol cannot run factory lease/],
  ]
  for (const [env, err] of rows)
    test(`refuses ${JSON.stringify(env)}`, async () => {
      const r = await run('lease.show', fake().ctx(env), {})
      expect(r.code).toBe(1)
      expect(r.err).toMatch(err)
      expect(r.out).toBe('')
    })
  for (const env of [{}, { BEADS_ACTOR: 'person' }])
    test(`allows ${JSON.stringify(env)}`, async () => {
      const r = await run('lease.show', fake().ctx(env), {})
      expect(r).toEqual({ code: 0, out: 'nobody holds the manager lease\n', err: '' })
    })
})

describe('decide and answer check the caller in ctx.env (AC4)', () => {
  const ops: [string, Input, Call[], RegExp, RegExp][] = [
    [
      'gates.decide',
      { id: 'r1', outcome: 'approve', note: '' },
      [['decide', 'r1', 'approve', '']],
      /^factory: a worker cannot decide a gate: mail the manager instead\n$/,
      /^factory: a patrol cannot decide a gate: leave it for the person\n$/,
    ],
    [
      'decisions.answer',
      { rig: 'acme', bead: 'b1', text: 'yes' },
      [['decisionsAnswer', 'acme', 'b1', 'yes']],
      /^factory: a worker cannot answer the person's decisions: mail the manager instead\n$/,
      /^factory: a patrol cannot answer the person's decisions: leave it for them\n$/,
    ],
  ]
  for (const [name, input, call, worker, patrol] of ops) {
    const markers: Record<string, string>[] = [
      { FACTORY_FROM: 'x' },
      { FACTORY_RUN: 'x' },
      { FACTORY_DEF_NAME: 'x' },
      { BEADS_ACTOR: 'factory/x' },
    ]
    for (const env of markers)
      test(`${name} refuses ${JSON.stringify(env)} with no port call`, async () => {
        const t = fake()
        const r = await run(name, t.ctx(env), input)
        expect(r.code).toBe(1)
        expect(r.err).toMatch(worker)
        expect(t.calls).toEqual([])
      })
    test(`${name} refuses a patrol with no port call`, async () => {
      const t = fake()
      const r = await run(name, t.ctx({ FACTORY_PATROL: '1' }), input)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(patrol)
      expect(t.calls).toEqual([])
    })
    for (const env of [{}, { BEADS_ACTOR: 'person' }, { FACTORY_PATROL: '' }])
      test(`${name} allows ${JSON.stringify(env)}`, async () => {
        const t = fake()
        expect((await run(name, t.ctx(env), input)).code).toBe(0)
        expect(t.calls).toEqual(call)
      })
  }
})

describe('goto and abort check the worker rules in ctx.env (AC4)', () => {
  const ops: [string, Input, Call[]][] = [
    ['runs.goto', { id: 'r1', node: 'plan' }, [['goto', 'r1', 'plan']]],
    ['runs.abort', { id: 'r1' }, [['abort', 'r1']]],
  ]
  for (const [name, input, call] of ops) {
    const verb = name.split('.')[1]
    const markers: Record<string, string>[] = [
      { FACTORY_FROM: 'x' },
      { FACTORY_RUN: 'x' },
      { FACTORY_DEF_NAME: 'x' },
      { BEADS_ACTOR: 'factory/x' },
    ]
    for (const env of markers)
      test(`${name} refuses ${JSON.stringify(env)} with no port call`, async () => {
        const t = fake()
        const r = await run(name, t.ctx(env), input)
        expect(r.code).toBe(1)
        expect(r.err).toMatch(new RegExp(`^factory: a worker cannot run factory ${verb} \\(`))
        expect(t.calls).toEqual([])
      })
    for (const env of [{}, { FACTORY_PATROL: '1' }])
      test(`${name} allows ${JSON.stringify(env)}`, async () => {
        const t = fake()
        expect((await run(name, t.ctx(env), input)).code).toBe(0)
        expect(t.calls).toEqual(call)
      })
  }
})

describe('runs.mail gives the request cwd and the ctx env to the port (AC1, AC4)', () => {
  const base = { id: 'r1', to: 'plan', text: 'hi', from: 'manager', cwd: '/x' }
  const m = { id: 'r1', to: 'plan', text: 'hi', wake: false }
  test('calls the port with the mail, the env of ctx and the cwd', async () => {
    const t = fake()
    const env = { HOME_MARK: 'a' }
    expect((await run('runs.mail', t.ctx(env), base)).code).toBe(0)
    expect(t.calls).toEqual([['mail', m, { env, cwd: '/x' }]])
    expect((t.calls[0]![2] as { env: unknown }).env).toBe(env)
    expect(t.cli).toEqual([])
  })
  test('wake:true gives wake:true', async () => {
    const t = fake()
    await run('runs.mail', t.ctx(), { ...base, wake: true })
    expect(t.calls[0]![1]).toEqual({ ...m, wake: true })
  })
  test('the end of the text is cut, as the text file form cut it', async () => {
    const t = fake()
    await run('runs.mail', t.ctx(), { ...base, text: 'hi\n\n' })
    expect(t.calls[0]![1]).toEqual(m)
  })
  test('a text of only blanks rejects with 422 and makes no port call', async () => {
    const t = fake()
    const e = await run('runs.mail', t.ctx(), { ...base, text: ' \n' }).catch(x => x)
    expect(e).toBeInstanceOf(OpError)
    expect(e.status).toBe(422)
    expect(t.calls).toEqual([])
  })
  for (const cwd of [undefined, true])
    test(`a cwd of ${cwd} fails closed with no port call`, async () => {
      const t = fake()
      const input: Input = { id: 'r1', to: 'plan', text: 'hi', from: 'manager' }
      if (cwd !== undefined) input.cwd = cwd
      const r = await run('runs.mail', t.ctx(), input)
      expect(r).toEqual({
        code: 1,
        out: '',
        err: 'factory: mail needs the working directory of the sender\n',
      })
      expect(t.calls).toEqual([])
    })
})
