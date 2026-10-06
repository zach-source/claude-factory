import { afterAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ax from './ax'
import * as worker from './worker'

const dir = join(tmpdir(), `ax-${process.pid}`)
const calls = join(dir, 'calls.log')
// a fake `ax`: logs its argv and stdin, answers from files named after the subcommand
const fake = join(dir, 'ax')
mkdirSync(dir, { recursive: true })
writeFileSync(
  fake,
  `#!/bin/sh
echo "$*" >> ${calls}
case "$3 $4" in
  "apply -f") cat > ${dir}/applied; echo created ;;
  "get task") [ -f ${dir}/get ] && cat ${dir}/get || { echo 'getting task: rpc error: code = NotFound' >&2; exit 1; } ;;
  ssh*) cat ${dir}/ssh ;;
esac
`,
)
chmodSync(fake, 0o755)
process.env.FACTORY_AX = fake
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  for (const f of ['calls.log', 'get', 'ssh', 'applied']) rmSync(join(dir, f), { force: true })
})
const logged = () => readFileSync(calls, 'utf8').trim().split('\n')

test('task names are RFC 1123 labels that keep the seq', () => {
  expect(ax.taskName('fx-12_Add.health', 3)).toBe('f-fx-12-add-health-3')
  const long = ax.taskName('r'.repeat(80), 12)
  expect(long.length).toBeLessThanOrEqual(63)
  expect(long).toEndWith('-12')
  expect(ax.taskName('a'.repeat(58) + '-b', 1)).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
})

test("a station's model comes from its herdr agent command", () => {
  expect(ax.modelOf(`claude-smart --new --model 'claude-sonnet-5[1m]'`)).toBe('claude-sonnet-5[1m]')
  expect(ax.modelOf('claude-smart --new --dangerously-skip-permissions')).toBeUndefined()
})

test('a launch applies the run branch as the workspace and the brief as a file, and names the worker', () => {
  const pane = ax.launch({
    name: 'f-r1-1',
    repo: 'https://github.com/o/app.git',
    branch: 'factory/r1',
    image: 'img@sha256:abc',
    brief: 'do it',
    model: 'claude-opus-5',
    env: { HTTPS_PROXY: 'http://proxy' },
  })
  expect(pane).toBe('ax:f-r1-1')
  expect(logged()).toEqual(['-a factory apply -f -'])
  const [ws, task] = readFileSync(join(dir, 'applied'), 'utf8')
    .split('\n---\n')
    .map(d => JSON.parse(d))
  expect(ws.kind).toBe('Workspace')
  expect(ws.spec.git).toEqual([
    {
      name: 'origin',
      repo: 'https://github.com/o/app.git',
      branch: 'factory/r1',
      dir: 'repo',
    },
  ])
  expect(ws.spec.files[0]).toEqual({
    path: '.factory-worker/brief.md',
    content: 'do it',
  })
  expect(task.spec.command).toEqual(['factory', 'worker', 'serve', '--model', 'claude-opus-5'])
  expect(task.spec.workspaces).toEqual([{ name: 'f-r1-1', path: '/workspace/w' }])
  expect(task.spec.env).toContainEqual({
    name: 'HTTPS_PROXY',
    value: 'http://proxy',
  })
  expect(task.spec.env).toContainEqual({
    name: 'FACTORY_OUTBOX',
    value: '/workspace/w/.factory-worker/outbox.jsonl',
  })
})

test("a task's phase is read from ax get, and a deleted task has none", () => {
  expect(ax.phase('t')).toBeNull()
  writeFileSync(join(dir, 'get'), 'metadata:\n  name: t\nstatus:\n  phase: Suspended\n  actor: t\n')
  expect(ax.phase('t')).toBe('Suspended')
})

test('poll and prompt go through ax ssh, the prompt base64 so ax cannot take it for its flags', () => {
  writeFileSync(
    join(dir, 'ssh'),
    JSON.stringify({
      status: 'idle',
      session: 's1',
      lines: ['{"argv":["mail"]}'],
    }),
  )
  expect(ax.poll('t', 4)).toEqual({
    status: 'idle',
    session: 's1',
    lines: ['{"argv":["mail"]}'],
  })
  ax.prompt('t', '-a sneaky')
  expect(logged()).toEqual([
    '-a factory ssh t -- factory worker poll 4',
    `-a factory ssh t -- factory worker prompt ${Buffer.from('-a sneaky').toString('base64')}`,
  ])
})

test('the worker briefs once, runs queued prompts in the same session, and queues its reports', async () => {
  const own = join(dir, 'own')
  const repo = join(dir, 'repo')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(own, 'brief.md'), 'the brief')
  // a fake claude: records its argv, prints a stream-json init event
  const claude = join(dir, 'claude')
  writeFileSync(
    claude,
    `#!/bin/sh\necho "$*" >> ${dir}/claude.log\necho '{"type":"system","subtype":"init","session_id":"sess-1"}'\n`,
  )
  chmodSync(claude, 0o755)
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
    FACTORY_FROM: 'implement',
  })

  await worker.serve('m1', { once: true })
  worker.prompt(Buffer.from('[factory mail from manager] yes').toString('base64'))
  expect(worker.poll(0).status).toBe('idle')
  await worker.serve('m1', { once: true }) // a resumed task: no second brief
  const turns = readFileSync(join(dir, 'claude.log'), 'utf8').trim().split('\n')
  expect(turns).toHaveLength(2)
  expect(turns[0]).toEndWith('--model m1 the brief')
  expect(turns[1]).toEndWith('--model m1 --resume sess-1 [factory mail from manager] yes')
  expect(readdirSync(join(own, 'prompts'))).toEqual([])

  worker.queue(['report', 'r1', '1', 'ready', 'done it'])
  worker.queue(['mail', 'r1', 'manager', 'a question'])
  const polled = worker.poll(1)
  expect(polled.session).toBe('sess-1')
  expect(polled.lines.map(l => JSON.parse(l))).toEqual([
    {
      argv: ['mail', 'r1', 'manager', 'a question'],
      from: 'implement',
      at: expect.any(Number),
    },
  ])
  expect(existsSync(join(own, 'claude.jsonl'))).toBe(true)
})

test('with FACTORY_AX_VAULT each task gets its own proxy agent, deleted with the task', () => {
  const vlog = join(dir, 'vault.log')
  const fakeVault = join(dir, 'agent-vault')
  writeFileSync(fakeVault, `#!/bin/sh\necho "$*" >> ${vlog}\n[ "$2" = create ] && echo tok-$3\nexit 0\n`)
  chmodSync(fakeVault, 0o755)
  process.env.FACTORY_AGENT_VAULT = fakeVault
  process.env.FACTORY_AX_VAULT = 'factory@agent-vault.av:14322'
  try {
    ax.launch({ name: 'f-r2-1', repo: 'r', branch: 'b', image: 'i', brief: 'x', env: {} })
    const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
    const env = Object.fromEntries(
      task.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]),
    )
    expect(env.HTTPS_PROXY).toBe('http://tok-f-r2-1:factory@agent-vault.av:14322')
    ax.remove('f-r2-1')
    expect(readFileSync(vlog, 'utf8').trim().split('\n')).toEqual([
      'agent create f-r2-1 --vault factory:proxy --token-only',
      'agent delete f-r2-1',
    ])
  } finally {
    delete process.env.FACTORY_AX_VAULT
    delete process.env.FACTORY_AGENT_VAULT
  }
})
