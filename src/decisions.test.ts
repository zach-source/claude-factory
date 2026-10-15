// `factory decisions`, end to end through bin/factory: every rig's open bd decisions, answering one, and the
// manager's proposed options for an item that has none. A fake `bd` on PATH stands in for the real CLI.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `decisions-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const calls = join(dir, 'calls.log')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, ...env },
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
  expect(refused.err).toContain('a worker cannot answer')
})

test('decisions propose refuses a gate key and a malformed one, a worker, and otherwise stores options decisions shows back', () => {
  rmSync(dir, { recursive: true, force: true })
  rig('api')
  fakeBd('null', '[]')
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
  expect(refused.err).toContain('a worker cannot propose')

  expect(factory(['decisions', 'propose', 'bd:api:api-1', 'Which DB?', 'pg | mysql']).code).toBe(0)
  const out = JSON.parse(factory(['decisions']).out)
  expect(out.proposals['bd:api:api-1']).toMatchObject({ question: 'Which DB?', options: ['pg', 'mysql'] })
})
