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
// a fake kubectl: the gateway's CA, and an egress policy refused until the actor exists (the second try)
const kubectl = join(dir, 'kubectl')
writeFileSync(
  kubectl,
  `#!/bin/sh
echo "kubectl $*" >> ${calls}
case "$1" in
  get) printf 'CA-PEM' ;;
  ate) cat > ${dir}/policy; [ -f ${dir}/actor ] || { touch ${dir}/actor; echo 'actor not found' >&2; exit 1; } ;;
esac
`,
)
chmodSync(kubectl, 0o755)
process.env.FACTORY_KUBECTL = kubectl
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  for (const f of ['calls.log', 'get', 'ssh', 'applied', 'policy', 'actor'])
    rmSync(join(dir, f), { force: true })
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

test('a launch applies the task with the run branch, the brief and the CA in its env, then its egress policy', () => {
  const pane = ax.launch(
    {
      name: 'f-r1-1',
      repo: 'https://github.com/o/app.git',
      branch: 'factory/r1',
      image: 'img@sha256:abc',
      brief: 'do it',
      model: 'claude-opus-5',
      env: { FACTORY_FROM: 'implement' },
    },
    { waitMs: 0 },
  )
  expect(pane).toBe('ax:f-r1-1')
  const ate = 'kubectl ate create egress-policy f-r1-1 -a factory -f -'
  expect(logged()).toEqual([
    'kubectl get clustertrustbundle egress-mitm.ate.dev:mitm:primary-bundle -o jsonpath={.spec.trustBundle}',
    '-a factory apply -f -',
    ate,
    ate,
  ])
  const [ws, task] = readFileSync(join(dir, 'applied'), 'utf8')
    .split('\n---\n')
    .map(d => JSON.parse(d))
  expect(ws.kind).toBe('Workspace')
  expect(ws.spec).toEqual({})
  const env = Object.fromEntries(task.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]))
  expect(env).toMatchObject({
    FACTORY_BRIEF: 'do it',
    FACTORY_REPO: 'https://github.com/o/app.git',
    FACTORY_BRANCH: 'factory/r1',
    FACTORY_CA: 'CA-PEM',
    FACTORY_FROM: 'implement',
    FACTORY_OUTBOX: '/workspace/w/.factory-worker/outbox.jsonl',
  })
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined() // no vault, nothing for the gateway to fill in
  expect(env.GIT_CONFIG_COUNT).toBeUndefined()
  expect(task.spec.command).toEqual(['factory', 'worker', 'serve', '--model', 'claude-opus-5'])
  expect(task.spec.workspaces).toEqual([{ name: 'f-r1-1', path: '/workspace/w' }])
  expect(JSON.parse(readFileSync(join(dir, 'policy'), 'utf8'))).toEqual(ax.egressPolicy())
})

test('with a vault named, the task sends placeholder auth headers for the gateway to fill in', () => {
  writeFileSync(join(dir, 'actor'), '')
  process.env.FACTORY_AX_VAULT = 'factory'
  try {
    ax.launch({ name: 't2', repo: 'r', branch: 'b', image: 'i', brief: 'x', env: {} }, { waitMs: 0 })
    const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
    const env = Object.fromEntries(
      task.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]),
    )
    expect(env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      GH_TOKEN: 'placeholder',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic placeholder',
    })
    expect(JSON.parse(readFileSync(join(dir, 'policy'), 'utf8'))).toEqual(ax.egressPolicy('factory'))
  } finally {
    delete process.env.FACTORY_AX_VAULT
  }
})

test('a task whose policy never takes is deleted', () => {
  const ok = process.env.FACTORY_KUBECTL
  process.env.FACTORY_KUBECTL = join(dir, 'kubectl-never')
  writeFileSync(
    process.env.FACTORY_KUBECTL,
    `#!/bin/sh\necho "kubectl $*" >> ${calls}\n[ "$1" = get ] && { printf CA; exit 0; }\nexit 1\n`,
  )
  chmodSync(process.env.FACTORY_KUBECTL, 0o755)
  try {
    expect(() =>
      ax.launch(
        { name: 't9', repo: 'r', branch: 'b', image: 'i', brief: 'x', env: {} },
        { tries: 2, waitMs: 0 },
      ),
    ).toThrow('egress policy for t9')
    expect(logged().slice(-2)).toEqual(['-a factory delete task t9', '-a factory delete workspace t9'])
  } finally {
    process.env.FACTORY_KUBECTL = ok
  }
})

test("a worker's egress policy allows Anthropic and GitHub, and injects keys only from a named vault", () => {
  expect(ax.egressPolicy('')).toEqual({
    rules: [
      { https: { hostnames: ['api.anthropic.com'] } },
      { https: { hostnames: ['api.github.com', 'uploads.github.com'] } },
      { https: { hostnames: ['github.com'] } },
    ],
  })
  const [anthropic, , git] = ax.egressPolicy('factory').rules
  expect(anthropic!.https.effects!.replaceHeaders).toEqual([
    {
      header: 'Authorization',
      prefix: 'Bearer ',
      credentialUri: 'ate-secret://agent-vault/factory/ANTHROPIC',
    },
  ])
  expect(git!.https.effects!.replaceHeaders[0]).toMatchObject({ header: 'Authorization', prefix: 'Basic ' })
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
  process.env.FACTORY_BRIEF = 'the brief'
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

test('setup trusts the CA and clones the branch once, retrying while egress is closed', async () => {
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  const own = join(dir, 'own2')
  const repo = join(dir, 'repo2')
  mkdirSync(own, { recursive: true })
  const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', ...a], { cwd }).exitCode
  git(dir, 'init', '-q', '--bare', origin)
  git(dir, 'init', '-q', '-b', 'factory/r1', seed)
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one')
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const saved = { ...process.env }
  Object.assign(process.env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CA: 'CA-PEM',
    FACTORY_REPO: origin,
    FACTORY_BRANCH: 'factory/r1',
  })
  try {
    // the branch arrives only after the first try, as egress opens only once the policy exists
    const pushing = Bun.sleep(30).then(() => git(seed, 'push', '-q', origin, 'factory/r1'))
    await worker.setup({ tries: 20, waitMs: 20 })
    await pushing
    expect(readFileSync(join(own, 'egress-ca.crt'), 'utf8')).toBe('CA-PEM')
    expect(process.env.GIT_SSL_CAINFO).toBe(join(own, 'egress-ca.crt'))
    expect(existsSync(join(repo, '.git'))).toBe(true)
    expect(existsSync(join(home, '.gitconfig'))).toBe(false) // git's auth header comes in the task's env
    await worker.setup({ tries: 1, waitMs: 0 }) // a resumed task keeps its clone
  } finally {
    process.env = saved
  }
})
