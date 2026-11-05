// claude-factory-12af: a worker prompt shows free text in single quotes; bash expands $VAR inside double quotes.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brief } from './cli'
import { forgeNote } from './prs'
import { GLAB_APPROVE_REASON } from './worker-hook'
import lifecycle from '../factories/lifecycle'
import release from '../factories/release'
import ship from '../factories/ship'
import sweeps from '../factories/sweeps'
import type { Factory } from './machine'

const root = join(import.meta.dir, '..')
const files = [
  'factories/lifecycle.ts',
  'factories/ship.ts',
  'factories/sweeps.ts',
  'factories/release.ts',
  'src/cli.ts',
  'src/prs.ts',
  'src/worker-hook.ts',
]
// not shell text: JSON file content, a code comment, a regex class, and two usage errors for the person who runs `factory start`
const allowed: [file: string, text: string][] = [
  ['factories/sweeps.ts', '{"repo":"<owner>/<repo>"'],
  ['factories/release.ts', 'factory start release <rig> "<version or bead>'],
  ['src/cli.ts', '--slo "<read-only command>"'],
  ['src/cli.ts', '--drift "<read-only command>"'],
  ['src/worker-hook.ts', '$\\\\\'"<>&|]*$/'],
]

/** the lines of a source file that hold a double-quoted placeholder, after the allowlisted text is removed */
const scan = (file: string, text: string) =>
  text.split('\n').flatMap((line, i) => {
    let rest = line
    for (const [f, t] of allowed) if (f === file) rest = rest.split(t).join('')
    return rest.includes('"<') || /\bbd (?:search|create|comment|close) [^`"]*"[^"`]*<[^"`]*"/.test(rest) ? [file + ':' + (i + 1) + ': ' + line.trim().slice(0, 100)] : []
  })

test('no prompt source holds a double-quoted placeholder', () => {
  const hits = files.flatMap(f => scan(f, readFileSync(join(root, f), 'utf8')))
  expect(hits).toEqual([])
})

test('each allowlisted text occurs exactly once', () => {
  for (const [f, t] of allowed) {
    const n = readFileSync(join(root, f), 'utf8').split(t).length - 1
    expect([f, t, n]).toEqual([f, t, 1])
  }
})

test('scan flags a double-quoted placeholder, passes a single-quoted one', () => {
  expect(scan('x.ts', 'bd comment <id> "<time, evidence>"')).toHaveLength(1)
  expect(scan('x.ts', 'report r 1 <outcome> "<summary>"')).toHaveLength(1)
  expect(scan('x.ts', 'run `bd search "CI runner loss: <workflow> / <job>"` now')).toHaveLength(1)
  expect(scan('x.ts', "run `bd search 'CI runner loss: <workflow> / <job>'` now")).toEqual([])
  expect(scan('x.ts', "bd comment <id> '<time, evidence>'")).toEqual([])
  expect(scan('src/cli.ts', '{"repo":"<owner>/<repo>"')).toHaveLength(1)
  expect(scan('factories/sweeps.ts', '{"repo":"<owner>/<repo>"')).toEqual([])
})

const c = {
  seq: 1,
  attempt: 1,
  pane: null,
  session: null,
  resumes: 0,
  startedAt: Date.now(),
  nudgedAt: 0,
  nudges: 0,
  retryAt: 0,
  budget: 10,
  wakeAt: 0,
  error: null,
  mail: {},
  seen: {},
  log: [],
}
const run = {
  id: 'r1',
  factory: 'f',
  repo: '/nonexistent/repo-12af',
  goal: 'g',
  ws: 'ws',
  worktree: '/nonexistent/wt-12af',
  branch: 'b',
}

test('every brief of lifecycle, ship, sweeps and release has no double-quoted placeholder and states the quote rule', () => {
  for (const def of [lifecycle, ship, sweeps, release] as Factory[]) {
    for (const node of Object.keys(def.nodes)) {
      const text = brief(run, def, node, { ...c, log: [] } as never, [])
      // the sweeps JSON example is file content, not shell
      const stripped = text.split('{"repo":"<owner>/<repo>"').join('')
      expect(stripped.includes('"<') ? node + ': has "<' : '').toBe('')
      for (const s of [
        "'<summary for the next station>'",
        "'<question>'",
        "'<query>'",
        "'\\''",
        'single quotes',
        ...(text.includes('bd create') ? ["'<title>'"] : []),
      ])
        expect(text.includes(s) ? '' : node + ': lacks ' + s).toBe('')
    }
  }
})

test('forge note and the glab approve reason use a single-quoted note text', () => {
  const note = forgeNote('gitlab.example.com').join('\n')
  for (const t of [note, GLAB_APPROVE_REASON]) {
    expect(t).toContain("-m '<text>'")
    expect(t).not.toContain('"<')
  }
})
