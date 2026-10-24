// claude-factory-3u1.3.1 (FR-018) end to end through bin/factory: the dream prompt carries the failure
// classes from the run journal, and the dream keeps at most 3 new proposals, whatever it wrote.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-dream-proposals-${process.pid}`)
const home = join(dir, 'home')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('factory dream: failure classes reach the prompt, and only 3 of 5 new proposals stay', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(home, 'memory', 'inbox'), { recursive: true })
  writeFileSync(join(home, 'memory', 'inbox', 'x.md'), '---\nsummary: a fixture note\n---\nbody\n')
  for (const run of ['r1', 'r2', 'r3']) {
    mkdirSync(join(home, 'runs', run), { recursive: true })
    const log = [
      {
        node: 'verify',
        attempt: 1,
        outcome: 'fail',
        summary: `Lint failed on ${run.length} files.`,
        at: Date.now(),
      },
    ]
    writeFileSync(join(home, 'runs', run, 'state.json'), JSON.stringify({ snapshot: { context: { log } } }))
  }
  const prompt = join(dir, 'prompt.txt')
  const claude = join(dir, 'fake-claude.sh')
  writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'set -e',
      `cat > ${prompt}`,
      'mkdir -p topic .proposals',
      'git mv inbox/x.md topic/x.md',
      'for n in a b c d e; do printf -- "---\\nrung: core\\ntarget: CORE.md\\nstatus: pending\\n---\\nline $n\\n" > .proposals/$n.md; done',
      'echo "wrote 5 proposals"',
      '',
    ].join('\n'),
  )
  chmodSync(claude, 0o755)
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, 'dream'], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_CLAUDE: claude },
  })
  expect(p.exitCode).toBe(0)
  expect(readFileSync(prompt, 'utf8')).toContain('- verify: lint failed on files (3 runs: r1, r2, r3)')
  expect(readdirSync(join(home, 'memory', '.proposals')).sort()).toEqual(['a.md', 'b.md', 'c.md'])
  expect(readFileSync(join(home, 'dream.log'), 'utf8')).toContain('dropped proposals over the cap: d, e')
}, 60_000)
