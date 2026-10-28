// `factory goto` end to end (claude-factory-7dd): a repeat goto and a goto that the machine holds at
// once are refused; a good goto queues one line and the next tick applies it.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Ev, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `goto-cli-${process.pid}`)
const home = join(dir, 'home')
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, BEADS_ACTOR, FACTORY_DEF_NAME, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_GC: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const DEF: Factory = {
  name: 'ship',
  start: 'implement',
  nodes: {
    implement: { prompt: 'do it', next: { ready: 'review' } },
    review: { prompt: 'check', next: { changes: 'implement', approve: 'done' }, rounds: 1 },
  },
}

let n = 0
/** a run after `events`, saved with `cursor`, and an inbox of `pending` lines */
function makeRun(def: Factory, events: Ev[], pending: object[] = [], cursor = 0) {
  rmSync(dir, { recursive: true, force: true })
  const id = `ship-${Date.now().toString(36)}x${n++}`
  const d = join(home, 'runs', id)
  const wt = join(dir, id)
  mkdirSync(wt, { recursive: true })
  mkdirSync(d, { recursive: true })
  const file = join(d, 'factory.ts')
  writeFileSync(file, `export default ${JSON.stringify(def)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: file, repo: wt, goal: 'g', ws: 'w1', worktree: wt, branch: 'b' }),
  )
  const actor = createActor(compile(def)).start()
  actor.send({ type: 'TICK', at: 0 })
  for (const e of events) actor.send(e)
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), pending.map(e => JSON.stringify(e) + '\n').join(''))
  return { id, d, lines: () => readFileSync(join(d, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean) }
}

const heldByRounds: Ev[] = [
  { type: 'DONE', seq: 1, outcome: 'ready', summary: 'a', at: 1 },
  { type: 'DONE', seq: 2, outcome: 'changes', summary: 'b', at: 2 },
  { type: 'DONE', seq: 3, outcome: 'ready', summary: 'c', at: 3 },
  { type: 'DONE', seq: 4, outcome: 'changes', summary: 'd', at: 4 },
]

test('AC1: a goto is refused while an earlier goto waits for the next tick', () => {
  const r = makeRun(DEF, heldByRounds, [{ type: 'GOTO', node: 'implement', at: 5 }])
  const out = factory(['goto', r.id, 'implement'])
  expect(out.code).toBe(1)
  expect(out.err).toContain('queued')
  expect(out.err).toContain('next tick applies it')
  expect(r.lines().length).toBe(1)
})

test('AC1: an applied goto, or pending mail only, does not block a goto', () => {
  const applied = makeRun(DEF, heldByRounds, [{ type: 'GOTO', node: 'implement', at: 5 }], 1)
  expect(factory(['goto', applied.id, 'implement']).code).toBe(0)
  expect(applied.lines().length).toBe(2)
  const mail = makeRun(DEF, heldByRounds, [{ type: 'MAIL', from: 'manager', to: 'review', text: 'x', at: 5 }])
  expect(factory(['goto', mail.id, 'implement']).code).toBe(0)
})

test('AC2: a goto that the step budget holds at once is refused', () => {
  const held = makeRun({ ...DEF, maxSteps: 1 }, [])
  const out = factory(['goto', held.id, 'review'])
  expect(out.code).toBe(1)
  expect(out.err).toContain('step budget used up')
  expect(out.err).toContain('factory retry')
  expect(held.lines().length).toBe(0)
  const room = makeRun({ ...DEF, maxSteps: 5 }, [])
  expect(factory(['goto', room.id, 'review']).code).toBe(0)
})

test('AC3: the first goto on a run held by rounds queues one line; one tick moves it and keeps the mail', () => {
  const r = makeRun(DEF, heldByRounds)
  const state = () => JSON.parse(readFileSync(join(r.d, 'state.json'), 'utf8'))
  expect(state().snapshot.value).toEqual({ review: 'stuck' })
  const g = factory(['goto', r.id, 'implement'])
  expect(g.code).toBe(0)
  expect(g.out.trim()).toBe(`queued goto implement for ${r.id}: the next tick applies it`)
  expect(r.lines().length).toBe(1)
  expect(factory(['mail', r.id, 'implement', 'goto-mail-7dd']).code).toBe(0)
  const herdr = join(dir, 'ok-herdr')
  writeFileSync(
    herdr,
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "tab create") printf \'{"result":{"root_pane":{"pane_id":"p1"}}}\\n\' ;;',
      '  "pane run") exit 0 ;;',
      "  *) echo '{}' ;;",
      'esac',
    ].join('\n'),
  )
  chmodSync(herdr, 0o755)
  const tick = factory(['tick'], { FACTORY_HERDR: herdr, CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config') })
  expect(tick.code).toBe(0)
  const { snapshot } = state()
  expect(snapshot.value).toEqual({ implement: 'working' })
  expect(snapshot.context.seq).toBe(5)
  const brief = readFileSync(join(r.d, 'prompts', '5-implement.md'), 'utf8')
  expect(JSON.stringify(snapshot.context.mail.implement) + brief).toContain('goto-mail-7dd')
})
