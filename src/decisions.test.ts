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

test('decisions propose usage and error text use single-quoted placeholders (the manager reads them)', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', '[]')
  const usage = factory(['decisions', 'propose', 'bd:api:api-1'])
  expect(usage.err).toContain("'<question>'")
  expect(usage.err).not.toContain('"<')
  const ctx = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a | b', '--context'])
  expect(ctx.err).toContain("'<sentence>'")
  expect(ctx.err).not.toContain('"<')
  const extra = factory(['decisions', 'propose', 'bd:api:api-1', 'q', 'a | b', 'x'])
  expect(extra.err).toContain("--context '<sentence>'")
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

// claude-factory-2z48: decisions propose reads untrusted text from files inside <FACTORY_HOME>/text/
test('decisions propose --question-file stores the text as written and refuses a bad form with decisions.json unchanged', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  const txt = (name: string, body: string) => {
    const p = join(home, 'text', name)
    mkdirSync(join(home, 'text'), { recursive: true })
    writeFileSync(p, body)
    return p
  }
  const q = txt('q.txt', "Why $(id) and ' ?\n")
  const o = txt('o.txt', 'pg: fast (recommended) | mysql: slow\n')
  const c = txt('c.txt', "ctx $(id) '")
  const ok = factory([
    'decisions',
    'propose',
    'bd:api:api-1',
    '--question-file',
    q,
    '--options-file',
    o,
    '--context-file',
    c,
  ])
  expect(ok.code).toBe(0)
  const out = JSON.parse(factory(['decisions']).out)
  expect(out.proposals['bd:api:api-1']).toMatchObject({
    question: "Why $(id) and ' ?",
    options: ['pg: fast (recommended)', 'mysql: slow'],
    context: "ctx $(id) '",
  })
  expect(factory(['decisions', 'propose', 'own:api-2', '--question-file', q]).code).toBe(0)
  // an own: key never reads --options-file, so a path outside text/ does not matter
  expect(
    factory(['decisions', 'propose', 'own:api-3', '--question-file', q, '--options-file', '/nonexistent'])
      .code,
  ).toBe(0)

  const file = join(home, 'decisions.json')
  const before = readFileSync(file)
  const outside = join(dir, 'outside.txt')
  writeFileSync(outside, 'a | b')
  const rows: Record<string, string[]> = {
    'positional mixed': ['bd:api:api-1', 'q', '--question-file', q, '--options-file', o],
    'positional options mixed': ['bd:api:api-1', '--question-file', q, 'a | b'],
    'unknown flag': ['bd:api:api-1', '--question-file', q, '--options-file', o, '--x', 'y'],
    repeated: ['bd:api:api-1', '--question-file', q, '--question-file', q, '--options-file', o],
    'no question': ['bd:api:api-1', '--options-file', o],
    'no options': ['bd:api:api-1', '--question-file', q],
    'outside text/': ['bd:api:api-1', '--question-file', q, '--options-file', outside],
    'one line': ['bd:api:api-1', '--question-file', txt('two.txt', 'a\nb'), '--options-file', o],
    'one option': ['bd:api:api-1', '--question-file', q, '--options-file', txt('one.txt', 'a')],
  }
  for (const [name, a] of Object.entries(rows)) {
    const r = factory(['decisions', 'propose', ...a])
    expect([name, r.code]).toEqual([name, 1])
    if (/^(no |unknown|repeated|positional options)/.test(name))
      expect(r.err).toContain('usage: factory decisions propose')
    expect(readFileSync(file).equals(before)).toBe(true)
  }
})

test('decisions propose refuses a control character in the question, the context or an option, with decisions.json unchanged (claude-factory-p1j6)', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd(JSON.stringify([{ id: 'api-1', title: 't' }]), '[]')
  const txt = (name: string, body: string) => {
    const p = join(home, 'text', name)
    mkdirSync(join(home, 'text'), { recursive: true })
    writeFileSync(p, body)
    return p
  }
  const decisionsFile = join(home, 'decisions.json')
  expect(factory(['decisions', 'propose', 'bd:api:api-0', 'good', 'a | b']).code).toBe(0)
  const before = readFileSync(decisionsFile)
  const refuse = (name: string, a: string[], code: string) => {
    const r = factory(['decisions', 'propose', ...a])
    expect([name, r.code]).toEqual([name, 1])
    expect([name, r.err]).toEqual([name, expect.stringContaining(code)])
    expect(/[^\P{Cc}\n]/u.test(r.err)).toBe(false)
    expect(readFileSync(decisionsFile).equals(before)).toBe(true)
  }
  const bad: [string, string, string][] = [
    ['ESC', 'x\x1b[2Jy', 'U+001B'],
    ['CR', 'x\ry', 'U+000D'],
    ['tab', 'x\ty', 'U+0009'],
    ['DEL', 'x\x7fy', 'U+007F'],
    ['C1', 'x\u009by', 'U+009B'],
  ]
  for (const key of ['bd:api:api-1', 'own:api-1']) {
    for (const [name, v, code] of bad) {
      refuse(`${key} question ${name}`, [key, v, 'a | b'], code)
      refuse(`${key} context ${name}`, [key, 'q', 'a | b', '--context', v], code)
    }
    const o = ['--options-file', txt('o1', 'a | b')]
    refuse(`${key} question-file ESC`, [key, '--question-file', txt('q1', 'x\x1b[2Jy'), ...o], 'U+001B')
    refuse(`${key} question-file NUL`, [key, '--question-file', txt('q2', 'x\x00y'), ...o], 'U+0000')
    refuse(
      `${key} context-file NUL`,
      [
        key,
        '--question-file',
        txt('q3', 'q'),
        '--options-file',
        txt('o3', 'a | b'),
        '--context-file',
        txt('c3', 'x\x00y'),
      ],
      'U+0000',
    )
  }
  refuse('options ESC', ['bd:api:api-1', 'q', 'a\x1b[2J: x | b: y'], 'U+001B')
  refuse('options CR', ['bd:api:api-1', 'q', 'a: x\r | b: y'], 'U+000D')
  refuse(
    'options-file NUL',
    ['bd:api:api-1', '--question-file', txt('q4', 'q'), '--options-file', txt('o4', 'a\x00 | b')],
    'U+0000',
  )
  refuse(
    'options-file ESC',
    ['bd:api:api-1', '--question-file', txt('q5', 'q'), '--options-file', txt('o5', 'a\x1b | b')],
    'U+001B',
  )
  // an own: key ignores its options, so they are not checked
  expect(factory(['decisions', 'propose', 'own:api-2', 'q', 'a\x1b | b']).code).toBe(0)
})
