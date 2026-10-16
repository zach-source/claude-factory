// dispatch() must never use a `station:<name>` label from a Linear pull to pick a run's start
// station (claude-factory-b6c.27). `bd linear pull` copies every Linear label onto the bead it
// writes, with no filter. dispatch already honors `station:<name>` (beads.ts stationOf): it starts a
// run past the factory's own first stations. A Linear-side actor with write access to an issue can
// set `station:deploy` or `station:release` this way. The person later adds the `factory` label to
// work the bead. Without this fix, that run would skip triage, plan, implement, review and security.
//
// This test drives the real `dispatch()` through `factory beads`. It uses a fake `bd` and `herdr`,
// the same harness as start.test.ts. It does not stub stationOf directly.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `dispatch-${process.pid}`)
const home = join(dir, 'home')
const bin = join(dir, 'bin')
const claudeConfig = join(dir, 'claude-config')

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

/** fake bd: `ready` answers one bead carrying `station:deploy`, with or without a Linear
 * `external_ref`, depending on `extRef`. `children` is always empty (no bead here has one). Every
 * other call (claim, dolt remote list, sync) exits 0, so dispatch proceeds past them with no error. */
function fakeBd(extRef: string | undefined) {
  mkdirSync(bin, { recursive: true })
  const bead = JSON.stringify([
    {
      id: 'acme-1',
      title: 't',
      labels: ['factory', 'station:deploy'],
      ...(extRef && { external_ref: extRef }),
    },
  ])
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    `  ready) printf '%s' '${bead}';;`,
    "  children) printf '%s' '[]';;",
    '  dolt) echo "No remotes configured";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

/** fake herdr: only `worktree create` answers, as start.test.ts's does */
function fakeHerdr() {
  const worktree = join(dir, 'worktree-stub')
  const script = [
    '#!/bin/sh',
    'case "$1 $2" in',
    `  "worktree create") printf '%s' '{"result":{"workspace":{"workspace_id":"ws1"},"worktree":{"path":"${worktree}"}}}';;`,
    '  "worktree remove") exit 0;;',
    '  *) echo "herdr-stub: unexpected $*" >&2; exit 1;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'herdr'), script)
  chmodSync(join(bin, 'herdr'), 0o755)
}

function repo() {
  const r = join(dir, 'repo')
  mkdirSync(join(r, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', r, 'init', '-q'])
  Bun.spawnSync(['git', '-C', r, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'])
  return r
}

function reset(extRef: string | undefined) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({ projects: {} }))
  mkdirSync(home, { recursive: true })
  const r = repo()
  fakeBd(extRef)
  fakeHerdr()
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'a', repo: r, factory: 'lifecycle' }]))
}

/** the new run's inbox: a GOTO line, if dispatch posted one */
function gotoOf(): { type: string; node: string }[] {
  const runsDir = join(home, 'runs')
  const id = readdirSync(runsDir)[0]!
  const inbox = join(runsDir, id, 'inbox.jsonl')
  if (!existsSync(inbox)) return [] // no GOTO: dispatch posted nothing to this run's inbox
  const lines = readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean)
  return lines.map(l => JSON.parse(l)).filter(e => e.type === 'GOTO')
}

test("dispatch never starts a run at a Linear-sourced bead's station:<name> label (claude-factory-b6c.27)", () => {
  reset('https://linear.app/acme/issue/STI-1')
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  expect(gotoOf()).toEqual([]) // the run stays at the factory's own start station, not "deploy"
})

test("a station:<name> label a person wrote by hand (no Linear external_ref) still starts the run there", () => {
  reset(undefined)
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  const gotos = gotoOf()
  expect(gotos).toHaveLength(1)
  expect(gotos[0]!.node).toBe('deploy') // the control: proves dispatch really reaches stationOf here
})
