import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, fill, validate } from './machine'
import {
  brief,
  clipFactsJson,
  clipReport,
  CONFIG_SYNC,
  deadline,
  haltStep,
  helpedHint,
  idle,
  isTrusted,
  labelAction,
  lastContext,
  limitHit,
  managerCommand,
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
  REPORT_MAX,
  reworkGoal,
  ruleLines,
  selfUpdateMail,
  stalled,
  swapUntil,
  watchWake,
  workerFlags,
  workerSettings,
  WORKER_TOOLS,
  commitIdentity,
  room,
  slot,
  withoutFleet,
  type RigFacts,
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

test('slot: a gate, no node, or a waiting sub costs nothing; a stuck sub holds the rig only; else it holds both', () => {
  expect(slot(undefined, '')).toBe('free') // done or aborted: no live node
  expect(slot({ gate: true }, 'working')).toBe('free') // a gate: the person answers it, no worker
  expect(slot({}, 'waiting')).toBe('free') // a timed edge or a blocked park
  expect(slot({}, 'stuck')).toBe('rig') // held for the person, but its pane (an AX task) stays up
  expect(slot({}, 'working')).toBe('busy')
  expect(slot({}, 'backoff')).toBe('busy')
})

test('room: a stuck run (held) still fills its rig, but never the town', () => {
  const busy = ['web']
  const held = ['web', 'web']
  expect(room({ name: 'web', maxRuns: 3 }, busy, 8, held)).toBe(0) // 1 busy + 2 held == maxRuns
  expect(room({ name: 'web', maxRuns: 4 }, busy, 8, held)).toBe(1)
  expect(room(undefined, busy, 8, held)).toBe(7) // held never counts against the town
  expect(room({ name: 'web', maxRuns: 3 }, busy, 8)).toBe(2) // no held argument: unaffected
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

test('an awaitsPr pre-launch park wakes at once on a merge or close, even one that predates the park (claude-factory-960 AC2/AC3)', () => {
  const pr = (state: string, updatedAt: string) => ({
    url: 'https://github.com/o/r/pull/1',
    state,
    updatedAt,
  })
  const at = Date.parse('2026-10-11T10:00:00Z')
  // still open, no activity: no wake, even long after the park (AC2)
  expect(watchWake([pr('OPEN', '2026-10-11T09:00:00Z')], at, at + 9 * 3600_000, 60, true)).toBeUndefined()
  // merged after the park: wakes at once, same as a worker's own park
  expect(watchWake([pr('MERGED', '2026-10-11T10:05:00Z')], at, at + 600_000, 60, true)).toContain(
    'it is merged',
  )
  // merged (or closed) before the park ever started: a worker's own park would wait out plainMin, but a
  // pre-launch park spent no worker on that wait, so it wakes at the very next pass
  expect(watchWake([pr('MERGED', '2026-10-11T09:00:00Z')], at, at + 1000, 60, true)).toContain('None of')
  expect(watchWake([pr('CLOSED', '2026-10-11T09:00:00Z')], at, at + 1000, 60, true)).toContain('None of')
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
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: 'herdr-session' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }],
  }
  const user = {
    env: { A: '1', CLAUDE_CODE_PLUGIN_DIRS: '/x/herdr-fleet:/y/mine' },
    hooks,
    enabledPlugins: { p: true },
  }
  const w = workerSettings(user, 200)
  const pre = w.hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[]
  // the user's own PreToolUse entry (a secret guard such as ctxguard) stays first, unchanged
  expect(pre[0]).toEqual(hooks.PreToolUse[0])
  // claude-factory-cr6: the factory's deny-rm-rf hook comes last, so it never shadows the user's own guard
  expect(pre[1]).toMatchObject({ matcher: 'Bash' })
  expect(pre[1]!.hooks[0]!.command).toMatch(/worker-hook\.ts'$/)
  expect(pre).toHaveLength(2)
  // workerSettings keeps a hook event other than PreToolUse as the user set it
  expect(w.hooks.SessionStart).toEqual(hooks.SessionStart)
  // a user with no hooks at all gets only the factory's entry
  expect(workerSettings({}, 200).hooks.PreToolUse).toHaveLength(1)
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

// claude-factory-25z.2: a rig with personOnlyContexts gets its own worker-settings-<rig>.json, so a
// launch for a different rig (which writes the shared file with no argv) never overwrites its hook argv
test("workerFlags writes a rig's own worker-settings-<rig>.json when it has personOnlyContexts, else the shared worker-settings.json", () => {
  const home = mkdtempSync(join(tmpdir(), 'worker-flags-'))
  const acme = { name: 'acme', personOnlyContexts: ['acme-ctx'] }
  const web = { name: 'web' }
  const extraAcme = workerFlags({ maxContextK: 200 }, acme, home)
  const extraWeb = workerFlags({ maxContextK: 200 }, web, home)
  expect(extraAcme).toContain(join(home, 'worker-settings-acme.json'))
  expect(extraWeb).toContain(join(home, 'worker-settings.json'))
  expect(existsSync(join(home, 'worker-settings-acme.json'))).toBe(true)
  expect(existsSync(join(home, 'worker-settings.json'))).toBe(true)
  const acmeSettings = JSON.parse(readFileSync(join(home, 'worker-settings-acme.json'), 'utf8'))
  const webSettings = JSON.parse(readFileSync(join(home, 'worker-settings.json'), 'utf8'))
  expect(acmeSettings.hooks.PreToolUse.at(-1).hooks[0].command).toContain("--person-only-contexts 'acme-ctx'")
  expect(webSettings.hooks.PreToolUse.at(-1).hooks[0].command).not.toContain('--person-only-contexts')
})

// claude-factory-25z.2: a rig's personOnlyContexts reaches the deny hook's own argv, so it can refuse a
// kubectl, ko or helm mutation there even with no live rig policy anywhere else in the worker's settings
test("workerSettings carries a rig's personOnlyContexts on the deny hook's own argv", () => {
  const withList = workerSettings({}, 200, undefined, ['acme'])
  const pre = withList.hooks.PreToolUse as { hooks: { command: string }[] }[]
  expect(pre.at(-1)!.hooks[0]!.command).toMatch(/--person-only-contexts 'acme'$/)
  // no list, or an empty one: today's command, unchanged
  const withNone = workerSettings({}, 200)
  const withEmpty = workerSettings({}, 200, undefined, [])
  expect(withNone).toEqual(withEmpty)
  expect((withNone.hooks.PreToolUse as { hooks: { command: string }[] }[]).at(-1)!.hooks[0]!.command).toMatch(
    /worker-hook\.ts'$/,
  )
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

test("the manager's --tools carries Agent, so the mod can spawn a patrol subagent", () => {
  const i = managerCommand().indexOf('--tools')
  expect(i).toBeGreaterThanOrEqual(0)
  expect(managerCommand()[i + 1]!.split(',')).toContain('Agent')
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

test('ruleLines carries the rig goal, when one is given, under its own section after House rules', () => {
  const def = { rules: '- rule one\n- rule two' }
  expect(ruleLines(def)).toEqual(['', '## House rules', def.rules])
  expect(ruleLines(def)).not.toContain('## Rig goal')

  const axGoal =
    'Skip owner-only live applies, credential and branch-protection steps and surface them instead.'
  const lines = ruleLines(def, axGoal)
  expect(lines.indexOf('## House rules')).toBeLessThan(lines.indexOf('## Rig goal'))
  expect(lines).toContain(axGoal)
  expect(lines.join('\n')).toContain('owner-only')

  expect(ruleLines({}, axGoal).join('\n')).not.toContain('## House rules')
  expect(ruleLines({})).toEqual([])
})

test('clipReport leaves a short report alone and caps a long one at REPORT_MAX plus a marker naming both sizes (claude-factory-kcg.2)', () => {
  expect(clipReport('short')).toBe('short')
  expect(clipReport('x'.repeat(REPORT_MAX))).toBe('x'.repeat(REPORT_MAX)) // at the limit: still untouched
  const big = clipReport('x'.repeat(200_000))
  expect(big.length).toBeLessThanOrEqual(REPORT_MAX + '\n[clipped: 32000 of 200000 chars]'.length)
  expect(big).toContain(`[clipped: ${REPORT_MAX} of 200000 chars]`)
  expect(big.startsWith('x'.repeat(REPORT_MAX))).toBe(true)
})

test('clipReport never splits a UTF-16 surrogate pair at the cut, even when the pair straddles REPORT_MAX (claude-factory-kcg.7)', () => {
  // the emoji (a surrogate pair, 2 UTF-16 code units) sits right at the REPORT_MAX boundary
  const text = 'x'.repeat(REPORT_MAX - 1) + '\u{1F600}' + 'y'.repeat(50)
  const clipped = clipReport(text)
  const body = clipped.slice(0, clipped.indexOf('\n[clipped:'))
  const last = body.charCodeAt(body.length - 1)
  expect(last < 0xd800 || last > 0xdbff).toBe(true) // never ends on an unpaired lead surrogate
})

test("brief() clips a 200_000-char inbox mail instead of pasting it whole (the oversized text that made a worker's turn die with ENAMETOOLONG; claude-factory-kcg.2)", () => {
  const run = {
    id: 'r1',
    factory: 'f',
    repo: '/nonexistent/repo-kcg-test',
    goal: 'test goal',
    ws: 'ws',
    worktree: '/nonexistent/worktree-kcg-test',
    branch: 'b',
  }
  const def = {
    name: 'f',
    start: 'implement',
    nodes: { implement: { prompt: 'do the thing', next: { ready: 'verify' } } },
  }
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
  const text = brief(run, def, 'implement', c, [
    { from: 'verify', text: 'x'.repeat(200_000), at: Date.now() },
  ])
  // well under the unclipped size (200_000 plus the brief's own framing): this repo's own memory notes
  // add to that framing, so the bound is loose, not tied to today's exact byte count
  expect(text.length).toBeLessThan(100_000)
  expect(text).toContain('[clipped: 32000 of 200000 chars]')
  expect(text).not.toContain('x'.repeat(40_000))
})

test("brief()'s memory section tells a worker to pass --kind on memory add (claude-factory-3u1.1.1.4), else every add fails after deploy", () => {
  const run = {
    id: 'r1',
    factory: 'f',
    repo: '/nonexistent/repo-kind-test',
    goal: 'test goal',
    ws: 'ws',
    worktree: '/nonexistent/worktree-kind-test',
    branch: 'b',
  }
  const def = {
    name: 'f',
    start: 'implement',
    nodes: { implement: { prompt: 'do the thing', next: { ready: 'verify' } } },
  }
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
  const text = brief(run, def, 'implement', c, [])
  expect(text).toContain('memory add --from r1/implement --kind fact|rule|recipe')
  expect(text).toContain('--until')
})

test('brief() tells an awaitsPr pre-launch park apart from a worker-reported block (claude-factory-960)', () => {
  const run = {
    id: 'r1',
    factory: 'f',
    repo: '/nonexistent/repo-960-test',
    goal: 'test goal',
    ws: 'ws',
    worktree: '/nonexistent/worktree-960-test',
    branch: 'b',
  }
  const def = {
    name: 'f',
    start: 'deploy',
    nodes: { deploy: { prompt: 'ship it', next: { deployed: 'done' } } },
  }
  const baseC = {
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
  }
  const PR = 'https://github.com/acme/widget/pull/7'
  const preLaunch = brief(
    run,
    def,
    'deploy',
    {
      ...baseC,
      log: [
        {
          node: 'deploy',
          attempt: 0,
          outcome: 'blocked',
          summary: `no worker yet: waiting for ${PR}`,
          at: 1,
        },
      ],
    },
    [],
  )
  const workerBlocked = brief(
    run,
    def,
    'deploy',
    {
      ...baseC,
      log: [
        { node: 'deploy', attempt: 1, outcome: 'blocked', summary: `still waiting on review ${PR}`, at: 1 },
      ],
    },
    [],
  )
  expect(preLaunch).toContain('No worker ran yet')
  expect(preLaunch).not.toContain('The previous worker was blocked')
  expect(workerBlocked).toContain('The previous worker was blocked')
  expect(workerBlocked).not.toContain('No worker ran yet')
})

test('ruleLines names a rig’s person-only contexts under the Rig goal section (claude-factory-25z.3)', () => {
  const def = { rules: '- rule one' }
  const axGoal = 'Skip owner-only live applies and surface them instead.'

  const lines = ruleLines(def, axGoal, ['acme'])
  const text = lines.join('\n')
  expect(text).toContain('acme')
  expect(text).toContain('parked, waiting on:')
  expect(lines.indexOf('## Rig goal')).toBeLessThan(lines.findIndex(l => l.includes('acme')))

  // unchanged when no list, an empty list, or no goal at all
  expect(ruleLines(def, axGoal)).toEqual(ruleLines(def, axGoal, undefined))
  expect(ruleLines(def, axGoal, [])).toEqual(ruleLines(def, axGoal))
  expect(ruleLines(def, undefined, ['acme'])).toEqual(ruleLines(def))
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

test('selfUpdateMail mails a repeated refusal again once a no-op sits between the two (claude-factory-5h9.12, claude-factory-6d9)', () => {
  const home = mkdtempSync(join(tmpdir(), 'self-update-mail-'))
  const file = join(home, 'self-update.json')
  const mailedFile = join(home, 'self-update-mailed.json')
  const refusalA = { at: 1, from: 'a1b2c3d', to: 'e4f5a6b', ok: false, why: 'a dirty tree' }

  // first refusal: mailed, and the marker records why
  writeFileSync(file, JSON.stringify(refusalA))
  const first = selfUpdateMail(1, home)
  expect(first).toHaveLength(1)
  expect(first[0]!.text).toContain('a dirty tree')
  expect(readFileSync(mailedFile, 'utf8')).toContain('a dirty tree')

  // the same refusal again, unchanged: already mailed, stays quiet
  const repeat = selfUpdateMail(2, home)
  expect(repeat).toHaveLength(0)

  // a no-op in between (ok, from === to): nothing worth a mail, but it resets the marker
  writeFileSync(
    file,
    JSON.stringify({ at: 3, from: 'e4f5a6b', to: 'e4f5a6b', ok: true, why: 'already up to date' }),
  )
  const noop = selfUpdateMail(3, home)
  expect(noop).toHaveLength(0)
  expect(existsSync(mailedFile)).toBe(false) // the no-op cleared the stale marker

  // the exact same refusal A a second time: must mail again, since the marker is gone
  writeFileSync(file, JSON.stringify(refusalA))
  const again = selfUpdateMail(4, home)
  expect(again).toHaveLength(1)
  expect(again[0]!.text).toContain('a dirty tree')
})

// ---- clipFactsJson (claude-factory-dun.25) ----

const emptyFacts = (extra: Partial<RigFacts> = {}): RigFacts => ({
  busy: 0,
  candidates: [],
  epics: [],
  closedRecently: [],
  liveBeadIds: [],
  findings: [],
  ...extra,
})

test('clipFactsJson stays under its byte budget even when a title is far larger than the slice-20/slice-5 steps expect', () => {
  // the review's own repro: 20 candidates of 8000 characters each, one rig, no other content
  const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}`, title: 'x'.repeat(8000) }))
  const facts: Record<string, RigFacts> = { a: emptyFacts({ candidates }) }
  const out = clipFactsJson(facts)
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(64 * 1024)
})

test('clipFactsJson drops findings beyond 10 and liveBeadIds beyond 20, then shrinks candidates/epics to fit', () => {
  // candidate/epic titles are large enough to force the hard-guarantee loop; finding text stays
  // the size `plan.ts`'s own `sanitize` already bounds it to in real use, so this test checks the
  // 10/20 count caps rather than an unbounded finding-text size the guarantee never promised.
  const bigTitle = 'x'.repeat(4000)
  const findingText = 'y'.repeat(150)
  const facts: Record<string, RigFacts> = {}
  for (const name of ['a', 'b', 'c']) {
    facts[name] = emptyFacts({
      candidates: Array.from({ length: 20 }, (_, i) => ({ id: `${name}-c-${i}`, title: bigTitle })),
      epics: Array.from({ length: 10 }, (_, i) => ({
        id: `${name}-e-${i}`,
        title: bigTitle,
        done: 0,
        total: 1,
        lastProgressHoursAgo: 1,
      })),
      findings: Array.from({ length: 30 }, (_, i) => ({
        kind: 'goal-no-plan',
        rig: name,
        key: `k-${name}-${i}`,
        text: findingText,
      })),
      liveBeadIds: Array.from({ length: 50 }, (_, i) => `${name}-live-${i}`),
    })
  }
  const out = clipFactsJson(facts)
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(64 * 1024)
  const parsed = JSON.parse(out) as Record<string, RigFacts>
  for (const rf of Object.values(parsed)) {
    expect(rf.findings.length).toBeLessThanOrEqual(10)
    expect(rf.liveBeadIds.length).toBeLessThanOrEqual(20)
  }
})

test('clipFactsJson still fits under budget with nothing to drop beyond the normal steps', () => {
  const facts: Record<string, RigFacts> = {
    a: emptyFacts({ candidates: [{ id: 'c-1', title: 'short' }] }),
  }
  const out = clipFactsJson(facts)
  expect(JSON.parse(out).a.candidates).toEqual([{ id: 'c-1', title: 'short' }])
})

// claude-factory-3u1.1.1.3: `factory memory add`'s write gate. These spawn the real CLI binary, like
// memory-add-dup-from.test.ts, and strip the worker-only env vars so the test runs as a laptop call.
const MEMORY_ADD_CLI = join(import.meta.dir, '..', 'bin', 'factory')
const memoryAddHome = (tag: string) => join(tmpdir(), `cli-memory-add-${tag}-${process.pid}`)
const runMemoryAdd = (home: string, args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([MEMORY_ADD_CLI, 'memory', 'add', ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}
const inboxFiles = (home: string) =>
  existsSync(join(home, 'memory', 'inbox')) ? readdirSync(join(home, 'memory', 'inbox')) : []
const freshMemoryAddHome = (tag: string) => {
  const home = memoryAddHome(tag)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  return home
}

test('memory add with no --kind exits 2 and writes nothing', () => {
  const home = freshMemoryAddHome('no-kind')
  const r = runMemoryAdd(home, ['a plain summary', 'a plain body'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--kind')
  expect(r.err).toContain('fact')
  expect(r.err).toContain('rule')
  expect(r.err).toContain('recipe')
  expect(inboxFiles(home)).toEqual([])
}, 30_000)

test('memory add with an invalid --kind exits 2 naming the flag and the bad value', () => {
  const home = freshMemoryAddHome('bad-kind')
  const r = runMemoryAdd(home, ['--kind', 'Fact', 'a plain summary', 'a plain body'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--kind')
  expect(r.err).toContain('Fact')
}, 30_000)

test('memory add that cites a bead, --kind fact, no --until, exits 2 naming --until', () => {
  const home = freshMemoryAddHome('cites-no-until')
  const r = runMemoryAdd(home, ['--kind', 'fact', 'acme-1x2.3 taught us this', 'a plain body'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--until')
  expect(r.err).toContain('acme-1x2.3')
  expect(inboxFiles(home)).toEqual([])
}, 30_000)

test('memory add that cites a bead, --kind fact, no --until, --anyway: still exits 2, the gate runs before dedupe', () => {
  const home = freshMemoryAddHome('cites-anyway')
  const r = runMemoryAdd(home, ['--kind', 'fact', '--anyway', 'acme-1x2.3 taught us this', 'a plain body'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--until')
}, 30_000)

test('memory add --kind recipe that cites a bead with no --until is accepted', () => {
  const home = freshMemoryAddHome('recipe-ok')
  const r = runMemoryAdd(home, ['--kind', 'recipe', 'acme-1x2.3 taught us this', 'a plain body'])
  expect(r.code).toBe(0)
  expect(inboxFiles(home)).toHaveLength(1)
}, 30_000)

test('memory add --kind rule --until <bead id> is accepted and the file carries both fields', () => {
  const home = freshMemoryAddHome('rule-until-ok')
  const r = runMemoryAdd(home, [
    '--kind',
    'rule',
    '--until',
    'acme-1x2.3',
    'acme-1x2.3 taught us this',
    'a plain body',
  ])
  expect(r.code).toBe(0)
  const files = inboxFiles(home)
  expect(files).toHaveLength(1)
  const text = readFileSync(join(home, 'memory', 'inbox', files[0]!), 'utf8')
  expect(text).toContain('kind: rule')
  expect(text).toContain('until: acme-1x2.3')
}, 30_000)

test('memory add with a bad --until value exits 2 naming --until', () => {
  const home = freshMemoryAddHome('bad-until')
  const r = runMemoryAdd(home, ['--kind', 'fact', '--until', 'soon', 'a plain summary', 'a plain body'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--until')
  expect(r.err).toContain('soon')
  expect(inboxFiles(home)).toEqual([])
}, 30_000)

test('memory add gate() runs before dedupe: a refusal fires even when the summary already matches a note', () => {
  const home = freshMemoryAddHome('gate-before-dedupe')
  const summary = 'acme widget retries flush three times before it gives up'
  mkdirSync(join(home, 'memory', 'general'), { recursive: true })
  writeFileSync(join(home, 'memory', 'general', 'x.md'), `---\nsummary: ${summary}\n---\nbody\n`)
  // no --kind: gate() must refuse before same() ever compares this summary to the seeded note above.
  // If dedupe ran first, this would print "already noted" and exit 0 instead.
  const r = runMemoryAdd(home, [summary, 'a plain body'])
  expect(r.code).toBe(2)
  expect(r.out).not.toContain('already noted')
  expect(r.err).toContain('--kind')
}, 30_000)

test('memory add that cites nothing needs no --until', () => {
  const home = freshMemoryAddHome('no-cite-ok')
  const r = runMemoryAdd(home, ['--kind', 'fact', 'a plain summary', 'a plain body'])
  expect(r.code).toBe(0)
  expect(inboxFiles(home)).toHaveLength(1)
}, 30_000)

// claude-factory-3u1.1.2: `factory memory add --supersedes <note path>`. FR-009.
const usageLinesOf = (home: string) =>
  existsSync(join(home, 'memory', '.usage.jsonl'))
    ? readFileSync(join(home, 'memory', '.usage.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []

test('memory add --supersedes with no value after it exits 2 and writes nothing', () => {
  const home = freshMemoryAddHome('supersedes-no-value')
  // --supersedes must be the very last token: the CLI's opt() takes whatever follows a flag as its
  // value, so putting it mid-command would make it swallow 'a plain summary' as a bogus path instead
  const r = runMemoryAdd(home, ['--kind', 'fact', 'a plain summary', 'a plain body', '--supersedes'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
}, 30_000)

test('memory add --supersedes with a value that looks like a flag exits 2 and writes nothing', () => {
  const home = freshMemoryAddHome('supersedes-flag-value')
  mkdirSync(join(home, 'memory'), { recursive: true })
  // a real note literally named "--anyway": if the flag-like-value guard were missing,
  // noteExists() alone would accept this path, so this proves the guard, not noteExists()
  const before = '---\nsummary: a trap note\n---\nbody\n'
  writeFileSync(join(home, 'memory', '--anyway'), before)
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    '--anyway',
    'a plain summary',
    'a plain body',
  ])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(readFileSync(join(home, 'memory', '--anyway'), 'utf8')).toBe(before)
}, 30_000)

test('memory add --supersedes ../outside.md exits 2 and writes nothing, even when that file is real', () => {
  const home = freshMemoryAddHome('supersedes-outside')
  // a real file one level above the memory dir: if the '..' guard were missing, noteExists() alone
  // would accept this path (it only checks the filesystem), so this proves the guard, not noteExists()
  const before = '---\nsummary: a file outside the memory\n---\nbody\n'
  writeFileSync(join(home, 'outside.md'), before)
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    '../outside.md',
    'a plain summary',
    'a plain body',
  ])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(readFileSync(join(home, 'outside.md'), 'utf8')).toBe(before)
}, 30_000)

test('memory add --supersedes into a hidden (dot) segment exits 2 even when that file really exists', () => {
  const home = freshMemoryAddHome('supersedes-hidden')
  mkdirSync(join(home, 'memory', '.archive'), { recursive: true })
  const before = '---\nsummary: an archived note\n---\nbody\n'
  writeFileSync(join(home, 'memory', '.archive', 'x.md'), before)
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    '.archive/x.md',
    'a plain summary',
    'a plain body',
  ])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(readFileSync(join(home, 'memory', '.archive', 'x.md'), 'utf8')).toBe(before)
}, 30_000)

test("memory add --supersedes a topic's whole README.md exits 2 even though the file exists", () => {
  const home = freshMemoryAddHome('supersedes-readme')
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  const before = '---\nsummary: bd topic\n---\nbd notes live here\n'
  writeFileSync(join(home, 'memory', 'beads', 'README.md'), before)
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    'beads/README.md',
    'a plain summary',
    'a plain body',
  ])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(readFileSync(join(home, 'memory', 'beads', 'README.md'), 'utf8')).toBe(before)
}, 30_000)

test("memory add --supersedes a topic's whole LONG.md (no #id) exits 2 even though the file exists", () => {
  const home = freshMemoryAddHome('supersedes-long-whole')
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  const before = '## bd init locks every repo {#lock}\nmerged\n'
  writeFileSync(join(home, 'memory', 'beads', 'LONG.md'), before)
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    'beads/LONG.md',
    'a plain summary',
    'a plain body',
  ])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(readFileSync(join(home, 'memory', 'beads', 'LONG.md'), 'utf8')).toBe(before)
}, 30_000)

test('memory add --supersedes the whole CORE.md (no #hash) exits 2 even though the file exists', () => {
  const home = freshMemoryAddHome('supersedes-core-whole')
  mkdirSync(join(home, 'memory'), { recursive: true })
  const before = '- a core lesson\n'
  writeFileSync(join(home, 'memory', 'CORE.md'), before)
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    'CORE.md',
    'a plain summary',
    'a plain body',
  ])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(readFileSync(join(home, 'memory', 'CORE.md'), 'utf8')).toBe(before)
}, 30_000)

test('memory add --supersedes a note that does not exist exits 2 and writes nothing', () => {
  const home = freshMemoryAddHome('supersedes-missing')
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    'beads/missing.md',
    'a plain summary',
    'a plain body',
  ])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
}, 30_000)

// claude-factory-3u1.1.2.6: noteExists() is only existsSync() for a path with no `#`, so a
// directory passes it. Before the fix, `memory add` wrote the new note, then supersede() crashed
// with EISDIR trying to readFileSync() the directory: exit 1, a note left in inbox/, no
// `superseded:` marker, no contradicted line. These three shapes must all exit 2 and write nothing.
test('memory add --supersedes a topic directory exits 2 and writes nothing', () => {
  const home = freshMemoryAddHome('supersedes-topic-dir')
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(join(home, 'memory', 'beads', 'x.md'), '---\nsummary: a real note\n---\nbody\n')
  const r = runMemoryAdd(home, ['--kind', 'fact', '--supersedes', 'beads', 'a plain summary', 'a plain body'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(usageLinesOf(home)).toEqual([])
  expect(readFileSync(join(home, 'memory', 'beads', 'x.md'), 'utf8')).toBe(
    '---\nsummary: a real note\n---\nbody\n',
  )
}, 30_000)

test('memory add --supersedes . exits 2 and writes nothing', () => {
  const home = freshMemoryAddHome('supersedes-dot')
  mkdirSync(join(home, 'memory'), { recursive: true })
  const r = runMemoryAdd(home, ['--kind', 'fact', '--supersedes', '.', 'a plain summary', 'a plain body'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(usageLinesOf(home)).toEqual([])
}, 30_000)

test('memory add --supersedes a non-.md file exits 2 and writes nothing', () => {
  const home = freshMemoryAddHome('supersedes-non-md')
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(join(home, 'memory', 'beads', 'notes.txt'), 'plain text, not a note\n')
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    'beads/notes.txt',
    'a plain summary',
    'a plain body',
  ])
  expect(r.code).toBe(2)
  expect(r.err).toContain('--supersedes')
  expect(inboxFiles(home)).toEqual([])
  expect(usageLinesOf(home)).toEqual([])
  expect(readFileSync(join(home, 'memory', 'beads', 'notes.txt'), 'utf8')).toBe('plain text, not a note\n')
}, 30_000)

test('memory add --supersedes on a short note writes one superseded: line, keeps every other byte, and logs contradicted', () => {
  const home = freshMemoryAddHome('supersedes-success')
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  const before = '---\nsummary: an old short note\nunknown: kept\n---\nold body text\n'
  writeFileSync(join(home, 'memory', 'beads', 'old.md'), before)
  const r = runMemoryAdd(home, [
    '--from',
    'run1/implement',
    '--kind',
    'fact',
    '--supersedes',
    'beads/old.md',
    'a new replacement note',
    'a new body',
  ])
  expect(r.code).toBe(0)
  const files = inboxFiles(home)
  expect(files).toHaveLength(1)
  const after = readFileSync(join(home, 'memory', 'beads', 'old.md'), 'utf8')
  expect(after).toBe(
    `---\nsummary: an old short note\nunknown: kept\nsuperseded: inbox/${files[0]}\n---\nold body text\n`,
  )
  const lines = usageLinesOf(home)
  const contradicted = lines.find(l => l.path === 'beads/old.md' && l.contradicted === 1)
  expect(contradicted?.by).toBe('run1/implement')
}, 30_000)

test('memory add --supersedes replaces an already-superseded line instead of adding a second one', () => {
  const home = freshMemoryAddHome('supersedes-replace')
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(
    join(home, 'memory', 'beads', 'old.md'),
    '---\nsummary: an old short note\nsuperseded: inbox/stale.md\n---\nold body text\n',
  )
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    'beads/old.md',
    'a new replacement note',
    'a new body',
  ])
  expect(r.code).toBe(0)
  const files = inboxFiles(home)
  const after = readFileSync(join(home, 'memory', 'beads', 'old.md'), 'utf8')
  expect(after).toBe(`---\nsummary: an old short note\nsuperseded: inbox/${files[0]}\n---\nold body text\n`)
}, 30_000)

test("memory add --supersedes follows a rename log to the note's current path", () => {
  const home = freshMemoryAddHome('supersedes-rename')
  mkdirSync(join(home, 'memory', 'beads'), { recursive: true })
  writeFileSync(join(home, 'memory', 'beads', 'new-name.md'), '---\nsummary: moved note\n---\nbody\n')
  writeFileSync(
    join(home, 'memory', '.renames.jsonl'),
    `${JSON.stringify({ old: 'inbox/old-name.md', new: 'beads/new-name.md' })}\n`,
  )
  const r = runMemoryAdd(home, [
    '--kind',
    'fact',
    '--supersedes',
    'inbox/old-name.md',
    'a new replacement note',
    'a new body',
  ])
  expect(r.code).toBe(0)
  const files = inboxFiles(home)
  const after = readFileSync(join(home, 'memory', 'beads', 'new-name.md'), 'utf8')
  expect(after).toBe(`---\nsummary: moved note\nsuperseded: inbox/${files[0]}\n---\nbody\n`)
}, 30_000)

test('memory add --supersedes on a CORE.md#hash fact writes no marker, says so, and still logs contradicted', () => {
  const home = freshMemoryAddHome('supersedes-core-hash')
  mkdirSync(join(home, 'memory'), { recursive: true })
  const before = '- a core lesson\n'
  writeFileSync(join(home, 'memory', 'CORE.md'), before)
  const hash = createHash('sha1').update('a core lesson').digest('hex').slice(0, 8)
  const r = runMemoryAdd(home, [
    '--from',
    'run1/implement',
    '--kind',
    'fact',
    '--supersedes',
    `CORE.md#${hash}`,
    'a new replacement note',
    'a new body',
  ])
  expect(r.code).toBe(0)
  expect(r.out.toLowerCase()).toContain('no marker')
  expect(readFileSync(join(home, 'memory', 'CORE.md'), 'utf8')).toBe(before) // untouched
  const lines = usageLinesOf(home)
  const contradicted = lines.find(l => l.path === `CORE.md#${hash}` && l.contradicted === 1)
  expect(contradicted?.by).toBe('run1/implement')
}, 30_000)

test('memory add --supersedes on a duplicate hit logs confirmed only and does not mark the named note', () => {
  const home = freshMemoryAddHome('supersedes-dup')
  // the note the new attempt will match as a duplicate (same phrasing proven in memory-add-dup-from.test.ts)
  const dupSetup = runMemoryAdd(home, [
    '--from',
    'run1/implement',
    '--kind',
    'fact',
    'fabriek has no CHANGELOG file or per-PR version bump convention',
    'checked the whole history',
  ])
  expect(dupSetup.code).toBe(0)
  // an unrelated note, the one --supersedes names: it must be left alone
  const targetSetup = runMemoryAdd(home, [
    '--kind',
    'fact',
    'acme widget retries flush three times before it gives up',
    'checked the code',
  ])
  expect(targetSetup.code).toBe(0)
  const targetFile = inboxFiles(home).find(f => f.startsWith('acme-widget'))!
  const targetPath = `inbox/${targetFile}`
  const before = readFileSync(join(home, 'memory', targetPath), 'utf8')

  const r = runMemoryAdd(home, [
    '--from',
    'run2/verify',
    '--kind',
    'fact',
    '--supersedes',
    targetPath,
    'no changelog or version bump convention exists in fabriek',
    'hit the same thing',
  ])
  expect(r.code).toBe(0)
  expect(r.out).toContain('already noted')
  expect(r.out).toContain('--supersedes was not applied')
  expect(readFileSync(join(home, 'memory', targetPath), 'utf8')).toBe(before)
  const lines = usageLinesOf(home)
  expect(lines.some(l => l.path === targetPath && l.contradicted === 1)).toBe(false)
  const confirmed = lines.find(l => l.confirmed === 1)
  expect(confirmed?.by).toBe('run2/verify')
}, 30_000)
