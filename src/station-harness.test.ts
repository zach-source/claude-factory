// claude-factory-gf16e.2: every lifecycle and ship station builds a launch command on claude, codex, grok and pi,
// and each harness that can take a station has its deny hook in place
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lifecycle from '../factories/lifecycle'
import ship from '../factories/ship'
import { codexWorker, grokWorker, pickAgent, piWorker, workerFlags } from './cli'
import { command, harnessOf, skillsFor } from './harness'
import type { Factory } from './machine'
import { GAPS_FILE, harnessGaps, parseGaps } from './parity'

const HOOK = join(import.meta.dir, 'worker-hook.ts')
const stations = ([lifecycle, ship] as unknown as Factory[]).flatMap(def =>
  Object.entries(def.nodes)
    .filter(([, n]) => !n.gate)
    .map(([node, n]) => ({ def, node, skills: [...(def.skills ?? []), ...(n.skills ?? [])] })),
)

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'station-harness-'))
  const wt = join(tmp, 'wt')
  Bun.spawnSync(['git', 'init', '-q', wt])
  const home = join(tmp, 'home')
  mkdirSync(home)
  // a fake codex that reports the guard features as codexWorker's probe needs them
  const codexBin = join(tmp, 'codex')
  const table =
    'hooks stable true\\n' +
    ['unified_exec', 'shell_snapshot', 'multi_agent', 'code_mode'].map(x => `${x} stable false\\n`).join('')
  writeFileSync(codexBin, `#!/bin/sh\nprintf '${table}'\n`, { mode: 0o755 })
  const user = join(tmp, 'person')
  mkdirSync(user)
  writeFileSync(join(user, 'auth.json'), '{}')
  return { tmp, wt, home, codexBin, user }
}

test('there are stations to check', () => {
  expect(stations.length).toBeGreaterThan(10)
})

test('claude: each station launches with the deny hook in its --settings', () => {
  const { home } = setup()
  for (const { def, node, skills } of stations) {
    const extra = workerFlags(def, undefined, home, skillsFor('claude', skills), node)
    const cmd = command('claude --dangerously-skip-permissions', '/p.md', { extra })
    const file = cmd.match(/--settings '([^']+)'/)![1]!
    const pre = JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse
    expect(JSON.stringify(pre)).toContain(HOOK)
  }
})

test('codex: each station launches with the deny hook in its CODEX_HOME and the guard flags', () => {
  const { tmp, wt, codexBin, user } = setup()
  for (const { def, node } of stations) {
    const dir = join(tmp, 'codex-home', def.name, node)
    const w = codexWorker({ id: 'r1', worktree: wt }, def, node, `${codexBin} --x`, undefined, {
      hookFile: HOOK,
      userHome: user,
      dir,
      plugins: [],
    })
    expect(readFileSync(join(dir, 'hooks.json'), 'utf8')).toContain(HOOK)
    expect(command(`${codexBin} --x`, '/p.md', w)).toContain('--enable hooks')
  }
})

test('grok: each station launches with the deny hook in its worktree', () => {
  const { wt, home } = setup()
  for (const { node } of stations) {
    const w = grokWorker({ worktree: wt }, undefined, home, HOOK)
    expect(readFileSync(join(wt, '.grok', 'hooks', 'factory.json'), 'utf8')).toContain(HOOK)
    expect(command('grok --trust', `/${node}.md`, w)).toContain('--rules')
  }
})

test('pi: each station builds a launch command, but pi has no deny hook, so agents.order never moves to pi', () => {
  const { home } = setup()
  for (const { def, node } of stations) {
    const w = piWorker(home, [])
    const cmd = command('pi', '/p.md', w)
    expect(harnessOf(cmd)).toBe('pi')
    // the gap (claude-factory-gf16e.5): flip this when a pi extension runs worker-hook.ts
    expect(cmd).not.toContain(HOOK)
    const limited = (h: string) => h !== 'pi'
    const pick = pickAgent(
      'r1',
      def,
      node,
      undefined,
      'herdr',
      {},
      import.meta.path,
      () => true,
      () => true,
      limited,
      0,
      home,
    )
    expect(harnessOf(pick)).not.toBe('pi')
  }
})

test('parity-gaps.json lists the harness gaps, each with a bead of epic gf16e', () => {
  const gaps = harnessGaps(readFileSync(GAPS_FILE, 'utf8'))
  parseGaps(readFileSync(GAPS_FILE, 'utf8')) // the shape check
  expect(gaps.some(g => g.harness === 'pi' && g.bead === 'claude-factory-gf16e.5')).toBe(true)
  for (const g of gaps) expect(g.bead).toStartWith('claude-factory-gf16e.')
})
