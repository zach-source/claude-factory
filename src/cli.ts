// The factory runner: owns .factory/, drives herdr, feeds the xstate machines.
// Only `tick` writes run state (under a lock); every other command appends to
// the run's inbox.jsonl, which the next tick drains in order.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createActor, type Snapshot } from 'xstate'
import {
  compile,
  unread,
  validate,
  where,
  type Ctx,
  type Entry,
  type Ev,
  type Factory,
  type Mail,
} from './machine'

const ROOT = resolve(import.meta.dir, '..')
const HOME = process.env.FACTORY_HOME ?? join(ROOT, '.factory')
const CLI = join(ROOT, 'bin', 'factory')
const AGENT = 'claude-smart --new --no-channels'
const GRACE_MS = 90_000 // a worker idle this long without reporting gets nudged...
const NUDGES = 2 // ...this many times, then fails

type Run = {
  id: string
  factory: string
  repo: string
  goal: string
  ws: string
  worktree: string
  branch: string
  /** the commit the run branched from: what its stations committed is base..HEAD */
  base?: string
  forkedFrom?: string
}
type Saved = { cursor: number; snapshot: Snapshot<unknown> & { value: unknown; context: Ctx } }
type Input = Ev extends infer E ? (E extends Ev ? Omit<E, 'at'> : never) : never
export type Row = {
  id: string
  factory?: string
  goal?: string
  node?: string
  sub?: string
  attempt?: number
  attempts?: number
  pane?: string | null
  agent?: string | null
  ws?: string
  error?: string | null
  last?: Entry
}

const runDir = (id: string) => join(HOME, 'runs', id)
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'))
/** written and fsynced: a report or snapshot outlives a power cut, not just a crash */
function durable(path: string, text: string, flag: 'w' | 'a') {
  const fd = openSync(path, flag)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function writeJson(path: string, value: unknown) {
  durable(`${path}.tmp`, JSON.stringify(value, null, 2), 'w')
  renameSync(`${path}.tmp`, path) // atomic: a reader never sees half a snapshot
}
const fail = (msg: string): never => {
  throw new Error(msg)
}

function herdr(...args: string[]) {
  const p = Bun.spawnSync(['herdr', ...args])
  const out = p.stdout.toString().trim()
  if (p.exitCode !== 0) fail(`herdr ${args.slice(0, 2).join(' ')}: ${p.stderr.toString().trim() || out}`)
  return out.startsWith('{') ? JSON.parse(out).result : out
}

/** the pane's agent status and Claude session id, or null once the pane is gone */
function paneInfo(pane: string): { status: string; session?: string } | null {
  const p = Bun.spawnSync(['herdr', 'pane', 'get', pane])
  const out = JSON.parse(p.stdout.toString() || '{}')
  if (out.error?.code === 'pane_not_found') return null
  if (p.exitCode !== 0) fail(`herdr pane get: ${out.error?.message ?? p.stderr.toString()}`)
  const info = out.result.pane
  return {
    status: info.agent_status,
    session: info.agent === 'claude' ? info.agent_session?.value : undefined,
  }
}

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args])
  return p.exitCode === 0 ? p.stdout.toString().trim() : fail(`git ${args[0]}: ${p.stderr.toString().trim()}`)
}

const factoryPath = (arg: string) => (existsSync(arg) ? resolve(arg) : join(ROOT, 'factories', `${arg}.ts`))
const loadFactory = async (file: string): Promise<Factory> => validate((await import(file)).default)
const runIds = () => (existsSync(join(HOME, 'runs')) ? readdirSync(join(HOME, 'runs')).sort() : [])
function loadRun(id: string | undefined): Run {
  const file = join(runDir(id ?? ''), 'run.json')
  return existsSync(file) ? readJson(file) : fail(`no run "${id}" (runs: ${runIds().join(', ') || 'none'})`)
}
/** complete lines only: a writer may be mid-append */
const inboxLines = (id: string) => {
  const file = join(runDir(id), 'inbox.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, -1) : []
}
const post = (id: string, e: Input) =>
  durable(join(runDir(id), 'inbox.jsonl'), JSON.stringify({ ...e, at: Date.now() }) + '\n', 'a')

function brief(run: Run, def: Factory, node: string, c: Ctx, inbox: Mail[]) {
  const n = def.nodes[node]!
  const lastFail = c.attempt > 1 ? c.log.findLast(e => e.node === node && e.outcome === 'fail') : undefined
  // a fresh worker is told what earlier ones already committed, so it builds on it rather than redoing it
  const committed = run.base ? git(run.worktree, 'log', '--oneline', '-n', '30', `${run.base}..HEAD`) : ''
  return [
    `You are the "${node}" station of the software factory "${def.name}" (run ${run.id}, attempt ${c.attempt} of ${1 + (n.retries ?? 2)}).`,
    `You work in the git worktree ${run.worktree} on branch ${run.branch}. Commit your work there and touch no other checkout.`,
    '',
    '## Goal',
    run.goal,
    '',
    '## Your task',
    n.prompt.trim(),
    ...(lastFail ? ['', '## The previous attempt failed', lastFail.summary] : []),
    ...(committed
      ? ['', '## Already committed on this branch (build on it, do not redo it)', committed]
      : []),
    ...(inbox.length ? ['', '## Inbox', ...inbox.map(m => `- from ${m.from}: ${m.text}`)] : []),
    '',
    '## Reporting (required)',
    'When you are finished, report exactly once and then stop:',
    `    ${CLI} report ${run.id} ${c.seq} <outcome> "<summary for the next station>"`,
    'Outcomes:',
    ...Object.entries(n.next).map(([outcome, to]) => `- ${outcome}: goes to ${to}`),
    '- fail: you cannot do it; a fresh worker retries',
    `To ask the manager, run \`${CLI} mail ${run.id} manager "<question>"\` and wait: replies arrive as [factory mail] messages.`,
  ].join('\n')
}

const resumeNote = (run: Run, node: string, c: Ctx) =>
  `[factory] Your pane closed and this session was resumed. Carry on as the "${node}" station where you left off: ` +
  `check git status and git log first. When finished, report exactly once: ${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"`

/** a worker in a new tab of the run's workspace; given a session, it resumes that conversation */
function spawn(run: Run, def: Factory, node: string, c: Ctx, session?: string) {
  const prompt = join(runDir(run.id), 'prompts', `${c.seq}-${node}${session ? '-resume' : ''}.md`)
  writeFileSync(prompt, session ? resumeNote(run, node, c) : brief(run, def, node, c, c.mail[node] ?? []))
  const tab = () =>
    herdr(
      ...['tab', 'create', '--workspace', run.ws, '--cwd', run.worktree],
      ...['--label', `${node}#${c.attempt}`, '--no-focus'],
      ...['--env', `FACTORY_FROM=${node}`, '--env', `FACTORY_HOME=${HOME}`],
    )
  let created
  try {
    created = tab()
  } catch {
    // the person closed the run's workspace: reopen the worktree and carry on
    const opened = herdr(
      'worktree',
      'open',
      '--cwd',
      run.repo,
      '--branch',
      run.branch,
      '--no-focus',
      '--json',
    )
    run.ws = opened.workspace.workspace_id
    writeJson(join(runDir(run.id), 'run.json'), run)
    created = tab()
  }
  const pane: string = created.root_pane.pane_id
  const agent = def.nodes[node]!.agent ?? def.agent ?? AGENT
  // ponytail: resume assumes a claude-style CLI; only a pane herdr saw running claude ever has a session
  const cmd = session ? `${agent.replace(/\s--new\b/, '')} --resume ${session}` : agent
  herdr('pane', 'run', pane, `${cmd} "$(cat '${prompt}')"`)
  return pane
}

/** level-triggered: make the world match the current state, report what happened as events */
function reconcile(run: Run, def: Factory, c: Ctx, node: string, send: (e: Input) => void, now: number) {
  if (!c.pane) {
    const pane = spawn(run, def, node, c)
    send({ type: 'SPAWNED', seq: c.seq, pane })
    const box = c.mail[node] ?? [] // the brief carried the whole box
    if (box.length) send({ type: 'READ', box: node, seen: box.length })
    return 'starting'
  }
  const info = paneInfo(c.pane)
  if (info?.session && info.session !== c.session)
    send({ type: 'SESSION', seq: c.seq, session: info.session })
  if (info === null && c.session && c.resumes < 1) {
    send({ type: 'SPAWNED', seq: c.seq, pane: spawn(run, def, node, c, c.session), isResume: true })
    return 'resuming'
  }
  const status = info?.status ?? null
  const timeoutMin = def.nodes[node]!.timeoutMin ?? 60
  const inbox = unread(c, node)
  if (status === null) send({ type: 'FAIL', seq: c.seq, reason: `worker pane ${c.pane} was closed` })
  else if (now - c.startedAt > timeoutMin * 60_000)
    send({ type: 'FAIL', seq: c.seq, reason: `no report within ${timeoutMin} min` })
  else if (inbox.length && status !== 'blocked') {
    herdr('agent', 'prompt', c.pane, inbox.map(m => `[factory mail from ${m.from}] ${m.text}`).join('\n\n'))
    send({ type: 'READ', box: node, seen: c.mail[node]!.length })
  } else if ((status === 'idle' || status === 'done') && now - Math.max(c.startedAt, c.nudgedAt) > GRACE_MS) {
    if (c.nudges >= NUDGES) send({ type: 'FAIL', seq: c.seq, reason: 'worker stopped without reporting' })
    else {
      const cmd = `${CLI} report ${run.id} ${c.seq} <outcome> "<summary>"`
      herdr('agent', 'prompt', c.pane, `[factory] You have not reported. If you are finished run: ${cmd}`)
      send({ type: 'NUDGED', seq: c.seq })
    }
  }
  return status
}

function row(run: Run, def: Factory, value: unknown, c: Ctx, agent?: string | null, error?: string): Row {
  const [node, sub] = where(value)
  const retries = def.nodes[node]?.retries ?? 2
  return {
    id: run.id,
    factory: def.name,
    goal: run.goal,
    node,
    sub,
    attempt: c.attempt,
    attempts: 1 + retries,
    pane: c.pane,
    agent,
    ws: run.ws,
    error: error ?? c.error,
    last: c.log.at(-1),
  }
}

async function tickRun(run: Run, now: number) {
  const def = await loadFactory(run.factory)
  const file = join(runDir(run.id), 'state.json')
  const saved = readJson<Saved>(file)
  const actor = createActor(compile(def), { snapshot: saved.snapshot }).start()
  const lines = inboxLines(run.id)
  const ctx = () => actor.getSnapshot().context
  const save = () => writeJson(file, { cursor: lines.length, snapshot: actor.getPersistedSnapshot() })
  const send = (e: Input, at = now) => {
    const pane = ctx().pane
    actor.send({ ...e, at } as Ev)
    if (pane && pane !== ctx().pane) Bun.spawnSync(['herdr', 'pane', 'close', pane]) // gone already is fine
  }

  for (const line of lines.slice(saved.cursor)) {
    const e = JSON.parse(line) as Ev
    send(e, e.at)
  }
  send({ type: 'TICK' })

  let agent: string | null | undefined
  let error: string | undefined
  const [node, sub] = where(actor.getSnapshot().value)
  try {
    if (sub === 'working') agent = reconcile(run, def, ctx(), node, send, now)
    else if (ctx().pane) agent = paneInfo(ctx().pane!)?.status ?? null
  } catch (err) {
    error = (err as Error).message
  }

  const manager = unread(ctx(), 'manager')
  if (manager.length) send({ type: 'READ', box: 'manager', seen: ctx().mail.manager!.length })
  save()
  return {
    row: row(run, def, actor.getSnapshot().value, ctx(), agent, error),
    manager: manager.map(m => ({ run: run.id, ...m })),
  }
}

async function tick() {
  const lock = join(HOME, 'tick.lock')
  mkdirSync(HOME, { recursive: true })
  try {
    mkdirSync(lock)
  } catch {
    if (Date.now() - statSync(lock).mtimeMs < 120_000) return { busy: true }
  }
  try {
    const now = Date.now()
    const out = { runs: [] as Row[], manager: [] as (Mail & { run: string })[] }
    for (const id of runIds()) {
      try {
        const { row, manager } = await tickRun(loadRun(id), now)
        out.runs.push(row)
        out.manager.push(...manager)
      } catch (err) {
        out.runs.push({ id, error: (err as Error).message })
      }
    }
    return out
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** a run is a branch + herdr worktree + snapshot; a fork starts from another run's branch and snapshot */
function createRun(
  def: Factory,
  file: string,
  repo: string,
  goal: string,
  from?: { run: Run; saved: Saved },
) {
  const id = `${def.name}-${Date.now().toString(36)}`
  const branch = `factory/${id}`
  const base = from?.run.base ?? git(repo, 'rev-parse', 'HEAD')
  const created = herdr(
    ...['worktree', 'create', '--cwd', repo, '--branch', branch, '--base', from?.run.branch ?? base],
    ...['--label', `${basename(repo)}/${id}`, '--no-focus', '--json'],
  )
  const run: Run = {
    id,
    factory: file,
    repo,
    goal,
    branch,
    base,
    ws: created.workspace.workspace_id,
    worktree: created.worktree.path,
    ...(from && { forkedFrom: from.run.id }),
  }
  // the source's worker stays the source's: the fork launches its own
  const snapshot = from
    ? {
        ...from.saved.snapshot,
        context: { ...from.saved.snapshot.context, pane: null, session: null, resumes: 0 },
      }
    : createActor(compile(def)).getPersistedSnapshot()
  mkdirSync(join(runDir(id), 'prompts'), { recursive: true })
  writeJson(join(runDir(id), 'run.json'), run)
  writeJson(join(runDir(id), 'state.json'), { cursor: 0, snapshot })
  return run
}

async function start(factory: string | undefined, repo: string | undefined, goal: string) {
  if (!factory || !repo || !goal) fail('usage: factory start <factory> <repo> <goal...>')
  const file = factoryPath(factory!)
  const run = createRun(await loadFactory(file), file, resolve(repo!.replace(/^~(?=\/|$)/, homedir())), goal)
  await tick() // launches the first worker now rather than at the next tick
  console.log(`started ${run.id} in ${run.worktree} (herdr workspace ${run.ws})`)
}

async function fork(id: string | undefined, station: string | undefined, note: string) {
  const { run: src, value } = current(id)
  const def = await loadFactory(src.factory)
  if (!def.nodes[station ?? ''])
    fail(`usage: factory fork <run> <station> [note...]; stations: ${Object.keys(def.nodes).join(', ')}`)
  const saved = readJson<Saved>(join(runDir(src.id), 'state.json'))
  const run = createRun(def, src.factory, src.repo, src.goal, { run: src, saved })
  const [node, sub] = where(value)
  if (node !== station || sub !== 'working') post(run.id, { type: 'GOTO', node: station! })
  if (note) post(run.id, { type: 'MAIL', from: 'manager', to: station!, text: note })
  await tick()
  console.log(`forked ${src.id} at ${station} into ${run.id}: branch ${run.branch} from ${src.branch}`)
}

function current(id: string | undefined) {
  const run = loadRun(id)
  const saved = readJson<Saved>(join(runDir(run.id), 'state.json'))
  return { run, value: saved.snapshot.value, c: saved.snapshot.context }
}

async function status(id: string | undefined) {
  if (!runIds().length) console.log('no runs yet: factory start <factory> <repo> <goal...>')
  for (const runId of id ? [id] : runIds()) {
    const { run, value, c } = current(runId)
    const r = row(
      run,
      await loadFactory(run.factory),
      value,
      c,
      c.pane ? paneInfo(c.pane)?.status : undefined,
    )
    const at = r.sub ? `${r.node}/${r.sub}` : r.node
    console.log(`${r.id}  ${at}  try ${r.attempt}/${r.attempts}  pane ${r.pane ?? '-'} (${r.agent ?? '-'})`)
    console.log(`  goal: ${r.goal}`)
    if (r.error) console.log(`  error: ${r.error}`)
    const mail = Object.keys(c.mail).filter(box => unread(c, box).length)
    if (mail.length) console.log(`  unread: ${mail.map(box => `${box} ${unread(c, box).length}`).join(', ')}`)
    for (const e of id ? c.log : c.log.slice(-1))
      console.log(`  ${e.node}#${e.attempt} ${e.outcome}: ${e.summary.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
}

const [cmd, ...args] = process.argv.slice(2)
const usage = `factory — herdr software factories on xstate

  start <factory> <repo> <goal...>   new run: herdr worktree off <repo>, first worker launched
  status [run]                       runs at a glance, or one run's full log
  tick                               advance every run once (the manager mod does this every 5s)
  report <run> <seq> <outcome> <summary...>   worker: finish its station
  mail <run> <node|manager> <text...>         drop a message in a mailbox
  retry <run> | goto <run> <node|done> | abort <run>   quarterback a run
  fork <run> <station> [note...]     new run from <run>'s branch and state, restarted at <station>
  rm <run>                           finished run: drop its worktree and state, keep its branch

<factory> is a path or a name under ${join(ROOT, 'factories')}; state lives in ${HOME}.`

try {
  switch (cmd) {
    case 'start':
      await start(args[0], args[1], args.slice(2).join(' '))
      break
    case 'fork':
      await fork(args[0], args[1], args.slice(2).join(' '))
      break
    case 'tick':
      console.log(JSON.stringify(await tick()))
      break
    case 'status':
      await status(args[0])
      break
    case 'report': {
      const [id, seq, outcome, ...summary] = args
      const { run, value, c } = current(id)
      const [node] = where(value)
      const outcomes = Object.keys((await loadFactory(run.factory)).nodes[node]?.next ?? {}).concat('fail')
      if (Number(seq) !== c.seq)
        fail(`stale report: seq ${seq} is no longer the active worker (now ${c.seq}); stop here`)
      if (!outcomes.includes(outcome ?? '')) fail(`outcome must be one of: ${outcomes.join(', ')}`)
      const text = summary.join(' ')
      post(
        run.id,
        outcome === 'fail'
          ? { type: 'FAIL', seq: c.seq, reason: text }
          : { type: 'DONE', seq: c.seq, outcome: outcome!, summary: text },
      )
      console.log(`reported ${outcome} for ${node}; you are done, stop now`)
      break
    }
    case 'mail': {
      const [id, to, ...text] = args
      const run = loadRun(id)
      const boxes = Object.keys((await loadFactory(run.factory)).nodes).concat('manager')
      if (!boxes.includes(to ?? '')) fail(`mailbox must be one of: ${boxes.join(', ')}`)
      post(run.id, {
        type: 'MAIL',
        from: process.env.FACTORY_FROM ?? 'manager',
        to: to!,
        text: text.join(' '),
      })
      console.log(`mailed ${to}`)
      break
    }
    case 'retry':
      post(loadRun(args[0]).id, { type: 'RETRY' })
      break
    case 'goto': {
      const run = loadRun(args[0])
      const nodes = Object.keys((await loadFactory(run.factory)).nodes).concat('done')
      if (!nodes.includes(args[1] ?? '')) fail(`node must be one of: ${nodes.join(', ')}`)
      post(run.id, { type: 'GOTO', node: args[1]! })
      break
    }
    case 'abort':
      post(loadRun(args[0]).id, { type: 'ABORT' })
      break
    case 'rm': {
      const { run, value } = current(args[0])
      if (!['done', 'aborted'].includes(where(value)[0])) fail(`${run.id} is still running: abort it first`)
      // no --force: herdr refuses a worktree with uncommitted work; the branch always stays
      herdr('worktree', 'remove', '--workspace', run.ws)
      rmSync(runDir(run.id), { recursive: true })
      console.log(`removed ${run.id}; its work stays on branch ${run.branch}`)
      break
    }
    default:
      console.log(usage)
      if (cmd && cmd !== 'help') process.exitCode = 2
  }
} catch (err) {
  console.error(`factory: ${(err as Error).message}`)
  process.exitCode = 1
}
