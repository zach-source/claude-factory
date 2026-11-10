// claude-factory-3u1.3.1 (FR-018, research R8): the dream finds failure classes and re-learned lessons,
// and writes at most 3 proposals one rung up the learning ladder.
import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AttemptOutcome,
  dreamPrompt,
  failureClasses,
  format,
  installCoreProposal,
  normalizeReason,
  PROPOSAL_CAP,
  proposals,
  proposalsOverCap,
  rejectProposal,
  relearned,
  withCoreLine,
  withFrontmatter,
  skillSources,
  skillsDir,
} from './memory'

const lockCommands = [
  ['skills', 'install', 'sample'],
  ['skills', 'reject', 'sample', 'reason'],
  ['proposals', 'install', 'sample'],
  ['proposals', 'install', 'sample', '--rig', 'widget'],
  ['proposals', 'reject', 'sample', 'reason'],
]

function lockFixture(index: number) {
  const home = join(tmpdir(), `ot1ew-memory-${process.pid}-${index}`)
  rmSync(home, { recursive: true, force: true })
  const memory = join(home, 'memory')
  const bin = join(home, 'bin')
  const log = join(home, 'calls')
  const lock = join(home, 'dream.lock')
  for (const dir of [bin, join(memory, '.proposals'), join(skillSources(memory), 'sample')])
    mkdirSync(dir, { recursive: true })
  writeFileSync(join(memory, 'CORE.md'), '- Keep the original line.\n')
  writeFileSync(
    join(skillSources(memory), 'sample', 'SKILL.md'),
    '---\ndescription: sample\n---\nUse the tool.\n',
  )
  writeFileSync(
    join(memory, '.proposals', 'sample.md'),
    `---\nrung: ${index === 3 ? 'instruction' : 'core'}\ntarget: CORE.md\nstatus: pending\n---\nCheck the result.\n`,
  )
  writeFileSync(
    join(home, 'rigs.json'),
    JSON.stringify([{ name: 'widget', repo: memory, factory: 'unused' }]),
  )
  const realGit = Bun.which('git')!
  const git = (...args: string[]) => {
    const p = Bun.spawnSync([realGit, '-C', memory, ...args])
    expect(p.exitCode, p.stderr.toString()).toBe(0)
    return p.stdout.toString().trim()
  }
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@acme.example', 'commit', '-qm', 'seed')
  for (const tool of ['git', 'bd', 'gh']) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\npid=$(cat '${lock}/pid' 2>/dev/null || true)\nheld=no\nif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ! mkdir '${lock}' 2>/dev/null; then held=yes; fi\nprintf '%s:%s:%s\\n' '${tool}' "$pid" "$held" >> '${log}'\n` +
        (tool === 'git' ? `exec '${realGit}' "$@"\n` : 'printf \'%s\' \'{"id":"acme-1"}\'\n'),
    )
    chmodSync(join(bin, tool), 0o755)
  }
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_PATROL, ...env } = process.env
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawnSync([join(import.meta.dir, '..', 'bin', 'factory'), ...args], {
      env: {
        ...env,
        FACTORY_HOME: home,
        FACTORY_SELF_UPDATE: '0',
        FACTORY_NO_KICK: '1',
        PATH: `${bin}:${env.PATH}`,
        ...extra,
      },
      timeout: 30_000,
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  return { home, memory, lock, log, git, run, calls }
}

test.each(lockCommands.map((args, i) => [i, args] as const))('ot1ew memory busy matrix %i', (i, args) => {
  const f = lockFixture(i)
  try {
    const before = f.git('status', '--porcelain')
    const core = readFileSync(join(f.memory, 'CORE.md'), 'utf8')
    const proposal = readFileSync(join(f.memory, '.proposals', 'sample.md'), 'utf8')
    const skill = readFileSync(join(skillSources(f.memory), 'sample', 'SKILL.md'), 'utf8')
    mkdirSync(f.lock)
    writeFileSync(join(f.lock, 'pid'), String(process.pid))
    const r = f.run(args)
    expect([r.code, r.out, r.err.trim()]).toEqual([1, '', 'memory: busy'])
    expect(f.calls()).toEqual([])
    expect(readFileSync(join(f.lock, 'pid'), 'utf8')).toBe(String(process.pid))
    expect(readFileSync(join(f.memory, 'CORE.md'), 'utf8')).toBe(core)
    expect(readFileSync(join(f.memory, '.proposals', 'sample.md'), 'utf8')).toBe(proposal)
    expect(readFileSync(join(skillSources(f.memory), 'sample', 'SKILL.md'), 'utf8')).toBe(skill)
    expect(f.git('status', '--porcelain')).toBe(before)
    for (const extra of [{ FACTORY_RUN: 'r1' }, { FACTORY_PATROL: '1' }]) {
      const denied = f.run(args, extra)
      expect(denied.code).toBe(1)
      expect(denied.err).toContain('cannot')
      expect(f.calls()).toEqual([])
    }
    for (const command of ['skills', 'proposals']) expect(f.run([command]).code).toBe(0)
    expect(f.calls()).toEqual([])
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test.each(lockCommands.map((args, i) => [i, args] as const))(
  'ot1ew lock lifetime and unlocked controls %i',
  (i, args) => {
    const f = lockFixture(i)
    try {
      mkdirSync(join(f.home, 'wiki.lock'))
      writeFileSync(join(f.home, 'wiki.lock', 'pid'), String(process.pid))
      const r = f.run(args)
      expect(r.code, r.err).toBe(0)
      expect(f.calls().length).toBeGreaterThan(0)
      for (const call of f.calls()) expect(call).toMatch(/^(git|bd):[1-9][0-9]*:yes$/)
      expect(f.calls().filter(c => c.startsWith('bd:')).length).toBe(i === 3 ? 1 : 0)
      expect(existsSync(f.lock)).toBe(false)
      expect(f.git('status', '--porcelain')).toBe('')
      expect(f.git('rev-list', '--count', 'HEAD')).toBe('2')
      if (i === 0) expect(existsSync(join(skillsDir(f.memory), 'sample', 'SKILL.md'))).toBe(true)
      if (i === 1) expect(existsSync(join(skillSources(f.memory), 'sample'))).toBe(false)
      if (i === 2) expect(readFileSync(join(f.memory, 'CORE.md'), 'utf8')).toContain('- Check the result.')
      if (i >= 2)
        expect(readFileSync(join(f.memory, '.proposals', 'sample.md'), 'utf8')).toContain(
          i === 4 ? 'rejected' : 'installed',
        )
      const failed = f.run(args.map(a => (a === 'sample' ? 'absent' : a)))
      expect(failed.code).toBe(1)
      expect(existsSync(f.lock)).toBe(false)
      expect(f.run(['skills', 'install', 'absent']).err).toContain('no proposed skill')
      expect(existsSync(f.lock)).toBe(false)
    } finally {
      rmSync(f.home, { recursive: true, force: true })
    }
  },
)

test.each([
  ['Tests FAILED in src/foo.test.ts: 3 of 12', 'tests failed in src/foo.test.ts: of'],
  ['bead acme-widget-h7c.2 is blocked on acme-widget-x9z', 'bead is blocked on'],
  ['lint failed.\nlong detail on line two', 'lint failed'],
  ['  Push   rejected (exit 128)  ', 'push rejected (exit'],
])('normalizeReason(%p) is %p', (raw, want) => {
  expect(normalizeReason(raw)).toBe(want)
})

const e = (run: string, node: string, outcome: string, summary: string, at = 1): AttemptOutcome => ({
  run,
  node,
  outcome,
  summary,
  at,
})

test('failureClasses groups a station and a normalized reason across 3+ distinct runs, red outcomes only', () => {
  const journal = [
    e('r1', 'verify', 'fail', 'Lint failed on 3 files.'),
    e('r1', 'verify', 'fail', 'Lint failed on 4 files.'), // same run again: still 1 run
    e('r2', 'verify', 'blocked', 'lint failed on 9 files. other detail'),
    e('r3', 'verify', 'fail', 'LINT FAILED on 1 files'),
    e('r4', 'implement', 'fail', 'lint failed on 2 files'), // another station
    e('r5', 'verify', 'done', 'lint failed on 2 files'), // green: not a failure
    e('r6', 'review', 'fail', 'flaky'),
    e('r7', 'review', 'fail', 'flaky'),
  ]
  expect(failureClasses(journal)).toEqual([
    { station: 'verify', reason: 'lint failed on files', runs: ['r1', 'r2', 'r3'] },
  ])
})

test('failureClasses lists the class with the most runs first', () => {
  const journal = [
    ...['a', 'b', 'c'].map(r => e(r, 'plan', 'fail', 'no plan')),
    ...['d', 'e', 'f', 'g'].map(r => e(r, 'ci', 'red', 'ci red')),
  ]
  expect(failureClasses(journal).map(c => c.station)).toEqual(['ci', 'plan'])
})

test.each<[string, string[], string[], string[]]>([
  ['3 new: none over', ['old'], ['old', 'a', 'b', 'c'], []],
  ['5 new: the last 2 by name are over', [], ['e', 'd', 'c', 'b', 'a'], ['d', 'e']],
  ['old ones never count', ['x', 'y', 'z'], ['x', 'y', 'z', 'a'], []],
])('proposalsOverCap: %s', (_, before, after, want) => {
  expect(proposalsOverCap(before, after)).toEqual(want)
  expect(PROPOSAL_CAP).toBe(3)
})

test('relearned names an inbox note that says what a CORE.md line already says', async () => {
  const dir = join(tmpdir(), `memory-relearned-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  writeFileSync(
    join(dir, 'CORE.md'),
    '- bd init on the shared Dolt server locks every repo\n- run prettier before a PR\n',
  )
  writeFileSync(
    join(dir, 'inbox', 'a.md'),
    format({ summary: 'bd init on the shared dolt server locks every repo', body: '' }),
  )
  writeFileSync(join(dir, 'inbox', 'b.md'), format({ summary: 'the deploy needs a VPN', body: '' }))
  expect(await relearned(dir)).toEqual([
    '- inbox/a.md re-learns CORE.md: bd init on the shared Dolt server locks every repo',
  ])
  rmSync(dir, { recursive: true, force: true })
}, 60_000)

test('dreamPrompt lists failure classes, re-learned lessons and proposals, and caps proposals at 3', () => {
  const p = dreamPrompt('/m', [], [], [], undefined, [], [], [], [], 15, {
    failures: [{ station: 'verify', reason: 'lint failed', runs: ['r1', 'r2', 'r3'] }],
    relearned: ['- inbox/a.md re-learns CORE.md: x'],
    proposals: ['- lint-first (pending, rung instruction)'],
  })
  expect(p).toContain('- verify: lint failed (3 runs: r1, r2, r3)')
  expect(p).toContain('- inbox/a.md re-learns CORE.md: x')
  expect(p).toContain('- lint-first (pending, rung instruction)')
  expect(p).toContain('/m/.proposals/<name>.md')
  expect(p).toContain('at most 3')
})

test('proposals() reads each .proposals/<name>.md frontmatter and its first body line', () => {
  const dir = join(tmpdir(), `memory-proposals-list-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, '.proposals'), { recursive: true })
  writeFileSync(
    join(dir, '.proposals', 'lint-first.md'),
    '---\nrung: instruction\ntarget: station:verify\nstatus: pending\nevidence: ["r1","r2","r3"]\ncreated: 2026-10-23\n---\nRun the linter before the tests.\nWhy: three runs.\n',
  )
  writeFileSync(join(dir, '.proposals', 'notes.txt'), 'not a proposal')
  expect(proposals(dir)).toEqual([
    {
      name: 'lint-first',
      rung: 'instruction',
      target: 'station:verify',
      status: 'pending',
      change: 'Run the linter before the tests.',
      file: join(dir, '.proposals', 'lint-first.md'),
    },
  ])
  expect(proposals(join(dir, 'none'))).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})

// claude-factory-3u1.3.2 (FR-019..021): install and reject
test.each([
  ['an empty CORE.md', '', '- new line\n'],
  ['a top with no rig sections', '- a\n- b\n', '- a\n- b\n- new line\n'],
  ['a top before a rig section', '- a\n\n## rig: x\n- x1\n', '- a\n- new line\n\n## rig: x\n- x1\n'],
  ['only a rig section', '## rig: x\n- x1\n', '- new line\n\n## rig: x\n- x1\n'],
])('withCoreLine: %s', (_, core, want) => {
  expect(withCoreLine(core, 'new line')).toBe(want)
})

test.each([
  [
    'replaces a key',
    '---\nstatus: pending\nrung: core\n---\nbody\n',
    'status',
    'installed',
    '---\nstatus: installed\nrung: core\n---\nbody\n',
  ],
  [
    'adds a key',
    '---\nstatus: pending\n---\nbody\n',
    'bead',
    'x-1',
    '---\nstatus: pending\nbead: x-1\n---\nbody\n',
  ],
  [
    'leaves the body alone',
    '---\nstatus: pending\n---\nstatus: in the body\n',
    'status',
    'rejected',
    '---\nstatus: rejected\n---\nstatus: in the body\n',
  ],
])('withFrontmatter: %s', (_, text, key, value, want) => {
  expect(withFrontmatter(text, key, value)).toBe(want)
})

test('installCoreProposal adds the line to CORE.md and marks it installed; rejectProposal writes the reason to the inbox', () => {
  const dir = join(tmpdir(), `memory-proposals-install-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, '.proposals'), { recursive: true })
  writeFileSync(join(dir, 'CORE.md'), '- old line\n')
  const p = (rung: string, change: string) =>
    `---\nrung: ${rung}\ntarget: CORE.md\nstatus: pending\n---\n${change}\n`
  writeFileSync(join(dir, '.proposals', 'a.md'), p('core', 'Run prettier before a PR.'))
  writeFileSync(join(dir, '.proposals', 'b.md'), p('instruction', 'Lint first.'))
  installCoreProposal(dir, 'a')
  expect(readFileSync(join(dir, 'CORE.md'), 'utf8')).toBe('- old line\n- Run prettier before a PR.\n')
  expect(proposals(dir).find(x => x.name === 'a')?.status).toBe('installed')
  expect(() => installCoreProposal(dir, 'a')).toThrow('no pending proposal a')
  expect(() => installCoreProposal(dir, 'b')).toThrow('rung instruction')

  rejectProposal(dir, 'b', 'the linter already runs first')
  expect(proposals(dir).find(x => x.name === 'b')?.status).toBe('rejected')
  const inbox = readdirSync(join(dir, 'inbox')).map(f => readFileSync(join(dir, 'inbox', f), 'utf8'))
  expect(inbox.join('\n')).toContain('rejected the proposal b: the linter already runs first')
  expect(() => rejectProposal(dir, '../x', 'why')).toThrow('no pending proposal ../x')
  rmSync(dir, { recursive: true, force: true })
})
