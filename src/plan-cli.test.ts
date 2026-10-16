// `factory plan facts|set|show` (claude-factory-dun.2): the pm has no Bash, so this CLI
// gathers the facts it ranks, validates its answer by hand, writes plan.json, and files each
// finding and proposal as a bead -- the pm never calls `bd` itself. This drives the real CLI
// through a fake `bd`, the same harness as dispatch.test.ts.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLAN_FRESH_MS } from './plan'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `plan-cli-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const claudeConfig = join(dir, 'claude-config')
const repo = join(dir, 'repo')

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const factory = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${bin}:${laptop.PATH}`,
      CLAUDE_CONFIG_DIR: claudeConfig,
      FACTORY_SELF_UPDATE: '0',
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** fake bd for `plan set`: it only ever calls `list --all --metadata-field ...` (hasMetadata) and
 * `create ...` (fileFinding). A `create` call for a key touches a marker file for that key, so a
 * later `list` call for the same key answers non-null: the same dedupe a real bd would give once
 * the bead exists. */
function fakeBd() {
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${join(bin, 'calls.log')}'`,
    'case "$1" in',
    '  list)',
    '    key=""; prev=""',
    '    for a in "$@"; do',
    '      if [ "$prev" = "--metadata-field" ]; then key="$a"; fi',
    '      prev="$a"',
    '    done',
    '    val="${key#pm_finding=}"',
    `    marker="${join(bin, 'filed-')}$(echo "$val" | tr '/: ' '___')"`,
    "    if [ -f \"$marker\" ]; then printf '%s' '[{\"id\":\"existing-1\"}]'; else printf '%s' 'null'; fi",
    '    ;;',
    '  create)',
    '    meta=""; prev=""',
    '    for a in "$@"; do',
    '      if [ "$prev" = "--metadata" ]; then meta="$a"; fi',
    '      prev="$a"',
    '    done',
    '    val=$(echo "$meta" | sed -n \'s/.*"pm_finding":"\\([^"]*\\)".*/\\1/p\')',
    `    marker="${join(bin, 'filed-')}$(echo "$val" | tr '/: ' '___')"`,
    '    touch "$marker"',
    `    n=$(cat '${join(bin, 'counter')}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${join(bin, 'counter')}'`,
    '    echo "new-$n"',
    '    ;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

const callsLog = () =>
  existsSync(join(bin, 'calls.log')) ? readFileSync(join(bin, 'calls.log'), 'utf8') : ''
const createCalls = () =>
  callsLog()
    .trim()
    .split('\n')
    .filter(l => l.startsWith('create '))

function reset() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  mkdirSync(join(repo, '.beads'), { recursive: true })
  fakeBd()
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'a', repo, factory: 'lifecycle', goal: 'ship' }]),
  )
}

const factsFile = () => join(home, 'plan-facts.json')
const planJson = () => join(home, 'plan.json')

/** a RigFacts-shaped facts file for rig "a": two candidates, two findings. Hand-written (not
 * gathered through `plan facts`) so these tests exercise `plan set`'s own validation, ranking
 * and filing, independent of how the facts were gathered. */
function writeFacts(extra: Record<string, unknown> = {}) {
  writeFileSync(
    factsFile(),
    JSON.stringify({
      a: {
        goal: 'ship',
        maxRuns: 2,
        busy: 0,
        candidates: [
          { id: 'fx-2', title: 'low priority', priority: 2 },
          { id: 'fx-1', title: 'high priority', priority: 0 },
        ],
        epics: [],
        closedRecently: [],
        liveBeadIds: [],
        findings: [
          {
            kind: 'epic-done-open',
            rig: 'a',
            bead: 'fx-9',
            key: 'epic-done-open:a:fx-9',
            text: 'fx-9 is done',
          },
          {
            kind: 'starved-epic',
            rig: 'a',
            bead: 'fx-8',
            key: 'starved-epic:a:fx-8',
            text: 'fx-8 is starved',
          },
          { kind: 'goal-no-beads', rig: 'a', key: 'goal-no-beads:a:deadbeef', text: 'no open leaf' },
        ],
        ...extra,
      },
    }),
  )
}

function writeAnswer(path: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    path,
    JSON.stringify({
      rigs: {
        a: [
          { id: 'fx-1', why: 'ship first' },
          { id: 'fx-2', why: 'then this' },
        ],
      },
      proposals: [{ rig: 'a', change: 'bump fx-1 to P0', why: 'a customer is blocked' }],
      ...extra,
    }),
  )
}

test('plan set writes plan.json with items in non-decreasing priority order', () => {
  reset()
  writeFacts()
  const answerPath = join(dir, 'answer.json')
  writeAnswer(answerPath)
  const out = factory(['plan', 'set', answerPath])
  expect(out.code).toBe(0)
  const written = JSON.parse(readFileSync(planJson(), 'utf8'))
  expect(written.rigs.a.items.map((i: { id: string }) => i.id)).toEqual(['fx-1', 'fx-2'])
  expect(written.rigs.a.items.map((i: { priority: number }) => i.priority)).toEqual([0, 2])
  expect(written.rigs.a.items[0].why).toBe('ship first')
  expect(written.rigs.a.findings).toHaveLength(3) // the facts' findings, carried through as-is
  expect(written.proposals).toEqual([{ rig: 'a', change: 'bump fx-1 to P0', why: 'a customer is blocked' }])
})

test('a re-run files each finding/proposal key exactly once; the cap is 3 newly filed beads per rig', () => {
  reset()
  writeFacts()
  const answerPath = join(dir, 'answer.json')
  writeAnswer(answerPath)

  const first = factory(['plan', 'set', answerPath])
  expect(first.code).toBe(0)
  // 3 findings + 1 proposal = 4 candidates to file, capped at 3 per rig
  expect(createCalls().length).toBe(3)

  writeFileSync(join(bin, 'calls.log'), '') // same facts+answer, second run
  const second = factory(['plan', 'set', answerPath])
  expect(second.code).toBe(0)
  // every key from the first run is now filed: this run creates nothing for them
  expect(createCalls().length).toBe(1) // only the 4th (capped-out) item is still new
})

test("a proposal becomes a 'human'-labeled bead; the argv log has no update and no bare -p", () => {
  reset()
  writeFacts({ findings: [] }) // no findings: the proposal alone stays well under the per-rig cap
  const answerPath = join(dir, 'answer.json')
  writeAnswer(answerPath)
  const out = factory(['plan', 'set', answerPath])
  expect(out.code).toBe(0)
  const log = callsLog()
  const proposalCreate = log
    .trim()
    .split('\n')
    .find(l => l.includes('bump fx-1 to P0'))
  expect(proposalCreate).toBeDefined()
  expect(proposalCreate).toContain('-l human')
  expect(log).not.toContain('update')
  expect(log.split(/\s+/)).not.toContain('-p')
})

test('stale plan-facts.json refuses: exit 1, plan.json untouched', () => {
  reset()
  writeFacts()
  const past = (Date.now() - PLAN_FRESH_MS - 60_000) / 1000
  utimesSync(factsFile(), past, past)
  const answerPath = join(dir, 'answer.json')
  writeAnswer(answerPath)
  const out = factory(['plan', 'set', answerPath])
  expect(out.code).toBe(1)
  expect(out.err).toContain('plan-facts.json')
  expect(existsSync(planJson())).toBe(false)
  expect(createCalls().length).toBe(0)
})

test('malformed JSON in the answer file refuses: exit 1, plan.json untouched', () => {
  reset()
  writeFacts()
  const answerPath = join(dir, 'answer.json')
  writeFileSync(answerPath, '{ not json')
  const out = factory(['plan', 'set', answerPath])
  expect(out.code).toBe(1)
  expect(existsSync(planJson())).toBe(false)
})

test('malformed JSON in plan-facts.json refuses: exit 1, plan.json untouched', () => {
  reset()
  writeFileSync(factsFile(), '{ not json')
  const answerPath = join(dir, 'answer.json')
  writeAnswer(answerPath)
  const out = factory(['plan', 'set', answerPath])
  expect(out.code).toBe(1)
  expect(existsSync(planJson())).toBe(false)
})

test('plan show prints the plan as text, or says there is none', () => {
  reset()
  const none = factory(['plan', 'show'])
  expect(none.code).toBe(0)
  expect(none.out).toContain('no plan.json yet')

  writeFacts()
  const answerPath = join(dir, 'answer.json')
  writeAnswer(answerPath)
  expect(factory(['plan', 'set', answerPath]).code).toBe(0)
  const shown = factory(['plan'])
  expect(shown.code).toBe(0)
  expect(shown.out).toContain('fx-1')
  expect(shown.out).toContain('ship first')
  expect(shown.out).toContain('fx-9 is done')
  expect(shown.out).toMatch(/plan \d+m ago/)
})
