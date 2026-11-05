// `factory decisions`, end to end through bin/factory: every rig's open bd decisions, answering one, and the
// manager's proposed options for an item that has none. A fake `bd` on PATH stands in for the real CLI.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `decisions-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const calls = join(dir, 'calls.log')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    // FACTORY_SELF_UPDATE=0: this dev worktree's own branch is never 'main', so a real kick
    // would refuse and mail the manager a new "branch is ..., not main" reason, landing in
    // `home` on a later tick and inflating manager-mail assertions (claude-factory-5h9.8)
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

/** a fake bd: answers human list / ready --json from env JSON (bd prints null, not [], for an empty human list),
 * and logs every other call (human respond, comment) so the test can read back what was sent */
function fakeBd(humanJson: string, readyJson: string) {
  mkdirSync(bin, { recursive: true })
  // printf, not echo: this shell's echo expands \n in single-quoted text, breaking JSON string escapes
  const script = [
    '#!/bin/sh',
    `case "$1 $2" in`,
    `"human list") printf '%s' '${humanJson}';;`,
    `"ready --json") printf '%s' '${readyJson}';;`,
    `*) echo "$*" >> ${calls}; echo answered;;`,
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

function rig(name: string) {
  const r = join(dir, name)
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  factory(['rig', 'add', name, r])
  return r
}

test("decisions lists every rig's human-flagged and owner-only beads, one rig's bd error isolated from the rest", () => {
  rmSync(dir, { recursive: true, force: true })
  const ok = rig('ok')
  const broken = rig('broken')
  fakeBd(
    JSON.stringify([
      { id: 'ok-1', title: 'Which DB?', description: 'Question: Which DB?\nOptions: pg | mysql' },
    ]),
    JSON.stringify([{ id: 'ok-2', title: 'A pilot', metadata: { owner_decisions: {} } }]),
  )
  const out = JSON.parse(factory(['decisions']).out)
  expect(out.rigs.find((r: { rig: string }) => r.rig === 'ok').beads).toEqual([
    { id: 'ok-1', title: 'Which DB?', description: 'Question: Which DB?\nOptions: pg | mysql', kind: 'bead' },
    { id: 'ok-2', title: 'A pilot', description: undefined, kind: 'owned' },
  ])
  // break only the second rig's bd: its own error, the first rig still listed. A marker file, not $PWD: tmpdir()
  // and the cwd bd actually sees can differ by a macOS /private symlink
  writeFileSync(join(broken, 'BROKEN'), '')
  writeFileSync(join(bin, 'bd'), "#!/bin/sh\nif [ -f ./BROKEN ]; then echo boom >&2; exit 1; fi\necho '[]'\n")
  chmodSync(join(bin, 'bd'), 0o755)
  const mixed = JSON.parse(factory(['decisions']).out)
  const okRow = mixed.rigs.find((r: { rig: string }) => r.rig === 'ok')
  const brokenRow = mixed.rigs.find((r: { rig: string }) => r.rig === 'broken')
  expect(okRow.error).toBeUndefined()
  expect(okRow.beads).toEqual([])
  expect(brokenRow.error).toContain('boom')
  expect(brokenRow.beads).toEqual([])
})

const handed = (id: string) => ({
  id,
  title: 'Blocked run',
  labels: ['owner'],
  metadata: { owner_question: 'Question: which region?' },
})

test('decisions lists a handed-off bead as owned, with its owner_question as the description', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', JSON.stringify([handed('api-5')]))
  const out = JSON.parse(factory(['decisions']).out)
  expect(out.rigs.find((r: { rig: string }) => r.rig === 'api').beads).toEqual([
    { id: 'api-5', title: 'Blocked run', description: 'Question: which region?', kind: 'owned' },
  ])
})

test('decisions answer comments on a handed-off bead and drops its own: proposal', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', JSON.stringify([handed('api-5')]))
  seedKeys('own:api:api-5')
  factory(['decisions', 'answer', 'api', 'api-5', 'eu-west'])
  expect(readFileSync(calls, 'utf8').trim()).toBe('comment api-5 eu-west --actor factory/person')
  expect(keysOnDisk()).toEqual([])
})

test('decisions answer responds to a human-flagged bead, comments on an owner-only one, and a worker is refused', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  const answered = factory(['decisions', 'answer', 'api', 'api-1', 'go', 'with', 'postgres'])
  expect(answered.code).toBe(0)
  expect(readFileSync(calls, 'utf8').trim()).toBe(
    'human respond api-1 -r go with postgres --actor factory/person',
  )

  rmSync(calls, { force: true })
  fakeBd('null', JSON.stringify([{ id: 'api-2', title: 't', metadata: { owner_decisions: {} } }]))
  factory(['decisions', 'answer', 'api', 'api-2', 'start it'])
  expect(readFileSync(calls, 'utf8').trim()).toBe('comment api-2 start it --actor factory/person')

  const refused = factory(['decisions', 'answer', 'api', 'api-2', 'nope'], { FACTORY_FROM: 'implement' })
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain('a worker cannot run factory decisions')

  // claude-factory-72v.19: FACTORY_PATROL is the mod's own marker for a patrol subagent's Bash
  // call, a 2nd CLI-side layer behind the mod's regex deny (which an obfuscated command can defeat)
  const refusedPatrol = factory(['decisions', 'answer', 'api', 'api-2', 'nope'], { FACTORY_PATROL: '1' })
  expect(refusedPatrol.code).not.toBe(0)
  expect(refusedPatrol.err).toContain('a patrol cannot answer')
})

test('decisions propose refuses a gate key and a malformed one, a worker, and otherwise stores options decisions shows back', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  const gate = factory(['decisions', 'propose', 'gate:r1@0', 'q', 'a | b'])
  expect(gate.code).not.toBe(0)
  expect(gate.err).toContain('never proposed')

  const prompt = factory(['decisions', 'propose', 'prompt:b1@30', 'q', 'a | b'])
  expect(prompt.code).not.toBe(0)
  expect(prompt.err).toContain('looked at')

  const malformed = factory(['decisions', 'propose', 'nonsense', 'q', 'a | b'])
  expect(malformed.code).not.toBe(0)
  expect(malformed.err).toContain('malformed')

  const refused = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a | b'], {
    FACTORY_FROM: 'implement',
  })
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain('a worker cannot run factory decisions')

  // claude-factory-72v.19: same 2nd CLI-side layer as decisions answer's own FACTORY_PATROL check
  const refusedPatrol = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a | b'], {
    FACTORY_PATROL: '1',
  })
  expect(refusedPatrol.code).not.toBe(0)
  expect(refusedPatrol.err).toContain('a patrol cannot propose')

  expect(factory(['decisions', 'propose', 'bd:api:api-1', 'Which DB?', 'pg | mysql']).code).toBe(0)
  const out = JSON.parse(factory(['decisions']).out)
  expect(out.proposals['bd:api:api-1']).toMatchObject({ question: 'Which DB?', options: ['pg', 'mysql'] })
})

test('decide refuses a worker and a patrol before it ever looks up the run (claude-factory-72v.19)', () => {
  rmSync(dir, { recursive: true, force: true })
  fakeBd('null', '[]')
  const worker = factory(['decide', 'r1', 'approve'], { FACTORY_FROM: 'implement' })
  expect(worker.code).not.toBe(0)
  expect(worker.err).toContain('a worker cannot run factory decide')

  // claude-factory-72v.19: a patrol subagent's own Bash call carries FACTORY_PATROL=1, a 2nd
  // CLI-side layer behind the mod's regex deny for this same command
  const patrol = factory(['decide', 'r1', 'approve'], { FACTORY_PATROL: '1' })
  expect(patrol.code).not.toBe(0)
  expect(patrol.err).toContain('a patrol cannot decide')
})

test('decisions propose keeps a value at its limit, refuses one over it naming the field and the limit, and leaves decisions.json unchanged', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  const decisionsFile = join(home, 'decisions.json')
  const snapshot = () => (existsSync(decisionsFile) ? readFileSync(decisionsFile, 'utf8') : undefined)

  // at the limit: 160-char question, 200-char context, 4 options, 40-char label, 100-char effect, 1 recommended
  const q160 = `${'q'.repeat(159)}?` // 160 chars
  const c200 = 'c'.repeat(200)
  const label40 = 'x'.repeat(40)
  const effect100 = 'y'.repeat(100)
  const atLimit = factory([
    'decisions',
    'propose',
    'bd:api:api-1',
    q160,
    `${label40}: ${effect100} (recommended) | b | c | d`,
    '--context',
    c200,
  ])
  expect(atLimit.code).toBe(0)
  const stored = JSON.parse(factory(['decisions']).out).proposals['bd:api:api-1']
  expect(stored.question).toBe(q160)
  expect(stored.context).toBe(c200)
  expect(stored.options).toHaveLength(4)

  // one over the limit, each refused on its own, decisions.json unchanged by the refusal
  const before = snapshot()
  const overQuestion = factory(['decisions', 'propose', 'bd:api:api-1', `${q160}!`, 'a | b'])
  expect(overQuestion.code).not.toBe(0)
  expect(overQuestion.err).toContain('question')
  expect(overQuestion.err).toContain('161')
  expect(overQuestion.err).toContain('160')
  expect(snapshot()).toBe(before)

  const overContext = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a | b', '--context', `${c200}!`])
  expect(overContext.code).not.toBe(0)
  expect(overContext.err).toContain('context')
  expect(snapshot()).toBe(before)

  const oneOption = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a'])
  expect(oneOption.code).not.toBe(0)
  expect(oneOption.err).toContain('at least two')
  expect(snapshot()).toBe(before)

  const fiveOptions = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a | b | c | d | e'])
  expect(fiveOptions.code).not.toBe(0)
  expect(fiveOptions.err).toContain('5 options')
  expect(fiveOptions.err).toContain('4')
  expect(snapshot()).toBe(before)

  const overLabel = factory(['decisions', 'propose', 'bd:api:api-1', 'q', `${label40}z: e | b`])
  expect(overLabel.code).not.toBe(0)
  expect(overLabel.err).toContain('label')
  expect(overLabel.err).toContain('41')
  expect(overLabel.err).toContain('40')
  expect(snapshot()).toBe(before)

  const overEffect = factory(['decisions', 'propose', 'bd:api:api-1', 'q', `a: ${effect100}z | b`])
  expect(overEffect.code).not.toBe(0)
  expect(overEffect.err).toContain('effect')
  expect(overEffect.err).toContain('101')
  expect(overEffect.err).toContain('100')
  expect(snapshot()).toBe(before)

  const twoRecommended = factory([
    'decisions',
    'propose',
    'bd:api:api-1',
    'q',
    'a: x (recommended) | b: y (recommended)',
  ])
  expect(twoRecommended.code).not.toBe(0)
  expect(twoRecommended.err).toContain('2 options marked recommended')
  expect(snapshot()).toBe(before)
})

test('decisions propose refuses an empty option label and a whitespace-only question (claude-factory-9f6.17)', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', '[]')
  const decisionsFile = join(home, 'decisions.json')
  const snapshot = () => (existsSync(decisionsFile) ? readFileSync(decisionsFile, 'utf8') : undefined)
  const before = snapshot()

  // ': go now (recommended) | : wait' parses to two options with an empty label each
  const emptyLabel = factory(['decisions', 'propose', 'bd:api:api-1', 'q', ': go now (recommended) | : wait'])
  expect(emptyLabel.code).not.toBe(0)
  expect(emptyLabel.err).toContain('no label')
  expect(snapshot()).toBe(before)

  const blankQuestion = factory(['decisions', 'propose', 'bd:api:api-1', '   ', 'a | b'])
  expect(blankQuestion.code).not.toBe(0)
  expect(blankQuestion.err).toContain('question is empty')
  expect(snapshot()).toBe(before)
})

test('decisions propose refuses a newline in the question, the context or the options line', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', '[]')

  const badQuestion = factory(['decisions', 'propose', 'bd:api:api-1', 'line one\nline two', 'a | b'])
  expect(badQuestion.code).not.toBe(0)
  expect(badQuestion.err).toContain('question has a newline')

  const badContext = factory([
    'decisions',
    'propose',
    'bd:api:api-1',
    'q',
    'a | b',
    '--context',
    'line one\nline two',
  ])
  expect(badContext.code).not.toBe(0)
  expect(badContext.err).toContain('context has a newline')

  const badOptions = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a\nmore | b'])
  expect(badOptions.code).not.toBe(0)
  expect(badOptions.err).toContain('options have a newline')
})

test('decisions propose refuses an unknown extra argument instead of silently ignoring it', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', '[]')
  const typo = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a | b', '--contxt', 'oops'])
  expect(typo.code).not.toBe(0)
  expect(typo.err).toContain('unknown argument')
  expect(typo.err).toContain('--contxt')
  const out = JSON.parse(factory(['decisions']).out)
  expect(out.proposals['bd:api:api-1']).toBeUndefined() // the bad call stored nothing
})

test("decisions propose ignores the given options for an own: key and always keeps 'start now' and 'not now'", () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', JSON.stringify([{ id: 'api-9', title: 't', metadata: { owner_decisions: {} } }]))
  const proposed = factory([
    'decisions',
    'propose',
    'own:api:api-9',
    'Start the pilot now?',
    'ship it: go live | hold: wait',
    '--context',
    'Nobody has run it yet.',
  ])
  expect(proposed.code).toBe(0)
  const out = JSON.parse(factory(['decisions']).out)
  expect(out.proposals['own:api:api-9']).toMatchObject({
    question: 'Start the pilot now?',
    context: 'Nobody has run it yet.',
    options: ['start now', 'not now'],
  })
})

test('decisions propose --context round-trips into `factory decisions` output', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  const withContext = factory([
    'decisions',
    'propose',
    'bd:api:api-1',
    'Which DB?',
    'pg: smaller ops burden | mysql: team knows it already (recommended)',
    '--context',
    'The service has no DB yet.',
  ])
  expect(withContext.code).toBe(0)
  const out = JSON.parse(factory(['decisions']).out)
  expect(out.proposals['bd:api:api-1']).toMatchObject({
    question: 'Which DB?',
    context: 'The service has no DB yet.',
    options: ['pg: smaller ops burden', 'mysql: team knows it already (recommended)'],
  })
})

const decisionsFile = () => join(home, 'decisions.json')
const seedKeys = (...keys: string[]) => {
  mkdirSync(home, { recursive: true })
  const p = { question: 'q', options: ['a', 'b'], at: 1 }
  writeFileSync(decisionsFile(), JSON.stringify(Object.fromEntries(keys.map(k => [k, p]))))
}
const keysOnDisk = () => Object.keys(JSON.parse(readFileSync(decisionsFile(), 'utf8'))).sort()
const keysListed = () => Object.keys(JSON.parse(factory(['decisions']).out).proposals).sort()
/** a run dir; no value writes an unparsable state.json */
const seedRun = (id: string, value?: unknown) => {
  const d = join(home, 'runs', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'run.json'), JSON.stringify({ id }))
  writeFileSync(
    join(d, 'state.json'),
    value === undefined ? '{not json' : JSON.stringify({ snapshot: { value, context: {} } }),
  )
}

test('decisions drops a bd: key whose bead is no longer open, in the output and in decisions.json', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  seedKeys('bd:api:api-1', 'bd:api:api-2')
  expect(keysListed()).toEqual(['bd:api:api-1'])
  expect(keysOnDisk()).toEqual(['bd:api:api-1'])
})

test('decisions drops an own: key unless the bead is still in the ready list as owner-only', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', JSON.stringify([{ id: 'api-9', title: 't', metadata: { owner_decisions: {} } }]))
  seedKeys('own:api:api-9')
  expect(keysListed()).toEqual(['own:api:api-9'])
  fakeBd('null', '[]')
  expect(keysListed()).toEqual([])
  expect(keysOnDisk()).toEqual([])
})

test('decisions keeps an own: key of a handed-off bead while it is ready, drops it after', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', JSON.stringify([handed('api-5')]))
  seedKeys('own:api:api-5')
  expect(keysListed()).toEqual(['own:api:api-5'])
  fakeBd('null', '[]')
  expect(keysListed()).toEqual([])
})

test('decisions drops an iv: key for a done, aborted or missing run and keeps a live one', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', '[]')
  seedRun('r-done', 'done')
  seedRun('r-ab', 'aborted')
  seedRun('r-live', { plan: 'working' })
  seedKeys('iv:r-done@1', 'iv:r-ab@1', 'iv:r-gone@1', 'iv:r-live@1')
  expect(keysListed()).toEqual(['iv:r-live@1'])
  expect(keysOnDisk()).toEqual(['iv:r-live@1'])
})

test('decisions keeps a key when it cannot tell: bd fails, run state unreadable, other prefix; drops a key of an unknown rig', () => {
  rmSync(dir, { recursive: true, force: true })
  const broken = rig('broken')
  writeFileSync(join(broken, 'BROKEN'), '')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'bd'), "#!/bin/sh\nif [ -f ./BROKEN ]; then echo boom >&2; exit 1; fi\necho '[]'\n")
  chmodSync(join(bin, 'bd'), 0o755)
  seedRun('r-bad')
  seedKeys('bd:broken:b-1', 'own:broken:b-2', 'iv:r-bad@1', 'zz:other', 'bd:nope:x-1')
  const kept = ['bd:broken:b-1', 'iv:r-bad@1', 'own:broken:b-2', 'zz:other']
  expect(keysListed()).toEqual(kept)
  expect(keysOnDisk()).toEqual(kept)
})

test('decisions writes nothing when every key is live, and makes no file when there is none', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  factory(['decisions'])
  expect(existsSync(decisionsFile())).toBe(false)
  mkdirSync(home, { recursive: true })
  writeFileSync(decisionsFile(), '{"bd:api:api-1":{"question":"q","options":["a","b"],"at":1}}\n')
  const before = readFileSync(decisionsFile(), 'utf8')
  factory(['decisions'])
  expect(readFileSync(decisionsFile(), 'utf8')).toBe(before)
})

test('decisions answer deletes the bd: and own: keys of that bead only, and keeps the file when bd fails', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  seedKeys('bd:api:api-1', 'own:api:api-1', 'bd:api:api-2')
  expect(factory(['decisions', 'answer', 'api', 'api-1', 'go']).code).toBe(0)
  expect(keysOnDisk()).toEqual(['bd:api:api-2'])

  seedKeys('bd:api:api-1', 'bd:api:api-2')
  const before = readFileSync(decisionsFile(), 'utf8')
  writeFileSync(join(bin, 'bd'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'bd'), 0o755)
  expect(factory(['decisions', 'answer', 'api', 'api-1', 'go']).code).not.toBe(0)
  expect(readFileSync(decisionsFile(), 'utf8')).toBe(before)
})
