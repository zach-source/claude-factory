import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, fill, validate } from './machine'
import {
  CONFIG_SYNC,
  deadline,
  haltStep,
  helpedHint,
  idle,
  isTrusted,
  labelAction,
  lastContext,
  limitHit,
  needsSwap,
  nextAccount,
  servedAt,
  parsePkgGateAllowlist,
  parsePkgGateMinDays,
  prOwner,
  loadFactory,
  missingSweeps,
  ownCopy,
  paramsOf,
  reapable,
  progressNow,
  progressSig,
  relaunch,
  reworkGoal,
  stalled,
  swapUntil,
  watchWake,
  workerSettings,
  WORKER_TOOLS,
  commitIdentity,
  room,
  withoutFleet,
} from './cli'

test("a factory home's sync pushes what its .gitignore lets in, and its memory to the memory branch", () => {
  const dir = mkdtempSync(join(tmpdir(), 'config-sync-'))
  const who = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  }
  const sh = (cwd: string, cmd: string) => {
    const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, env: { ...process.env, ...who } })
    if (p.exitCode) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  const home = join(dir, 'home')
  mkdirSync(join(home, 'runs'), { recursive: true })
  mkdirSync(join(home, 'memory'))
  sh(dir, 'git init -q --bare origin.git')
  writeFileSync(join(home, '.gitignore'), '/*\n!/.gitignore\n!/rigs.json\n')
  writeFileSync(join(home, 'rigs.json'), '[]')
  writeFileSync(join(home, 'runs', 'r.json'), '{}')
  writeFileSync(join(home, 'memory', 'note.md'), 'a note')
  sh(home, `git init -q && git remote add origin ${join(dir, 'origin.git')}`)
  sh(join(home, 'memory'), 'git init -q && git add -A && git commit -qm m')
  sh(home, CONFIG_SYNC)
  const origin = join(dir, 'origin.git')
  const branch = sh(home, 'git branch --show-current')
  expect(sh(origin, `git ls-tree --name-only ${branch}`).split('\n')).toEqual(['.gitignore', 'rigs.json'])
  expect(sh(origin, 'git ls-tree --name-only memory')).toBe('note.md')
})

test("the factory's Claudes load every mod but herdr-fleet", () => {
  expect(withoutFleet('/m/herdr-fleet').env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
  expect(withoutFleet('/m/herdr-fleet:/m/other').env.CLAUDE_CODE_PLUGIN_DIRS).toBe('/m/other')
  expect(withoutFleet('').env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
})

test('a worker still working at its time limit is warned once and given half again', () => {
  const min = 60_000
  expect(deadline(59 * min, 60, true, false)).toBeNull()
  expect(deadline(61 * min, 60, false, false)).toBe('fail') // idle or gone at the limit: no grace
  expect(deadline(61 * min, 60, true, false)).toBe('warn')
  expect(deadline(75 * min, 60, true, true)).toBeNull() // warned, still inside the grace
  expect(deadline(91 * min, 60, true, true)).toBe('fail')
})

test("a repo's own copy loads without this project and says how it is changed", async () => {
  const copy = ownCopy(readFileSync(join(import.meta.dir, '../factories/lifecycle.ts'), 'utf8'), 'lifecycle')
  expect(copy).not.toContain('src/machine')
  expect(copy).not.toContain('satisfies Factory')
  expect(copy).toStartWith(`// This repo's own factory, from claude-factory's "lifecycle" template`)
  expect(copy).toContain('factory check .factory/lifecycle.ts')

  const dir = join(tmpdir(), `own-${process.pid}`, '.factory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'lifecycle.ts'), copy)
  const def = validate((await import(join(dir, 'lifecycle.ts'))).default)
  expect(def.name).toBe('lifecycle')
  compile(def)
  // what reads or changes production needs the laptop, whatever runner the rig sends its workers to
  const pinned = Object.keys(def.nodes).filter(id => def.nodes[id]!.runner === 'herdr')
  expect(pinned.sort()).toEqual(['baseline', 'deploy', 'incident', 'monitor', 'rollback', 'soak'])
})

test('the loop starts only the sweeps a repo has no run for', async () => {
  const def = (await import('../factories/lifecycle.ts')).default
  const runs = [
    { repo: '/a', goal: 'sweep: monitor' },
    { repo: '/b', goal: 'sweep: maintain' },
    { repo: '/a', goal: 'add a feature' },
  ]
  expect(missingSweeps(def, { repo: '/a' }, runs)).toEqual(['maintain', 'improve'])
  expect(missingSweeps(def, { repo: '/a', sweeps: ['maintain'] }, runs)).toEqual(['maintain'])
  expect(missingSweeps(def, { repo: '/a', sweeps: [] }, runs)).toEqual([])
  expect(missingSweeps({ ...def, nodes: { triage: def.nodes.triage } }, { repo: '/a' }, [])).toEqual([])
})

test("a rig has room under its own cap and the town's", () => {
  const busy = ['web', 'web', 'api', undefined]
  expect(room({ name: 'web', maxRuns: 3 }, busy, 8)).toBe(1)
  expect(room({ name: 'web', maxRuns: 2 }, busy, 8)).toBe(0)
  expect(room({ name: 'api' }, busy, 8)).toBe(4) // no cap of its own: the town's
  expect(room({ name: 'api', maxRuns: 5 }, busy, 5)).toBe(1) // the town fills first
  expect(room(undefined, busy, 8)).toBe(4) // a run outside any rig
})

test('a launch the shell swallowed gets Enter, then the command again, then fails', () => {
  expect(relaunch(60_000, 0)).toBeNull() // Claude may still be starting
  expect(relaunch(91_000, 0)).toBe('enter')
  expect(relaunch(91_000, 1)).toBe('retype')
  expect(relaunch(91_000, 2)).toBe('fail')
})

test('a stop tells each worker once, waits while it works, then closes its pane', () => {
  expect(haltStep(false, false, false, 0)).toBe('gone') // its pane is gone already: nothing to stop
  expect(haltStep(true, false, true, 0)).toBe('tell')
  expect(haltStep(true, true, true, 60_000)).toBe('wait') // committing
  expect(haltStep(true, true, false, 60_000)).toBe('close') // quiet: done committing
  expect(haltStep(true, true, true, 6 * 60_000)).toBe('close') // past the grace
})

test("the reaper closes a finished run's workspace and an idle Claude that is not a live run's worker", () => {
  const p = (
    pane_id: string,
    workspace_id: string,
    cwd: string,
    agent_status = 'unknown',
    agent: string | null = null,
  ) => ({
    pane_id,
    workspace_id,
    cwd,
    agent,
    agent_status,
  })
  const runs = [
    { ws: 'w1', worktree: '/wt/a', isOver: true },
    { ws: 'w2', worktree: '/wt/b', isOver: true }, // closed already: w2 is someone else's now
    { ws: 'w3', worktree: '/wt/c', isOver: false, pane: 'w3:p2' },
  ]
  const panes = [
    p('w1:p1', 'w1', '/wt/a'),
    p('w2:p1', 'w2', '/home/other'),
    p('w3:p1', 'w3', '/wt/c'), // the shell the worktree opened with
    p('w3:p2', 'w3', '/wt/c', 'idle', 'claude'), // the run's worker, between turns
    p('w3:p3', 'w3', '/wt/c/src', 'done', 'claude'), // a duplicate
    p('w3:p4', 'w3', '/wt/c', 'working', 'claude'), // left to finish
    p('w3:p5', 'w3', '/wt/cc', 'idle', 'claude'), // another worktree
  ]
  expect(reapable(runs, panes)).toEqual({ workspaces: ['w1'], panes: ['w3:p3'] })
  // an AX worker has no pane here, so an agent idling in its workspace is the person's, not a stray
  const remote = [{ ws: 'w3', worktree: '/wt/c', isOver: false, pane: 'ax://f-r1-1' }]
  expect(reapable(remote, panes)).toEqual({ workspaces: [], panes: [] })
})

test("a worker command's {params} come from the rig, then FACTORY_<NAME>, then the factory", () => {
  const def = { params: { claude: 'claude-smart --new', exec_model: 'sonnet', judge_model: 'opus' } }
  const env = { FACTORY_CLAUDE: 'claude --x', FACTORY_EXEC_MODEL: '  ' }
  const params = paramsOf(def, { params: { judge_model: 'fable' } }, env)
  expect(params).toEqual({ claude: 'claude --x', exec_model: 'sonnet', judge_model: 'fable' })
  expect(fill(`{claude} --model '{judge_model}' --settings '{"a":1}' {other}`, params)).toBe(
    `claude --x --model 'fable' --settings '{"a":1}' {other}`,
  )
  const node = { prompt: 'p', next: { ok: 'done' } }
  expect(() =>
    validate({
      name: 'f',
      start: 'a',
      agent: '{claude} {typo}',
      params: { claude: 'c' },
      nodes: { a: node },
    }),
  ).toThrow('agent names {typo}, which params does not give')
})

test('a factory file in YAML adds a station to lifecycle by extending it and rewiring one outcome', async () => {
  const dir = join(tmpdir(), `ext-${Date.now()}`)
  mkdirSync(join(dir, '.factory'), { recursive: true })
  const file = join(dir, '.factory', 'lifecycle.yaml')
  writeFileSync(
    file,
    `extends: lifecycle
params: { exec_model: m }
nodes:
  a11y:
    prompt: Check the change's accessibility.
    next: { pass: release, fix: implement }
  review:
    next: { approve: a11y }
`,
  )
  const def = await loadFactory(file) // extends its own name: the built-in, not itself
  expect(def.name).toBe('lifecycle')
  expect(def.nodes.review!.next).toMatchObject({
    approve: 'a11y',
    changes: 'implement',
    security: 'security',
  })
  expect(def.nodes.review!.prompt).toContain('Review') // unnamed fields stay the base's
  expect(def.nodes.a11y!.next.pass).toBe('release')
  expect(def.params).toMatchObject({ exec_model: 'm', judge_model: expect.any(String) })
})

test('a factory in TOML or JSON, checked like one in TypeScript, and an extends loop refused', async () => {
  const dir = join(tmpdir(), `data-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'tiny.toml'),
    `name = "tiny"\nstart = "work"\n[nodes.work]\nprompt = "Do it."\nnext = { ok = "done" }\n`,
  )
  expect((await loadFactory(join(dir, 'tiny.toml'))).nodes.work!.next).toEqual({ ok: 'done' })
  writeFileSync(
    join(dir, 'more.json'),
    JSON.stringify({ extends: 'tiny', nodes: { work: { next: { ok: 'gone' } } } }),
  )
  await expect(loadFactory(join(dir, 'more.json'))).rejects.toThrow('unknown node "gone"')
  writeFileSync(
    join(dir, 'vm.json'),
    JSON.stringify({ extends: 'tiny', nodes: { work: { runner: 'mars' } } }),
  )
  await expect(loadFactory(join(dir, 'vm.json'))).rejects.toThrow('work: runner "mars" is not herdr or ax')
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ extends: 'b.json' }))
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ extends: 'a.json' }))
  await expect(loadFactory(join(dir, 'a.json'))).rejects.toThrow('extends loops')
})

test("a PR's close label closes it, its conflict or rework label reworks it unless it comes from a fork", () => {
  const pr = (labels: string[], isCrossRepository = false) => ({
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    headRefName: 'feat/x',
    baseRefName: 'main',
    isCrossRepository,
    labels: labels.map(name => ({ name })),
  })
  expect(labelAction(pr(['close', 'conflict']))).toBe('close') // closing wins: no rework for a PR going away
  expect(labelAction(pr(['conflict']))).toBe('rework')
  expect(labelAction(pr(['conflict'], true))).toBe('fork')
  expect(labelAction(pr(['bug']))).toBeUndefined()
  expect(labelAction(pr(['rework']))).toBe('rework')
  expect(labelAction(pr(['close', 'rework']))).toBe('close')
  expect(reworkGoal(pr(['conflict']))).toContain('Branch feat/x, base main')
  expect(reworkGoal(pr(['conflict', 'rework']))).toContain(
    'labeled conflict and rework: resolve its merge conflicts and make the changes',
  )
  expect(reworkGoal(pr(['rework']))).not.toContain('conflicts')
})

test('the rework factory is valid data and ends at done either way', async () => {
  const def = await loadFactory(join(import.meta.dir, '..', 'factories', 'rework.yaml'))
  expect(Object.keys(def.nodes)).toEqual(['resolve'])
  expect(Object.values(def.nodes.resolve!.next)).toEqual(['done', 'done', 'done'])
})

test("a repo is trusted when Claude's trust dialog was accepted for it or a folder above it", () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-'))
  expect(isTrusted('/a/b', dir)).toBe(true) // no config: the check never stops a factory itself
  const projects = { '/a': { hasTrustDialogAccepted: true }, '/x/y': { hasTrustDialogAccepted: false } }
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects }))
  expect(isTrusted('/a/b/c', dir)).toBe(true)
  expect(isTrusted('/x/y', dir)).toBe(false)
  expect(isTrusted('/z', dir)).toBe(false)
})

test('a labeled PR belongs to the live run whose branch it is or whose reports link it', () => {
  const url = 'https://github.com/o/r/pull/21'
  const log = (summary: string) => [{ node: 'review', attempt: 1, outcome: 'changes', summary, at: 1 }]
  const live = [
    { id: 'a', log: log('PR https://github.com/o/r/pull/212 needs work') }, // #212 is not #21
    { id: 'b', log: log(`PR ${url} has 3 findings`) },
  ]
  expect(prOwner({ url, headRefName: 'fix/x' }, live)).toBe('b')
  expect(prOwner({ url: 'https://github.com/o/r/pull/9', headRefName: 'factory/a' }, live)).toBe('a')
  expect(prOwner({ url: 'https://github.com/o/r/pull/9', headRefName: 'fix/x' }, live)).toBeUndefined()
})

test('a watched park wakes when a PR changes, or on the plain timer once none is open', () => {
  const pr = (state: string, updatedAt: string) => ({
    url: 'https://github.com/o/r/pull/1',
    state,
    updatedAt,
  })
  const at = Date.parse('2026-10-11T10:00:00Z')
  expect(watchWake([pr('OPEN', '2026-10-11T09:00:00Z')], at, at + 9 * 3600_000, 60)).toBeUndefined()
  expect(watchWake([pr('MERGED', '2026-10-11T10:05:00Z')], at, at + 600_000, 60)).toContain('it is merged')
  // merged before it parked (a deploy waiting on CI after the merge): the plain timer, not 8h
  expect(watchWake([pr('MERGED', '2026-10-11T09:00:00Z')], at, at + 30 * 60_000, 60)).toBeUndefined()
  expect(watchWake([pr('MERGED', '2026-10-11T09:00:00Z')], at, at + 60 * 60_000, 60)).toContain('None of')
  expect(watchWake([], at, at + 9 * 3600_000, 60)).toBeUndefined() // gh could not say: the backstop wakes it
})

test("a worker's context is its transcript's last turn, read from a tail that may start mid-line", () => {
  const turn = (input: number, read: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: input, cache_read_input_tokens: read } },
    })
  const tail = ['ge":{"usage":{"input_tokens":9', turn(10, 1000), turn(5, 2000), '{"type":"user"}', ''].join(
    '\n',
  )
  expect(lastContext(tail)).toBe(2005)
  expect(lastContext('{"type":"user"}')).toBe(0)
})

test("a worker's settings are its own: the user's hooks and environment, none of their plugins", () => {
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] }
  const user = {
    env: { A: '1', CLAUDE_CODE_PLUGIN_DIRS: '/x/herdr-fleet:/y/mine' },
    hooks,
    enabledPlugins: { p: true },
  }
  const w = workerSettings(user, 200)
  expect(w.hooks).toBe(hooks)
  expect(w.env).toMatchObject({
    A: '1',
    CLAUDE_CODE_PLUGIN_DIRS: '/y/mine',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  })
  expect(w).toMatchObject({ skipDangerousModePermissionPrompt: true, autoCompactWindow: 400_000 })
  expect('enabledPlugins' in w).toBe(false)
  expect(w).toMatchObject({ autoMemoryEnabled: false })
  expect(workerSettings({}, 200, '/h/.claude/CLAUDE.md').claudeMdExcludes).toEqual(['/h/.claude/CLAUDE.md'])
  expect(workerSettings({}, 30).autoCompactWindow).toBe(100_000) // Claude Code's floor
})

// mv9: a worker still gets no plugin but asd-ste100 -- its skill and SessionStart STE brief are lean
// enough to carry, and the plugin brings the writing rule instead of a copy of its text
test('a worker gets the asd-ste100 plugin alone, with bundled skills off, so it writes in ASD-STE100', () => {
  const user = {
    env: { STE_VOCAB_PATH: '/v', STE_JEV_URL: 'https://j' },
    enabledPlugins: {
      'asd-ste100@agent-marketplace': true,
      'code-quality@agent-marketplace': true,
      'warp@claude-code-warp': true,
    },
  }
  const w = workerSettings(user, 200)
  expect(w.enabledPlugins).toEqual({ 'asd-ste100@agent-marketplace': true })
  expect(w.disableBundledSkills).toBe(true)
  expect(w.env).toMatchObject({ STE_VOCAB_PATH: '/v', STE_JEV_URL: 'https://j' })
  // no enabledPlugins key at all when the user has none, or asd-ste100 is off
  expect('enabledPlugins' in workerSettings({ enabledPlugins: { p: true } }, 200)).toBe(false)
  expect('enabledPlugins' in workerSettings({ enabledPlugins: { 'asd-ste100@m': false } }, 200)).toBe(false)
  expect('enabledPlugins' in workerSettings({}, 200)).toBe(false)
})

test('WORKER_TOOLS carries Skill, so a worker can load the asd-ste100 skill', () => {
  expect(WORKER_TOOLS.split(',')).toContain('Skill')
})

test("workers commit as the factory home's own git identity, crediting factory.coauthor", () => {
  const home = mkdtempSync(join(tmpdir(), 'factory-id-'))
  expect(commitIdentity(home)).toEqual({ env: {}, rule: '' }) // not a repo: the rig's own config
  Bun.spawnSync(['git', 'init', '-q', home])
  for (const [k, v] of Object.entries({
    'user.name': 'gen-ai factory',
    'user.email': 'factory@x.invalid',
    'factory.coauthor': 'Pat <pat@x.com>',
  }))
    Bun.spawnSync(['git', '-C', home, 'config', k, v])
  const id = commitIdentity(home)
  expect(id.env).toEqual({
    GIT_AUTHOR_NAME: 'gen-ai factory',
    GIT_AUTHOR_EMAIL: 'factory@x.invalid',
    GIT_COMMITTER_NAME: 'gen-ai factory',
    GIT_COMMITTER_EMAIL: 'factory@x.invalid',
  })
  expect(id.rule).toContain('Co-authored-by: Pat <pat@x.com>')
})

test("a usage limit is read from the transcript's last turn, and the next account is one whose limit has reset", () => {
  const turn = (extra: object) =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-11T12:00:00.000Z', message: {}, ...extra })
  const refused = turn({
    error: 'rate_limit',
    quotaLimits: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_800_000_000 },
  })
  expect(limitHit(['cut {', turn({}), refused, JSON.stringify({ type: 'user' }), ''].join('\n'))).toEqual({
    at: Date.parse('2026-10-11T12:00:00.000Z'),
    kind: 'seven_day',
    resetsAt: 1_800_000_000_000,
  })
  expect(limitHit([refused, turn({})].join('\n'))).toBeNull() // it went on since
  expect(servedAt([refused, turn({})].join('\n'))).toBeGreaterThan(0)
  expect(servedAt([turn({}), refused].join('\n'))).toBe(0)
  expect(nextAccount(['a', 'b', 'c'], 'b', { b: 9 }, 5)).toBe('c')
  expect(nextAccount(['a', 'b', 'c'], 'b', { b: 9, c: 9 }, 5)).toBe('a')
  expect(nextAccount(['a', 'b', 'c'], 'b', { a: 9, b: 3, c: 9 }, 5)).toBe('b')
  expect(nextAccount(['a', 'b', 'c'], 'b', { a: 9, b: 9, c: 9 }, 5)).toBeNull()
})

test('a token swap runs once per usage-limit hit, then waits for the vault refresh on success or the reset on failure', () => {
  const hit = { at: 1_000, resetsAt: 2_000_000 }
  expect(needsSwap(hit, undefined)).toBe(true)
  expect(needsSwap(hit, { at: 999 })).toBe(true)
  expect(needsSwap(hit, { at: 1_000 })).toBe(false)
  expect(needsSwap(hit, { at: 1_001 })).toBe(false)
  expect(swapUntil(hit, 5_000, true, 300_000)).toBe(305_000)
  expect(swapUntil(hit, 5_000, false, 300_000)).toBe(2_000_000) // resetsAt wins when set
  expect(swapUntil({ at: 1_000, resetsAt: 0 }, 5_000, false, 300_000)).toBe(1_000 + 3_600_000) // the 1h fallback
})

test('a working worker with no new output is nudged once, then failed as stalled', () => {
  const min = 60_000
  expect(stalled(19 * min, false)).toBeNull()
  expect(stalled(20 * min, false)).toBe('nudge')
  expect(stalled(30 * min, true)).toBeNull() // nudged: gets as long again
  expect(stalled(40 * min, true)).toBe('fail')
})

test('progress restarts when the fingerprint or the worker changes', () => {
  const p = progressNow(undefined, 1, 'a', 100)
  expect(progressNow(p, 1, 'a', 500)).toBe(p)
  expect(progressNow(p, 1, 'b', 500).at).toBe(500)
  expect(progressNow({ ...p, nudged: true }, 2, 'a', 500).nudged).toBe(false)
})

// progressSig is an AX worker's whole progress signal: without it, the stall guard read only the transcript
// tail, which an AX worker's turn-buffering gap (xq3.1) and the old hardcoded head='' (xq3.2) could both leave
// empty or unchanged for a committing worker's entire first turn -- this is what called it quiet (claude-
// factory-xq3).
test("progressSig changes when only the VM's repo head moves, tail unchanged", () => {
  const a = progressSig('same tail', 'sha1', 10)
  const b = progressSig('same tail', 'sha2', 10)
  expect(a).not.toBe(b)
})

test('progressSig changes when only the live stream byte count moves, tail and head unchanged', () => {
  const a = progressSig('same tail', 'sha1', 10)
  const b = progressSig('same tail', 'sha1', 20)
  expect(a).not.toBe(b)
})

test('progressSig is empty, and so stall-exempt, when tail, head and bytes are all empty', () => {
  expect(progressSig('', '', 0)).toBe('')
  expect(progressSig('', '', undefined)).toBe('')
})

test('progressSig is non-empty as soon as tail or bytes is non-empty, even with head empty', () => {
  expect(progressSig('', '', 5)).not.toBe('')
  expect(progressSig('some tail', '', 0)).not.toBe('')
})

// head alone must never make a fingerprint: a local worker's head is always set (git rev-parse HEAD) even
// before it has a tail or a session, so head-only would make every local codex/pi/script worker, and a local
// claude worker before its session is known, newly stall-failable (claude-factory-xq3.4, PR #19 review finding 1).
test('progressSig stays empty, and so stall-exempt, when only head is set (a local worker with no tail yet)', () => {
  expect(progressSig('', 'sha1', 0)).toBe('')
  expect(progressSig('', 'sha1', undefined)).toBe('')
})

// claude-factory-9wu: Claude Code stops cd+rm-outside-worktree chains for an approval nobody answers, so a
// worker's scratch dir must stay inside the worktree (.scratch/, which excludeScratch() git-ignores) and a
// worker must never chain cd with rm -rf; git -C/go -C replace the cd.
test('the worker system prompt names a .scratch/ scratch dir, bans cd+rm -rf, and restores a mutation with git checkout', () => {
  const text = readFileSync(join(import.meta.dir, 'worker-system.md'), 'utf8')
  expect(text).toContain('.scratch/')
  expect(text).toContain('git -C')
  expect(text).toContain('go -C')
  expect(text).toContain('rm -rf')
  expect(text).not.toContain('mktemp -d')
  expect(text).toContain('/tmp_')
  expect(text).toContain('2>/dev/null')
  expect(text).toContain('git checkout -- <file>')
  expect(text).toContain('git status --short')
  expect(text.length).toBeLessThan(3600)
})

// mv9: tells a worker to write in ASD-STE100 and to load the plugin's skill before long text, without
// copying the plugin's own rules into this file (that text would drift from the plugin)
test('the worker system prompt tells a worker to write in ASD-STE100 and load the asd-ste100 skill first', () => {
  const text = readFileSync(join(import.meta.dir, 'worker-system.md'), 'utf8')
  expect(text).toContain('ASD-STE100')
  expect(text).toContain('asd-ste100 skill')
  expect(text.length).toBeLessThan(3600)
})

test('a rig with no goal and no ready beads is idle', () => {
  expect(idle({}, 0)).toBe(true)
  expect(idle({ goal: 'v2' }, 0)).toBe(false) // the manager steers it
  expect(idle({}, 2)).toBe(false)
})

test('PKG_GATE_MIN_DAYS unset is undefined (the gate default), but a non-finite or negative value fails closed (ei0.10)', () => {
  expect(parsePkgGateMinDays(undefined)).toBeUndefined()
  expect(parsePkgGateMinDays('')).toBeUndefined()
  expect(parsePkgGateMinDays('7')).toBe(7)
  expect(() => parsePkgGateMinDays('four')).toThrow(/finite, non-negative/)
  expect(() => parsePkgGateMinDays('NaN')).toThrow(/finite, non-negative/)
  expect(() => parsePkgGateMinDays('Infinity')).toThrow(/finite, non-negative/)
  expect(() => parsePkgGateMinDays('-1')).toThrow(/finite, non-negative/)
})

test('PKG_GATE_ALLOWLIST_GO/_NPM/_PYPI parse to one list per ecosystem, and the old shared PKG_GATE_ALLOWLIST is refused, not reinterpreted (ei0.22)', () => {
  expect(parsePkgGateAllowlist({})).toBeUndefined()
  expect(parsePkgGateAllowlist({ PKG_GATE_ALLOWLIST_GO: '' })).toBeUndefined()
  expect(parsePkgGateAllowlist({ PKG_GATE_ALLOWLIST_GO: 'a:b', PKG_GATE_ALLOWLIST_PYPI: 'c' })).toEqual({
    go: ['a', 'b'],
    pypi: ['c'],
  })
  expect(parsePkgGateAllowlist({ PKG_GATE_ALLOWLIST_NPM: 'left-pad' })).toEqual({ npm: ['left-pad'] })
  // the old name silently meant "all three ecosystems": refuse to start rather than let its meaning change
  // underneath a deploy that still sets it
  expect(() => parsePkgGateAllowlist({ PKG_GATE_ALLOWLIST: 'left-pad' })).toThrow(/PKG_GATE_ALLOWLIST/)
})

test('helpedHint tells a worker to pass --from <run>/<station>, so usage() counts distinct runs, not UTC days (claude-factory-59r.16)', () => {
  const run = {
    id: 'lifecycle-abc',
    factory: 'f',
    repo: 'r',
    goal: 'g',
    ws: 'w',
    worktree: 'wt',
    branch: 'b',
  }
  expect(helpedHint(run, 'implement')).toContain('memory helped --from lifecycle-abc/implement')
})
