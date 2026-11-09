import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CATALOG, type Ctx, type Input, type Port } from './catalog'

type Call = [string, ...unknown[]]
const fake = () => {
  const calls: Call[] = []
  const cli: string[][] = []
  const port: Port = {
    show: async id => (calls.push(['show', id]), { ok: 1 }),
    status: async (id, print) => (calls.push(['status', id]), print('line')),
    backlog: async () => (calls.push(['backlog']), []),
    prs: async () => (calls.push(['prs']), []),
    decisionsList: () => (calls.push(['decisionsList']), {}),
    planShowText: () => (calls.push(['planShowText']), 'plan'),
    gateBriefFacts: async id => (calls.push(['gateBriefFacts', id]), {}),
    records: () => (calls.push(['records']), []),
    refreshMerges: async recs => (calls.push(['refreshMerges', recs]), recs),
    managerUsage: since => (calls.push(['managerUsage', typeof since]), []),
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

describe('moved reads run in process (AC1)', () => {
  const rows: [string, Input, Call[]][] = [
    ['runs.show', { id: 'r1' }, [['show', 'r1']]],
    ['runs.status', { run: 'r1' }, [['status', 'r1']]],
    ['runs.status', {}, [['status', undefined]]],
    ['prs.show', {}, [['prs']]],
    ['backlog.show', {}, [['backlog']]],
    ['decisions.list', {}, [['decisionsList']]],
    ['plan.show', {}, [['planShowText']]],
    ['gates.brief', { id: 'r1' }, [['gateBriefFacts', 'r1']]],
    ['lease.show', {}, []],
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
      await op.run(t.ctx(), input)
      if (t.cli.length) bridged.push(op.name)
    }
    expect(bridged).toEqual([
      'decisions.answer',
      'factory.halt',
      'gates.decide',
      'runs.abort',
      'runs.goto',
      'runs.mail',
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
  test('a bad since gives the usage line', async () => {
    const r = await run('metrics.show', fake().ctx(), { since: '0d' })
    expect(r).toEqual({
      code: 1,
      out: '',
      err: 'factory: usage: factory metrics [--rig r] [--since <days>d] [--json] [--tokens]\n',
    })
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
