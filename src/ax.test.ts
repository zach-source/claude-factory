import { afterAll, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

test('a launch applies the task with the run branch, the brief and the CA in its env, and does not wait for its policy', () => {
  const pane = ax.launch({
    name: 'f-r1-1',
    repo: 'https://github.com/o/app.git',
    branch: 'factory/r1',
    image: 'img@sha256:abc',
    brief: 'do it',
    model: 'claude-opus-5',
    env: { FACTORY_FROM: 'implement' },
  })
  expect(pane).toBe('ax://f-r1-1')
  expect(logged()).toEqual([
    'kubectl get clustertrustbundle egress-mitm.ate.dev:mitm:primary-bundle -o jsonpath={.spec.trustBundle}',
    '-a factory apply -f -',
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
  // so serve can run as the worker user, not root
  expect(task.spec.capabilities).toEqual(['SETUID', 'SETGID', 'CHOWN'])
})

test('FACTORY_AX_CAPABILITIES empty leaves spec.capabilities out, for an AX without the field', () => {
  process.env.FACTORY_AX_CAPABILITIES = ''
  try {
    ax.launch({ name: 'f-r1-2', repo: 'r', branch: 'b', image: 'i', brief: 'x', env: {} })
    const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
    expect(task.spec.capabilities).toBeUndefined()
  } finally {
    delete process.env.FACTORY_AX_CAPABILITIES
  }
})

test("a task's egress policy is one try: refused until its actor shows, then in", () => {
  expect(ax.createPolicy('f-r1-1')).toBe(false)
  expect(ax.createPolicy('f-r1-1')).toBe(true)
  expect(logged()).toEqual(Array(2).fill('kubectl ate create egress-policy f-r1-1 -a factory -f -'))
  expect(JSON.parse(readFileSync(join(dir, 'policy'), 'utf8'))).toEqual(ax.egressPolicy())
})

test('with a vault named, the task sends placeholder auth headers for the gateway to fill in', () => {
  writeFileSync(join(dir, 'actor'), '')
  process.env.FACTORY_AX_VAULT = 'factory'
  try {
    ax.launch({ name: 't2', repo: 'r', branch: 'b', image: 'i', brief: 'x', env: {} })
    ax.createPolicy('t2')
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

test("a worker's egress policy allows Anthropic and GitHub, and injects keys only from a named vault", () => {
  expect(ax.egressPolicy('')).toEqual({
    rules: [
      { https: { hostnames: ['api.anthropic.com'] } },
      { https: { hostnames: ['api.github.com', 'uploads.github.com'] } },
      { https: { hostnames: ['github.com'] } },
      { https: { hostnames: ['cache.nixos.org', 'devenv.cachix.org', 'channels.nixos.org'] } }, // nix's caches and registry: no key
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

test("a rig's shared Dolt remote is what the VM's beads clone from, with only a placeholder password", () => {
  const own = join(dir, 'own-beads')
  const bd = join(dir, 'bd-boot')
  // bootstrap records what it was given, and makes the embedded store a real one would
  writeFileSync(
    bd,
    `#!/bin/sh\n{ echo "$*"; cat .beads/config.yaml; git config --local remote.origin.url; echo "pw=$DOLT_REMOTE_PASSWORD"; } >> ${join(dir, 'bd-boot.log')}\nmkdir -p .beads/embeddeddolt\n`,
    { mode: 0o755 },
  )
  const saved = { ...process.env }
  delete process.env.DOLT_REMOTE_PASSWORD
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_BEADS: '1',
    FACTORY_BEADS_REMOTE: 'https://dolt.example.com:50051/app_beads',
    FACTORY_BD: bd,
  })
  try {
    worker.setupBeads()
    worker.setupBeads() // a resumed task keeps its clone
    expect(readFileSync(join(dir, 'bd-boot.log'), 'utf8')).toBe(
      'bootstrap -y\nsync.remote: "https://dolt.example.com:50051/app_beads"\npw=placeholder\n',
    )
    expect(process.env.BEADS_DIR).toBe(join(own, 'beads', '.beads'))
  } finally {
    process.env = saved
  }
})

test("a cached devenv becomes the worker's environment, keeping the VM's places and CA", () => {
  const own = join(dir, 'own-devenv')
  const repo = join(dir, 'repo-devenv')
  const bin = join(dir, 'devenv-bin')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(repo, 'devenv.nix'), '{ }\n')
  // print-dev-env's script: exports, stdenv's lowercase attributes, and what must stay the worker's
  writeFileSync(
    join(bin, 'devenv'),
    `#!/bin/sh\necho 'export GOROOT=/nix/go; export PATH=/nix/go/bin; export HOME=/homeless-shelter; export SSL_CERT_FILE=/no-ca; name=devenv-shell-env; export name'\n`,
    { mode: 0o755 },
  )
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_NIX_CACHE: 'https://cache.example.com:8443/devenv devenv:key=',
    PATH: `${bin}:${process.env.PATH}`,
    SSL_CERT_FILE: '/egress-ca',
  })
  const home = process.env.HOME
  try {
    worker.loadDevenv()
    expect(process.env.GOROOT).toBe('/nix/go')
    expect(process.env.PATH).toBe(`/nix/go/bin:${bin}:${saved.PATH}`)
    expect(process.env.HOME).toBe(home)
    expect(process.env.SSL_CERT_FILE).toBe('/egress-ca')
    expect(process.env.name).toBe(saved.name)
  } finally {
    process.env = saved
  }
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
  const keytool = join(dir, 'keytool')
  writeFileSync(keytool, `#!/bin/sh\necho "$@" > ${join(dir, 'keytool.args')}\n`, { mode: 0o755 })
  const saved = { ...process.env }
  Object.assign(process.env, {
    HOME: home,
    FACTORY_KEYTOOL: keytool,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CA: 'CA-PEM',
    FACTORY_REPO: origin,
    FACTORY_BRANCH: 'factory/r1',
    FACTORY_BAZELRC: 'common --remote_cache=grpcs://cache.example',
    FACTORY_KUBE_SERVER: 'https://kube.example',
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
    // the rig's flags, then the gateway's CA for bazel's gRPC and, in a Java trust store, for its JVM
    const rc = readFileSync(join(home, '.bazelrc'), 'utf8').split('\n')
    expect(rc[0]).toBe('common --remote_cache=grpcs://cache.example')
    expect(rc[1]).toBe(`common --tls_certificate=${join(own, 'egress-ca.crt')}`)
    expect(rc[2]).toContain(`-Djavax.net.ssl.trustStore=${join(own, 'egress.jks')}`)
    expect(readFileSync(join(dir, 'keytool.args'), 'utf8')).toContain(
      `-file ${join(own, 'egress-ca.crt')} -keystore ${join(own, 'egress.jks')}`,
    )
    // kubectl's server, trusting the gateway, with a token the gateway replaces
    const kube = JSON.parse(readFileSync(join(home, '.kube', 'config'), 'utf8'))
    expect(kube.clusters[0].cluster).toEqual({
      server: 'https://kube.example',
      'certificate-authority': join(own, 'egress-ca.crt'),
    })
    expect(kube.users[0].user).toEqual({ token: 'placeholder' })
    expect(kube['current-context']).toBe('factory')
    await worker.setup({ tries: 1, waitMs: 0 }) // a resumed task keeps its clone
  } finally {
    process.env = saved
  }
})

test("a turn is the headless command of the rig's agent, resuming by that agent's own session", () => {
  for (const k of ['FACTORY_CLAUDE', 'FACTORY_CODEX', 'FACTORY_PI']) delete process.env[k] // an earlier test's fakes
  const pi = { piDir: '/o/pi' }
  expect(worker.turnArgv('codex', 'go', { model: 'o3' })).toEqual([
    ...['codex', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
    ...['-m', 'o3', '--', 'go'],
  ])
  expect(worker.turnArgv('codex', '-dash', { session: 'th-1' })).toEqual([
    ...['codex', 'exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox'],
    ...['--skip-git-repo-check', '--', 'th-1', '-dash'],
  ])
  expect(worker.turnArgv('pi', 'go', { ...pi, session: 'u-1', provider: 'anthropic', model: 'm' })).toEqual([
    ...['pi', '-p', '--session-dir', '/o/pi', '--session-id', 'u-1'],
    ...['--provider', 'anthropic', '--model', 'm', 'go'],
  ])
  expect(worker.turnArgv('claude', 'go', { session: 's', claudeFlags: ['--tools', 'Bash'] })).toEqual([
    ...['claude', '-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'],
    ...['--tools', 'Bash', '--resume', 's', 'go'],
  ])
  expect(
    worker.sessionIn('codex', '{"type":"thread.started","thread_id":"th-9"}\n{"type":"turn.started"}'),
  ).toBe('th-9')
  expect(worker.sessionIn('codex', '{"type":"turn.started"}')).toBeUndefined()
})

test('a codex worker briefs once, then resumes the thread its first turn named', async () => {
  const own = join(dir, 'own3')
  const repo = join(dir, 'repo3')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const codex = join(dir, 'codex')
  writeFileSync(
    codex,
    `#!/bin/sh\necho "$*" >> ${dir}/codex.log\necho '{"type":"thread.started","thread_id":"th-1"}'\n`,
  )
  chmodSync(codex, 0o755)
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_HARNESS: 'codex',
    FACTORY_CODEX: codex,
    FACTORY_BRIEF: 'codex brief',
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    await worker.serve('o3', { once: true })
    worker.prompt(Buffer.from('more').toString('base64'))
    await worker.serve('o3', { once: true })
    const turns = readFileSync(join(dir, 'codex.log'), 'utf8').trim().split('\n')
    expect(turns[0]).toEndWith('-m o3 -- codex brief')
    expect(turns[1]).toStartWith('exec resume --json')
    expect(turns[1]).toEndWith('-m o3 -- th-1 more')
    expect(worker.poll(0).session).toBe('th-1')
    expect(existsSync(join(own, 'codex.jsonl'))).toBe(true)
  } finally {
    process.env = saved
  }
})

test('a pi worker names its own session and keeps it across turns', async () => {
  const own = join(dir, 'own4')
  const repo = join(dir, 'repo4')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const pi = join(dir, 'pi')
  writeFileSync(pi, `#!/bin/sh\necho "$*" >> ${dir}/pi.log\n`)
  chmodSync(pi, 0o755)
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_HARNESS: 'pi',
    FACTORY_PI: pi,
    FACTORY_BRIEF: 'pi brief',
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    await worker.serve(undefined, { once: true })
    worker.prompt(Buffer.from('more').toString('base64'))
    await worker.serve(undefined, { once: true })
    const [first, second] = readFileSync(join(dir, 'pi.log'), 'utf8').trim().split('\n')
    const id = worker.poll(0).session!
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first).toBe(`-p --session-dir ${join(own, 'pi')} --session-id ${id} pi brief`)
    expect(second).toBe(`-p --session-dir ${join(own, 'pi')} --session-id ${id} more`)
  } finally {
    process.env = saved
  }
})

test('--egress parses hosts, a vault key, and its header and prefix', () => {
  expect(ax.parseEgress('api.openai.com')).toEqual({ hosts: ['api.openai.com'] })
  expect(ax.parseEgress('api.openai.com,auth.openai.com=OPENAI')).toEqual({
    hosts: ['api.openai.com', 'auth.openai.com'],
    key: 'OPENAI',
  })
  expect(ax.parseEgress('api.example.com=EX_KEY:x-api-key:')).toEqual({
    hosts: ['api.example.com'],
    key: 'EX_KEY',
    header: 'x-api-key',
    prefix: '',
  })
  expect(ax.parseEgress('h.example.com=K:Authorization:Token a:b').prefix).toBe('Token a:b')
  expect(() => ax.parseEgress('https://api.openai.com')).toThrow('not a hostname')
  expect(() => ax.parseEgress('localhost')).toThrow('not a hostname')
  expect(() => ax.parseEgress('a.example.com=openai')).toThrow('SCREAMING_SNAKE_CASE')
  expect(() => ax.parseEgress('a.example.com=K:bad header:')).toThrow('header name')
})

test('a rig egress rule on another port names it, as a Dolt remotesapi needs', () => {
  const dolt = {
    hosts: ['dolt.example.com'],
    key: 'DOLT_BASIC',
    header: 'Authorization',
    prefix: 'Basic ',
    port: 50051,
  }
  expect(ax.egressPolicy('factory', [dolt]).rules[4]).toEqual({
    https: {
      hostnames: ['dolt.example.com'],
      ports: { numbers: [50051] },
      effects: {
        replaceHeaders: [
          {
            header: 'Authorization',
            prefix: 'Basic ',
            credentialUri: 'ate-secret://agent-vault/factory/DOLT_BASIC',
          },
        ],
      },
    },
  })
})

test("a rig's egress rules follow the defaults, injected only from a named vault", () => {
  const extra = [ax.parseEgress('api.openai.com=OPENAI'), ax.parseEgress('pypi.org,files.pythonhosted.org')]
  expect(ax.egressPolicy('', extra).rules.slice(4)).toEqual([
    { https: { hostnames: ['api.openai.com'] } },
    { https: { hostnames: ['pypi.org', 'files.pythonhosted.org'] } },
  ])
  const rules = ax.egressPolicy('factory', extra).rules
  expect(rules).toHaveLength(6)
  expect(rules[4]!.https).toEqual({
    hostnames: ['api.openai.com'],
    effects: {
      replaceHeaders: [
        {
          header: 'Authorization',
          prefix: 'Bearer ',
          credentialUri: 'ate-secret://agent-vault/factory/OPENAI',
        },
      ],
    },
  })
  expect(rules[5]!.https).toEqual({ hostnames: ['pypi.org', 'files.pythonhosted.org'] }) // no key: no injection
})

test("a codex task gets its harness, its extra egress and OpenAI's placeholder key", () => {
  writeFileSync(join(dir, 'actor'), '')
  process.env.FACTORY_AX_VAULT = 'factory'
  try {
    ax.launch({
      name: 't3',
      repo: 'r',
      branch: 'b',
      image: 'i',
      brief: 'x',
      harness: 'codex',
      env: {},
    })
    ax.createPolicy('t3', [ax.parseEgress('api.openai.com=OPENAI')])
    const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
    const env = Object.fromEntries(
      task.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]),
    )
    expect(env).toMatchObject({
      FACTORY_HARNESS: 'codex',
      OPENAI_API_KEY: 'placeholder',
      CODEX_API_KEY: 'placeholder',
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'policy'), 'utf8'))).toEqual(
      ax.egressPolicy('factory', [ax.parseEgress('api.openai.com=OPENAI')]),
    )
  } finally {
    delete process.env.FACTORY_AX_VAULT
  }
})

test("a station's model reads codex's -m too, and pi's provider", () => {
  expect(ax.modelOf('codex --dangerously-bypass-approvals-and-sandbox -m o3')).toBe('o3')
  expect(ax.modelOf('pi --provider anthropic --model claude-x')).toBe('claude-x')
  expect(ax.providerOf('pi --provider anthropic --model claude-x')).toBe('anthropic')
  expect(ax.providerOf('pi')).toBeUndefined()
})

test('a file sent in parts appears whole once its last part is in, in any order, and a part sent again is harmless', async () => {
  const worker = await import('./worker')
  const own = mkdtempSync(join(tmpdir(), 'put-'))
  const saved = process.env.FACTORY_WORKER_DIR
  process.env.FACTORY_WORKER_DIR = own
  try {
    const b64 = Buffer.from('é'.repeat(5000)).toString('base64')
    const parts = [b64.slice(0, 4000), b64.slice(4000, 8000), b64.slice(8000)]
    worker.put('f.gz', 2, 3, parts[2]!)
    worker.put('f.gz', 0, 3, parts[0]!)
    worker.put('f.gz', 0, 3, parts[0]!)
    expect(existsSync(join(own, 'f.gz'))).toBe(false)
    worker.put('f.gz', 1, 3, parts[1]!)
    expect(readFileSync(join(own, 'f.gz'), 'utf8')).toBe('é'.repeat(5000))
    expect(() => worker.put('../x', 0, 1, '')).toThrow('a file name')
  } finally {
    process.env.FACTORY_WORKER_DIR = saved
  }
})

test("envtest's kube-apiserver runs through a wrapper that advertises 127.0.0.1, the VM's address being link-local", async () => {
  const { APISERVER_WRAPPER } = await import('./worker')
  const d = mkdtempSync(join(tmpdir(), 'kb-'))
  writeFileSync(join(d, 'kube-apiserver'), '#!/bin/sh\necho "real $*"\n', { mode: 0o755 })
  writeFileSync(join(d, 'wrap'), APISERVER_WRAPPER, { mode: 0o755 })
  const run = (env: Record<string, string>) =>
    Bun.spawnSync([join(d, 'wrap'), '--etcd-servers=x'], { env: { PATH: process.env.PATH!, ...env } })
  expect(run({ KUBEBUILDER_ASSETS: d }).stdout.toString()).toBe(
    'real --advertise-address=127.0.0.1 --etcd-servers=x\n',
  )
  expect(run({ KUBEBUILDER_ASSETS: join(d, 'none') }).exitCode).toBe(127)
})
