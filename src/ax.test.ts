import { afterAll, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  cpSync,
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
import { vmCodexHome } from './cli'
import { CODEX_GUARD_FLAGS } from './harness'
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
echo "\${AX_AUTH_TOKEN:+set}" >> ${dir}/auth
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
case "$*" in
  *"get deployment ax-controller"*) cat ${dir}/controller; exit $? ;;
esac
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
  for (const f of ['calls.log', 'get', 'ssh', 'applied', 'policy', 'actor', 'controller', 'bctl', 'auth'])
    rmSync(join(dir, f), { force: true })
})
const logged = () => readFileSync(calls, 'utf8').trim().split('\n')

test('controller readiness requires current observed generation and available replicas', () => {
  const ready = {
    metadata: { generation: 3 },
    spec: { replicas: 1 },
    status: { observedGeneration: 3, readyReplicas: 1, availableReplicas: 1 },
  }
  for (const value of [
    'not json',
    'null',
    '{}',
    JSON.stringify({ ...ready, status: { ...ready.status, observedGeneration: 2 } }),
    JSON.stringify({ ...ready, status: { ...ready.status, readyReplicas: 0 } }),
    JSON.stringify({ ...ready, status: { ...ready.status, availableReplicas: 0 } }),
    JSON.stringify({ ...ready, spec: { replicas: 0 } }),
    JSON.stringify({ ...ready, spec: { replicas: '1' } }),
    JSON.stringify({ ...ready, status: { ...ready.status, readyReplicas: true } }),
    JSON.stringify({ ...ready, status: { ...ready.status, availableReplicas: '1' } }),
    JSON.stringify({ ...ready, metadata: { ...ready.metadata, deletionTimestamp: '2026-10-18T00:00:00Z' } }),
  ]) {
    writeFileSync(join(dir, 'controller'), value)
    expect(ax.unavailable()).toContain('AX executor unavailable')
  }
  rmSync(join(dir, 'controller'))
  expect(ax.unavailable()).toContain('could not be observed')
  writeFileSync(join(dir, 'controller'), JSON.stringify(ready))
  const previous = process.env.FACTORY_AX_CONTEXT
  process.env.FACTORY_AX_CONTEXT = 'test-cluster'
  try {
    expect(ax.unavailable()).toBeUndefined()
    expect(logged().at(-1)).toBe(
      'kubectl --context test-cluster get deployment ax-controller -n ax-system -o json --request-timeout=5s',
    )
  } finally {
    if (previous === undefined) delete process.env.FACTORY_AX_CONTEXT
    else process.env.FACTORY_AX_CONTEXT = previous
  }
})

test('task names are RFC 1123 labels that keep the seq', () => {
  expect(ax.taskName('fx-12_Add.health', 3)).toBe('f-fx-12-add-health-3')
  const long = ax.taskName('r'.repeat(80), 12)
  expect(long.length).toBeLessThanOrEqual(63)
  expect(long).toEndWith('-12')
  expect(ax.taskName('a'.repeat(58) + '-b', 1)).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
})

test("a station's model comes from its herdr agent command", () => {
  expect(ax.modelOf(`claude-smart --new --model 'claude-sonnet-5-5[1m]'`)).toBe('claude-sonnet-5-5[1m]')
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

test("a rig's sandboxClass reaches spec.sandboxClass; absent, the field stays out for an AX without it", () => {
  ax.launch({
    name: 'f-r1-3',
    repo: 'r',
    branch: 'b',
    image: 'i',
    brief: 'x',
    env: {},
    sandboxClass: 'microvm',
  })
  const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
  expect(task.spec.sandboxClass).toBe('microvm')
  ax.launch({ name: 'f-r1-4', repo: 'r', branch: 'b', image: 'i', brief: 'x', env: {} })
  const plain = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
  expect(plain.spec.sandboxClass).toBeUndefined()
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

const keyOf = (r: { https: { effects?: { replaceHeaders: { credentialUri: string }[] } } }) =>
  r.https.effects!.replaceHeaders[0]!.credentialUri.split('/').at(-1)

test('path-prefixed GitHub rules pick the zach-source keys; the unprefixed ones keep the default keys', () => {
  type R = {
    https: {
      hostnames: string[]
      pathPrefixes?: string[]
      effects?: { replaceHeaders: { header: string; prefix: string; credentialUri: string }[] }
    }
  }
  const rules = ax.egressPolicy('factory').rules as R[]
  const zsGit = rules.find(r => r.https.pathPrefixes?.[0] === '/zach-source/')!
  expect(zsGit.https).toEqual({
    hostnames: ['github.com'],
    pathPrefixes: ['/zach-source/'],
    effects: {
      replaceHeaders: [
        {
          header: 'Authorization',
          prefix: 'Basic ',
          credentialUri: 'ate-secret://agent-vault/factory/GITHUB_ZS_BASIC',
        },
      ],
    },
  })
  const zsApi = rules.find(r => r.https.pathPrefixes?.[0] === '/repos/zach-source/')!
  expect(zsApi.https).toEqual({
    hostnames: ['api.github.com', 'uploads.github.com'],
    pathPrefixes: ['/repos/zach-source/'],
    effects: {
      replaceHeaders: [
        {
          header: 'Authorization',
          prefix: 'Bearer ',
          credentialUri: 'ate-secret://agent-vault/factory/GITHUB_ZS',
        },
      ],
    },
  })
  const plain = rules.filter(r => !r.https.pathPrefixes)
  expect(keyOf(plain.find(r => r.https.hostnames[0] === 'github.com')!)).toBe('GITHUB_BASIC')
  expect(keyOf(plain.find(r => r.https.hostnames[0] === 'api.github.com')!)).toBe('GITHUB')
  // two rules for one host must not share a prefix
  const seen = new Set<string>()
  for (const r of rules)
    for (const h of r.https.hostnames)
      for (const p of r.https.pathPrefixes ?? ['']) {
        expect(seen.has(`${h} ${p}`)).toBe(false)
        seen.add(`${h} ${p}`)
      }
  // no vault: no prefixed rule
  expect(JSON.stringify(ax.egressPolicy(''))).not.toContain('pathPrefixes')
})

test('a worker of a zach-source rig gets the zach-source keys on the unprefixed GitHub rules', () => {
  const plainKeys = (owner?: string) =>
    (ax.egressPolicy('factory', [], undefined, undefined, owner).rules as any[])
      .filter(r => !r.https.pathPrefixes && /github\.com/.test(r.https.hostnames[0]))
      .map(keyOf)
  expect(plainKeys('zach-source')).toEqual(['GITHUB_ZS', 'GITHUB_ZS_BASIC'])
  expect(plainKeys('acme')).toEqual(['GITHUB', 'GITHUB_BASIC'])
  expect(plainKeys()).toEqual(['GITHUB', 'GITHUB_BASIC'])
})

test('reviewer flag: the GitHub API rule uses GITHUB_REVIEWER, nothing else changes', () => {
  const keys = (owner?: string, reviewer?: boolean) =>
    (ax.egressPolicy('v', [], undefined, undefined, owner, undefined, reviewer).rules as any[])
      .filter(r => /github\.com/.test(r.https.hostnames[0]))
      .map(r => [r.https.pathPrefixes?.[0] ?? '', keyOf(r)])
  expect(keys('acme', true)).toEqual([
    ['', 'GITHUB_REVIEWER'],
    ['', 'GITHUB_BASIC'],
    ['/repos/zach-source/', 'GITHUB_ZS'],
    ['/zach-source/', 'GITHUB_ZS_BASIC'],
  ])
  expect(keys('zach-source', true)).toEqual([
    ['', 'GITHUB_REVIEWER'],
    ['', 'GITHUB_ZS_BASIC'],
    ['/repos/zach-source/', 'GITHUB_REVIEWER'],
    ['/zach-source/', 'GITHUB_ZS_BASIC'],
  ])
  expect(keys('acme', true).slice(2)).toEqual(keys('acme', false).slice(2))
  expect(keys('acme', false)[0]).toEqual(['', 'GITHUB'])
  expect(ax.egressPolicy('v', [], undefined, undefined, 'acme', undefined, false)).toEqual(
    ax.egressPolicy('v', [], undefined, undefined, 'acme'),
  )
  expect(ax.egressPolicy('', [], undefined, undefined, 'acme', undefined, true)).toEqual(ax.egressPolicy(''))
  expect(
    JSON.stringify(ax.egressPolicy('v', [], undefined, undefined, undefined, 'GITHUB_BASIC_MANAGER')),
  ).not.toContain('REVIEWER')
})

test('reviewerTask is true only for review, security and check with the vault and a matching owner flag', () => {
  const env = { FACTORY_AX_VAULT: 'v', FACTORY_AX_REVIEWER_OWNER: 'acme' }
  for (const n of ['review', 'security', 'check']) expect(ax.reviewerTask(n, 'acme', env)).toBe(true)
  for (const n of [
    'implement',
    'plan',
    'verify',
    'triage',
    'quick',
    'release',
    'incident',
    'Review',
    ' review',
  ])
    expect(ax.reviewerTask(n, 'acme', env)).toBe(false)
  expect(ax.reviewerTask('review', 'other', env)).toBe(false)
  expect(ax.reviewerTask('review', undefined, env)).toBe(false)
  expect(ax.reviewerTask('review', 'acme', { ...env, FACTORY_AX_REVIEWER_OWNER: '' })).toBe(false)
  expect(ax.reviewerTask('review', 'acme', { FACTORY_AX_VAULT: 'v' })).toBe(false)
  expect(ax.reviewerTask('review', 'acme', { FACTORY_AX_REVIEWER_OWNER: 'acme' })).toBe(false)
})

test('createPolicy passes the reviewer flag to the policy', () => {
  process.env.FACTORY_AX_VAULT = 'factory'
  try {
    writeFileSync(join(dir, 'actor'), '')
    ax.createPolicy('t4', [], undefined, 'acme', undefined, true)
    expect(readFileSync(join(dir, 'policy'), 'utf8')).toContain('factory/GITHUB_REVIEWER')
  } finally {
    delete process.env.FACTORY_AX_VAULT
  }
})

test('createPolicy passes the rig owner to the policy', () => {
  process.env.FACTORY_AX_VAULT = 'factory'
  try {
    writeFileSync(join(dir, 'actor'), '')
    ax.createPolicy('t3', [], undefined, 'zach-source')
    expect(JSON.parse(readFileSync(join(dir, 'policy'), 'utf8'))).toEqual(
      ax.egressPolicy('factory', [], undefined, undefined, 'zach-source'),
    )
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
  // no gate here, so every rule is the https shape -- a type-only cast, past `rules`' now-wider type
  // (a gated rule can be `{ http: ... }` instead), not a behavior change
  const [anthropic, , git] = ax.egressPolicy('factory').rules as {
    https: { effects?: { replaceHeaders: { header: string; prefix: string; credentialUri: string }[] } }
  }[]
  expect(anthropic!.https.effects!.replaceHeaders).toEqual([
    {
      header: 'Authorization',
      prefix: 'Bearer ',
      credentialUri: 'ate-secret://agent-vault/factory/ANTHROPIC',
    },
  ])
  expect(git!.https.effects!.replaceHeaders[0]).toMatchObject({ header: 'Authorization', prefix: 'Basic ' })
})

test('the manager has its own github.com vault key when a backup remote is set; workers keep GITHUB_BASIC', () => {
  const key = (k?: string) =>
    JSON.stringify(ax.egressPolicy('factory', [], undefined, undefined, undefined, k).rules).match(
      /factory\/(GITHUB_BASIC\w*)/,
    )![1]
  expect(key()).toBe('GITHUB_BASIC')
  expect(key(ax.managerGithubKey({ FACTORY_AX_BACKUP_REMOTE: 'https://github.com/acme/h.git' }))).toBe(
    'GITHUB_BASIC_MANAGER',
  )
  expect(ax.managerGithubKey({})).toBe('GITHUB_BASIC')
  const mgr = JSON.stringify(
    ax.egressPolicy('factory', [], undefined, undefined, undefined, 'GITHUB_BASIC_MANAGER').rules,
  )
  expect(mgr).not.toContain('GITHUB_ZS')
  expect(mgr).not.toContain('pathPrefixes')
})

test("a task's phase is read from ax get, and a deleted task has none", () => {
  expect(ax.phase('t')).toBeNull()
  writeFileSync(join(dir, 'get'), 'metadata:\n  name: t\nstatus:\n  phase: Suspended\n  actor: t\n')
  expect(ax.phase('t')).toBe('Suspended')
})

const AS_WORKER = [
  'setpriv',
  '--reuid=worker',
  '--regid=worker',
  '--init-groups',
  'env',
  'HOME=/home/worker',
  'USER=worker',
]

test('poll, prompt and put run as the worker user over ax ssh, the prompt base64 so ax cannot take it for its flags', () => {
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
  expect(ax.put('t', 'brief.md', 0, 1, 'aGVsbG8=')).toEqual({ ok: true })
  expect(logged()).toEqual([
    `-a factory ssh t -- ${AS_WORKER.join(' ')} factory worker poll 4`,
    `-a factory ssh t -- ${AS_WORKER.join(' ')} factory worker prompt ${Buffer.from('-a sneaky').toString('base64')}`,
    `-a factory ssh t -- ${AS_WORKER.join(' ')} factory worker put brief.md 0 1 aGVsbG8=`,
  ])
})

test("ax.prompt keeps its base64 argv under Linux's 131072-byte MAX_ARG_STRLEN: a long mail is clipped by bytes, never split mid-character (claude-factory-kcg.3)", () => {
  writeFileSync(join(dir, 'ssh'), 'ok')
  // a 3-byte UTF-8 character ('€'), repeated: 200_000 of them is 600_000 bytes, well past PROMPT_MAX_BYTES
  const big = '€'.repeat(200_000)
  ax.prompt('t', big)
  const call = logged().at(-1)!
  const arg = call.split(' ').at(-1)!
  expect(arg.length).toBeLessThan(131_072)
  const decoded = Buffer.from(arg, 'base64')
  const text = decoded.toString('utf8')
  // re-encoding what toString('utf8') decoded must round-trip to the same bytes: a split multi-byte
  // character would decode to a U+FFFD replacement char, which re-encodes to different bytes
  expect(Buffer.from(text, 'utf8').equals(decoded)).toBe(true)
  expect(text).not.toContain('�')
  expect(text).toMatch(/\[clipped: \d+ of \d+ bytes\]$/)
})

test('FACTORY_AX_CAPABILITIES empty keeps poll, prompt and put as the bare root command, for a VM where serve stayed root', () => {
  process.env.FACTORY_AX_CAPABILITIES = ''
  try {
    writeFileSync(join(dir, 'ssh'), JSON.stringify({ status: 'idle', lines: [] }))
    ax.poll('t', 0)
    ax.prompt('t', 'hi')
    ax.put('t', 'brief.md', 0, 1, 'aGVsbG8=')
    expect(logged()).toEqual([
      '-a factory ssh t -- factory worker poll 0',
      `-a factory ssh t -- factory worker prompt ${Buffer.from('hi').toString('base64')}`,
      '-a factory ssh t -- factory worker put brief.md 0 1 aGVsbG8=',
    ])
  } finally {
    delete process.env.FACTORY_AX_CAPABILITIES
  }
})

test("a put that fails over ax ssh returns {ok: false} with ax's stderr, instead of a bare boolean", () => {
  const failer = join(dir, 'ax-failput')
  writeFileSync(
    failer,
    `#!/bin/sh
echo "$*" >> ${calls}
echo 'EACCES: permission denied, mkdir /workspace/w/.factory-worker/put' >&2
exit 1
`,
  )
  chmodSync(failer, 0o755)
  const saved = process.env.FACTORY_AX
  process.env.FACTORY_AX = failer
  try {
    expect(ax.put('t', 'brief.md', 0, 1, 'aGVsbG8=')).toEqual({
      ok: false,
      err: 'EACCES: permission denied, mkdir /workspace/w/.factory-worker/put',
    })
  } finally {
    process.env.FACTORY_AX = saved
  }
})

test('the worker briefs once, runs queued prompts in the same session, and queues its reports', async () => {
  const own = join(dir, 'own')
  const repo = join(dir, 'repo')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  // Save env here, before FACTORY_BRIEF is set below. Restore it in finally. This stops FACTORY_OUTBOX,
  // FACTORY_FROM and FACTORY_BRIEF from leaking into later tests' subprocess calls, which inherit
  // process.env (claude-factory-5h9.4, claude-factory-kcg.6).
  const saved = { ...process.env }
  process.env.FACTORY_BRIEF = 'the brief'
  // a fake claude: records its argv and its stdin (the prompt, now passed there instead), prints a
  // stream-json init event
  const claude = join(dir, 'claude')
  writeFileSync(
    claude,
    `#!/bin/sh
echo "$*" >> ${dir}/claude.log
n=$(ls ${dir}/claude.stdin.* 2>/dev/null | wc -l)
cat > ${dir}/claude.stdin.$n
echo '{"type":"system","subtype":"init","session_id":"sess-1"}'
`,
  )
  chmodSync(claude, 0o755)
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
    FACTORY_FROM: 'implement',
  })
  try {
    await worker.serve('m1', { once: true })
    worker.prompt(Buffer.from('[factory mail from manager] yes').toString('base64'))
    expect(worker.poll(0).status).toBe('idle')
    await worker.serve('m1', { once: true }) // a resumed task: no second brief
    const turns = readFileSync(join(dir, 'claude.log'), 'utf8').trim().split('\n')
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEndWith('--model m1') // no prompt text on argv: it goes on stdin
    expect(turns[1]).toEndWith('--model m1 --resume sess-1')
    expect(readFileSync(join(dir, 'claude.stdin.0'), 'utf8')).toBe('the brief')
    expect(readFileSync(join(dir, 'claude.stdin.1'), 'utf8')).toBe('[factory mail from manager] yes')
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
  } finally {
    process.env = saved
  }
})

test("serve starts the devenv's processes and ends the first brief with a [factory] services note (claude-factory-5sn)", async () => {
  const own = join(dir, 'own-svc')
  const repo = join(dir, 'repo-svc')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  // records every arg, null-separated, since the brief now carries embedded newlines (the services note)
  const argsFile = join(dir, 'claude-svc-args')
  const stdinFile = join(dir, 'claude-svc-stdin')
  const claude = join(dir, 'claude-svc')
  writeFileSync(
    claude,
    `#!/bin/sh
for a in "$@"; do printf '%s\\0' "$a" >> ${argsFile}; done
cat > ${stdinFile}
echo '{"type":"system","subtype":"init","session_id":"sess-svc"}'
`,
  )
  chmodSync(claude, 0o755)
  const tasksFile = join(dir, 'tasks-svc.json')
  writeFileSync(
    tasksFile,
    JSON.stringify([
      {
        name: 'devenv:processes:postgres',
        type: 'process',
        command: `exec sleep 5`,
        cwd: null,
        process: { start: { enable: true }, ready: { exec: 'exit 0' } },
      },
    ]),
  )
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_BRIEF: 'the brief',
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
    DEVENV_TASK_FILE: tasksFile,
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    await worker.serve('m1', { once: true })
    const args = readFileSync(argsFile, 'utf8').split('\0').filter(Boolean)
    expect(args.at(-1)).toBe('m1') // the prompt text is not in argv: it goes on stdin
    const prompt = readFileSync(stdinFile, 'utf8')
    expect(prompt).toStartWith('the brief\n\n[factory] services: ready: postgres.')
    expect(prompt).toContain('DATABASE_URL is set.')
    expect(readFileSync(join(own, 'serve.log'), 'utf8')).toContain('services: postgres ready in')
    expect(existsSync(join(own, 'services', 'postgres.log'))).toBe(true)
  } finally {
    process.env = saved
  }
})

test('poll learns the session as soon as the init event streams, not only once a long turn exits (claude-factory-xq3)', async () => {
  const own = join(dir, 'own-midturn')
  const repo = join(dir, 'repo-midturn')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  // prints its init event, then sits for a few seconds (a stand-in for a long agentic turn) before finishing;
  // long enough that the poll loop below has margin against a loaded box's scheduling jitter
  const claude = join(dir, 'claude-midturn')
  writeFileSync(
    claude,
    `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"mid-1"}'
sleep 3
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
echo '{"type":"result","is_error":false,"result":"done"}'
`,
  )
  chmodSync(claude, 0o755)
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_BRIEF: 'the brief',
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    const p = worker.serve('m1', { once: true })
    // poll until the session shows (the init event streamed) or give up after well past the fake's own
    // schedule: a loop, not a single fixed sleep, so a loaded box's scheduling jitter cannot flake this
    let mid = worker.poll(0)
    const deadline = Date.now() + 2500
    while (!mid.session && Date.now() < deadline) {
      await Bun.sleep(50)
      mid = worker.poll(0)
    }
    expect(mid.session).toBe('mid-1') // learned while the turn is still running, not after it exits
    expect(mid.status).toBe('working') // still mid-turn: the fake is still in its 3s sleep
    await p
    expect(worker.poll(0).status).toBe('idle')
  } finally {
    process.env = saved
  }
})

test('poll reports the worker repo head and the live stream size, both moving mid-turn (claude-factory-xq3)', async () => {
  const own = join(dir, 'own-progress')
  const repo = join(dir, 'repo-progress')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  for (const args of [
    ['init', '-q', repo],
    ['-C', repo, 'config', 'user.email', 'a@b.c'],
    ['-C', repo, 'config', 'user.name', 'a'],
  ])
    Bun.spawnSync(['git', ...args])
  writeFileSync(join(repo, 'f'), '1')
  Bun.spawnSync(['git', '-C', repo, 'add', 'f'])
  Bun.spawnSync(['git', '-C', repo, 'commit', '-q', '-m', 'c1'])
  const before = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD']).stdout.toString().trim()
  // prints its init event, commits (a stand-in for the worker's own commits mid-turn) after a short sleep,
  // then another assistant line after a longer one, so two polls taken while it still runs see it move twice
  const claude = join(dir, 'claude-progress')
  writeFileSync(
    claude,
    `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"p1"}'
sleep 0.3
git -C ${repo} commit -q --allow-empty -m c2
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
sleep 2
echo '{"type":"result","is_error":false,"result":"done"}'
`,
  )
  chmodSync(claude, 0o755)
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_BRIEF: 'the brief',
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    const p = worker.serve('m1', { once: true })
    await Bun.sleep(80) // before the fake's 0.3s sleep ends: no commit made yet
    const early = worker.poll(0)
    expect(early.head).toBe(before)
    // poll until the commit shows (head moves) or give up after well past the fake's own schedule: a loop,
    // not a single fixed sleep, so a loaded box's scheduling jitter cannot flake this
    let mid = worker.poll(0)
    const deadline = Date.now() + 5000
    while (mid.head === before && Date.now() < deadline) {
      await Bun.sleep(50)
      mid = worker.poll(0)
    }
    expect(mid.status).toBe('working') // still mid-turn: the fake is still in its 2s sleep
    expect(mid.head).not.toBe('')
    expect(mid.head).not.toBe(early.head) // the commit the fake makes mid-turn shows in head
    expect(mid.bytes ?? 0).toBeGreaterThan(early.bytes ?? 0) // the stream grew between two polls mid-turn
    await p
  } finally {
    process.env = saved
  }
})

test('serve retries a turn that ended on the egress failure, same session, backed off, until one gets through', async () => {
  const own = join(dir, 'own-egress-ok')
  const repo = join(dir, 'repo-egress-ok')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const log = join(dir, 'claude-egress-ok.log')
  const counter = join(dir, 'claude-egress-ok.count')
  const claude = join(dir, 'claude-egress-ok')
  // fails its first 2 calls (an init event, then the egress signature), then an init plus a success;
  // the 2nd call sleeps so the test can poll mid-retry, well after the 1st call already named the
  // session but before turnWithRetry has returned it
  writeFileSync(
    claude,
    `#!/bin/sh
n=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 ))
echo "$n" > ${counter}
echo "$*" >> ${log}
cat > ${log}.stdin.$n
echo '{"type":"system","subtype":"init","session_id":"s1"}'
if [ "$n" -eq 2 ]; then sleep 1; fi
if [ "$n" -le 2 ]; then
  echo '{"type":"result","is_error":true,"result":"API Error: 503 upstream connect error or disconnect/reset before headers: remote connection failure"}'
else
  echo '{"type":"result","is_error":false,"result":"done"}'
fi
`,
  )
  chmodSync(claude, 0o755)
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_BRIEF: 'the brief',
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
    FACTORY_EGRESS_WAIT_MS: '1',
    FACTORY_EGRESS_BUDGET_MS: '5000',
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    const p = worker.serve('m1', { once: true })
    await Bun.sleep(400) // well after the 1st call (fast) names s1, during the 2nd call's 1s sleep
    expect(worker.poll(0).session).toBe('s1') // the retried turn's session, not the stale outer one
    await p
    const turns = readFileSync(log, 'utf8').trim().split('\n')
    expect(turns).toHaveLength(3)
    expect(turns[0]).toEndWith('--model m1')
    expect(turns[1]).toEndWith('--model m1 --resume s1')
    expect(turns[2]).toEndWith('--model m1 --resume s1')
    expect(readFileSync(`${log}.stdin.1`, 'utf8')).toBe('the brief')
    expect(readFileSync(`${log}.stdin.2`, 'utf8')).toBe(worker.EGRESS_RETRY_PROMPT)
    expect(readFileSync(`${log}.stdin.3`, 'utf8')).toBe(worker.EGRESS_RETRY_PROMPT)
    expect(worker.poll(0)).toMatchObject({ status: 'idle', session: 's1' })
    expect(worker.poll(0).egress).toBeUndefined() // the turn that got through cleared it
    const retries = readFileSync(join(own, 'serve.log'), 'utf8').match(/egress failure, retry/g) ?? []
    expect(retries).toHaveLength(2)
  } finally {
    process.env = saved
  }
})

test('serve gives up retrying at its budget, leaving the outage visible to poll, and goes idle', async () => {
  const own = join(dir, 'own-egress-stuck')
  const repo = join(dir, 'repo-egress-stuck')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const log = join(dir, 'claude-egress-stuck.log')
  const claude = join(dir, 'claude-egress-stuck')
  // never gets a session: the egress gateway refuses before Claude even starts a conversation
  writeFileSync(
    claude,
    `#!/bin/sh
echo "$*" >> ${log}
n=$(ls ${log}.stdin.* 2>/dev/null | wc -l)
cat > ${log}.stdin.$n
echo '{"type":"result","is_error":true,"result":"API Error: 503 upstream connect error or disconnect/reset before headers: remote connection failure"}'
`,
  )
  chmodSync(claude, 0o755)
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_BRIEF: 'the brief',
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
    FACTORY_EGRESS_WAIT_MS: '1',
    FACTORY_EGRESS_BUDGET_MS: '50',
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    await worker.serve('m1', { once: true })
    const turns = readFileSync(log, 'utf8').trim().split('\n')
    expect(turns.length).toBeGreaterThan(1) // it tried more than once before giving up
    for (const t of turns) expect(t).toEndWith('--model m1') // no session: reruns the brief every time
    for (let n = 0; n < turns.length; n++) expect(readFileSync(`${log}.stdin.${n}`, 'utf8')).toBe('the brief')
    const polled = worker.poll(0)
    expect(polled.status).toBe('idle')
    expect(polled.session).toBeUndefined()
    expect(polled.egress?.tries).toBeGreaterThanOrEqual(1)
    expect(polled.egress?.last).toContain('upstream connect error')
  } finally {
    process.env = saved
  }
})

test("an outage's budget and since survive a restart and a turn change: a queued prompt gets exactly one more try, then idle", async () => {
  const own = join(dir, 'own-egress-carry')
  const repo = join(dir, 'repo-egress-carry')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const log = join(dir, 'claude-egress-carry.log')
  const claude = join(dir, 'claude-egress-carry')
  // still refuses every call: only the already-spent budget, not this call's own, decides when to give up
  writeFileSync(
    claude,
    `#!/bin/sh
echo "$*" >> ${log}
cat > ${log}.stdin
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"result","is_error":true,"result":"API Error: 503 upstream connect error or disconnect/reset before headers: remote connection failure"}'
`,
  )
  chmodSync(claude, 0o755)
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
    FACTORY_EGRESS_WAIT_MS: '1',
    FACTORY_EGRESS_BUDGET_MS: '5000',
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  // a prior session already past its egress budget, and a queued prompt (the manager's reply) waiting on it
  const since = Date.now() - 6000
  writeFileSync(
    join(own, 'state.json'),
    JSON.stringify({
      status: 'idle',
      session: 's1',
      pid: process.pid,
      egress: { since, tries: 3, last: 'old' },
    }),
  )
  worker.prompt(Buffer.from('a reply').toString('base64'))
  try {
    await worker.serve('m1', { once: true })
    const turns = readFileSync(log, 'utf8').trim().split('\n')
    expect(turns).toHaveLength(1) // the already-spent budget stops it after exactly one more try
    expect(turns[0]).toEndWith('--model m1 --resume s1')
    expect(readFileSync(`${log}.stdin`, 'utf8')).toBe('a reply') // the queued prompt itself, not a retry prompt
    const polled = worker.poll(0)
    expect(polled.status).toBe('idle')
    expect(polled.session).toBe('s1')
    expect(polled.egress?.since).toBe(since) // carried over, not reset to this call's own start
    expect(polled.egress?.tries).toBe(4) // 3 before the restart, plus this one try
  } finally {
    process.env = saved
  }
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

test('a rig with no Dolt remote bootstraps its beads from the git origin through a sync.remote config', () => {
  const own = join(dir, 'own-beads-origin')
  const bd = join(dir, 'bd-boot-origin')
  // like bd 1.3.0: no .beads/config.yaml, no workspace
  writeFileSync(
    bd,
    `#!/bin/sh\n[ -f .beads/config.yaml ] || { printf '%s\\n' 'Error: No active beads workspace found.' >&2; exit 1; }\ncat .beads/config.yaml >> ${join(dir, 'bd-boot-origin.log')}\nmkdir -p .beads/embeddeddolt\n`,
    { mode: 0o755 },
  )
  const saved = { ...process.env }
  delete process.env.FACTORY_BEADS_REMOTE
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_BEADS: '1',
    FACTORY_REPO: gitOrigin('origin-ref', true),
    FACTORY_BD: bd,
  })
  try {
    worker.setupBeads()
    const log = readFileSync(join(dir, 'bd-boot-origin.log'), 'utf8')
    expect(log).toBe(`sync.remote: "git+${process.env.FACTORY_REPO}"\n`)
  } finally {
    process.env = saved
  }
})

test("a failed bd bootstrap shows bd's last error line, not its metrics notice or a URL", () => {
  const own = join(dir, 'own-beads-fail')
  const bd = join(dir, 'bd-boot-fail')
  writeFileSync(
    bd,
    `#!/bin/sh\necho 'Thanks for using bd! Metrics help us improve.' >&2\necho 'Error: Bootstrap failed: clone from remote: dolt clone https://dolt.example.com:50051/x: Error 1105: transport: authentication handshake failed: EOF' >&2\nexit 1\n`,
    { mode: 0o755 },
  )
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_BEADS: '1',
    FACTORY_BEADS_REMOTE: 'https://dolt.example.com:50051/x',
    FACTORY_BD: bd,
  })
  try {
    let msg = ''
    try {
      worker.setupBeads()
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('authentication handshake failed: EOF')
    expect(msg).not.toContain('Thanks for using bd')
    expect(msg).not.toContain('https://')
  } finally {
    process.env = saved
  }
})

test('a rig with no Dolt remote and an origin with no refs/dolt/data gets no store', () => {
  const own = join(dir, 'own-beads-noref')
  const bd = join(dir, 'bd-boot-noref')
  writeFileSync(bd, '#!/bin/sh\nmkdir -p .beads/embeddeddolt\n', { mode: 0o755 })
  const saved = { ...process.env }
  delete process.env.FACTORY_BEADS_REMOTE
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_BEADS: '1',
    FACTORY_REPO: gitOrigin('origin-noref', false),
    FACTORY_BD: bd,
  })
  try {
    expect(() => worker.setupBeads()).toThrow('has no refs/dolt/data')
    expect(existsSync(join(own, 'beads', '.beads', 'embeddeddolt'))).toBe(false)
  } finally {
    process.env = saved
  }
})

/** a local git origin, with refs/dolt/data when `withRef` */
function gitOrigin(name: string, withRef: boolean) {
  const o = join(dir, name)
  mkdirSync(o, { recursive: true })
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-C', o, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  if (withRef) git('update-ref', 'refs/dolt/data', 'HEAD')
  return o
}

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

test('loadDevenv does not run the devenv enterShell (shellHook)', () => {
  const own = join(dir, 'own-devenv2')
  const repo = join(dir, 'repo-devenv2')
  const bin = join(dir, 'devenv-bin2')
  const marker = join(dir, 'enter-shell-ran')
  for (const d of [own, repo, bin]) mkdirSync(d, { recursive: true })
  writeFileSync(join(repo, 'devenv.nix'), '{ }\n')
  writeFileSync(
    join(bin, 'devenv'),
    `#!/bin/sh\necho "export GOROOT=/nix/go2; shellHook='touch ${marker}'; export shellHook"\necho 'eval \${shellHook:-}'\necho 'eval "\${shellHook:-}"'\n`,
    { mode: 0o755 },
  )
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_NIX_CACHE: 'https://cache.example.com:8443/devenv devenv:key=',
    PATH: `${bin}:${process.env.PATH}`,
  })
  try {
    worker.loadDevenv()
    expect(process.env.GOROOT).toBe('/nix/go2')
    expect(existsSync(marker)).toBe(false)
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

test("a turn is the headless command of the rig's agent, resuming by that agent's own session; the prompt never sits on its argv (claude-factory-kcg.1)", () => {
  for (const k of ['FACTORY_CLAUDE', 'FACTORY_CODEX', 'FACTORY_PI']) delete process.env[k] // an earlier test's fakes
  const pi = { piDir: '/o/pi' }
  // codex: no session -> '-- -' ('-' reads the prompt from stdin); the agents all read the prompt from
  // stdin, never argv, since a prompt over Linux's MAX_ARG_STRLEN (131072 bytes) made posix_spawn fail with
  // ENAMETOOLONG (claude-factory-kcg)
  expect(worker.turnArgv('codex', { model: 'o3' })).toEqual([
    ...['codex', ...CODEX_GUARD_FLAGS, 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox'],
    ...['--skip-git-repo-check', '-m', 'o3', '--', '-'],
  ])
  expect(worker.turnArgv('codex', { session: 'th-1' })).toEqual([
    ...[
      'codex',
      ...CODEX_GUARD_FLAGS,
      'exec',
      'resume',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
    ],
    ...['--skip-git-repo-check', '--', 'th-1', '-'],
  ])
  expect(worker.turnArgv('pi', { ...pi, session: 'u-1', provider: 'anthropic', model: 'm' })).toEqual([
    ...['pi', '-p', '--session-dir', '/o/pi', '--session-id', 'u-1'],
    // claude-factory-hg9o: the image's worker rules (no /opt/plugins here, so no --skill)
    ...['--append-system-prompt', expect.stringMatching(/\/src\/worker-system\.md$/)],
    ...['--provider', 'anthropic', '--model', 'm'],
  ])
  expect(worker.turnArgv('claude', { session: 's', claudeFlags: ['--tools', 'Bash'] })).toEqual([
    ...['claude', '-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'],
    ...['--tools', 'Bash', '--resume', 's'],
  ])
  expect(
    worker.sessionIn('codex', '{"type":"thread.started","thread_id":"th-9"}\n{"type":"turn.started"}'),
  ).toBe('th-9')
  expect(worker.sessionIn('codex', '{"type":"turn.started"}')).toBeUndefined()
})

test('a turn with a 200_000-byte prompt runs: the agent gets it byte for byte on stdin, never on argv (claude-factory-kcg.1)', async () => {
  const own = join(dir, 'own-big')
  const repo = join(dir, 'repo-big')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  // Save env here, before any change below. Restore it in finally.
  const saved = { ...process.env }
  const big = 'x'.repeat(200_000)
  // Put the big brief on the real big-brief path: own()/brief.md, read by worker.ts's sentFile().
  // Do not put it in FACTORY_BRIEF. Linux's MAX_ARG_STRLEN (131072 bytes) caps each env string too.
  // A 200 KB FACTORY_BRIEF value fails posix_spawn with E2BIG on Linux CI (claude-factory-kcg.5).
  writeFileSync(join(own, 'brief.md'), big)
  delete process.env.FACTORY_BRIEF
  // records argv (one line) and stdin (the whole prompt) to separate files
  const claude = join(dir, 'claude-big')
  writeFileSync(
    claude,
    `#!/bin/sh
echo "$*" > ${dir}/claude-big.argv
cat > ${dir}/claude-big.stdin
echo '{"type":"system","subtype":"init","session_id":"big-1"}'
`,
  )
  chmodSync(claude, 0o755)
  Object.assign(process.env, {
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_CLAUDE: claude,
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    await worker.serve('m1', { once: true }) // throws (ENAMETOOLONG) pre-fix, on Linux, with the prompt on argv
    const argv = readFileSync(join(dir, 'claude-big.argv'), 'utf8')
    expect(argv.length).toBeLessThan(4096)
    expect(argv).not.toContain('x'.repeat(100))
    expect(readFileSync(join(dir, 'claude-big.stdin'), 'utf8')).toBe(big)
  } finally {
    process.env = saved
  }
})

test('a codex worker briefs once, then resumes the thread its first turn named', async () => {
  const own = join(dir, 'own3')
  const repo = join(dir, 'repo3')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const codex = join(dir, 'codex')
  writeFileSync(
    codex,
    `#!/bin/sh
case "$*" in *'features list') printf 'hooks stable true\\nunified_exec stable false\\nshell_snapshot stable false\\nmulti_agent stable false\\ncode_mode stable false\\n'; exit;; esac
echo "$*" >> ${dir}/codex.log
n=$(ls ${dir}/codex.stdin.* 2>/dev/null | wc -l)
cat > ${dir}/codex.stdin.$n
echo '{"type":"thread.started","thread_id":"th-1"}'
`,
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
    CODEX_HOME: join(own, 'codex'),
    FACTORY_CODEX_HOME_FILES: '{}',
  })
  delete process.env.FACTORY_REPO
  delete process.env.FACTORY_CA
  try {
    await worker.serve('o3', { once: true })
    worker.prompt(Buffer.from('more').toString('base64'))
    await worker.serve('o3', { once: true })
    const turns = readFileSync(join(dir, 'codex.log'), 'utf8').trim().split('\n')
    expect(turns[0]).toEndWith('-m o3 -- -') // no prompt text on argv: '-' reads it from stdin
    expect(turns[1]).toContain(' exec resume --json')
    expect(turns[1]).toEndWith('-m o3 -- th-1 -')
    expect(readFileSync(join(dir, 'codex.stdin.0'), 'utf8')).toBe('codex brief')
    expect(readFileSync(join(dir, 'codex.stdin.1'), 'utf8')).toBe('more')
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
  writeFileSync(
    pi,
    `#!/bin/sh
echo "$*" >> ${dir}/pi.log
n=$(ls ${dir}/pi.stdin.* 2>/dev/null | wc -l)
cat > ${dir}/pi.stdin.$n
`,
  )
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
    // no prompt text on argv: it goes on stdin
    const rules = `--append-system-prompt ${join(import.meta.dir, 'worker-system.md')}`
    expect(first).toBe(`-p --session-dir ${join(own, 'pi')} --session-id ${id} ${rules}`)
    expect(second).toBe(`-p --session-dir ${join(own, 'pi')} --session-id ${id} ${rules}`)
    expect(readFileSync(join(dir, 'pi.stdin.0'), 'utf8')).toBe('pi brief')
    expect(readFileSync(join(dir, 'pi.stdin.1'), 'utf8')).toBe('more')
    // pi -p only prints once a turn exits, so own()/pi.jsonl never grows mid-turn: a constant size would look
    // like a non-committing pi worker is stalled; bytes must stay out of the stall signature entirely for pi
    // (claude-factory-xq3.6)
    expect(worker.poll(0).bytes).toBeUndefined()
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
  expect(ax.egressPolicy('factory', [dolt]).rules[6]).toEqual({
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
  expect(rules).toHaveLength(8)
  expect(rules[6]!.https).toEqual({
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
  expect(rules[7]!.https).toEqual({ hostnames: ['pypi.org', 'files.pythonhosted.org'] }) // no key: no injection
})

test('unset, FACTORY_AX_PKG_GATE leaves egressPolicy byte-identical to today, registry hosts and all', () => {
  const extra = [ax.parseEgress('proxy.golang.org,sum.golang.org'), ax.parseEgress('pypi.org,api.openai.com')]
  expect(ax.egressPolicy('factory', extra, undefined)).toEqual(ax.egressPolicy('factory', extra))
  expect(ax.egressPolicy('factory', extra).rules.slice(6)).toEqual([
    { https: { hostnames: ['proxy.golang.org', 'sum.golang.org'] } },
    { https: { hostnames: ['pypi.org', 'api.openai.com'] } },
  ])
})

test('a set pkg-gate adds its own rule and strips every registry host, dropping an all-registry rule and thinning a mixed one', () => {
  const extra = [ax.parseEgress('proxy.golang.org,sum.golang.org'), ax.parseEgress('pypi.org,api.openai.com')]
  const rules = ax.egressPolicy('factory', extra, 'http://pkg-gate.pkg-gate.svc:8080').rules as {
    https?: { hostnames: string[]; ports?: { numbers: number[] } }
    http?: { hostnames: string[]; ports?: { numbers: number[] } }
  }[]
  for (const r of rules)
    for (const h of r.https?.hostnames ?? r.http?.hostnames ?? []) expect(ax.REGISTRY_HOSTS).not.toContain(h)
  expect(rules).toContainEqual({ http: { hostnames: ['pkg-gate.pkg-gate.svc'], ports: { numbers: [8080] } } })
  // the all-registry rule is gone entirely; the mixed one keeps only its non-registry host
  expect(rules.some(r => r.https?.hostnames.includes('api.openai.com'))).toBe(true)
  expect(rules.some(r => r.https?.hostnames.includes('proxy.golang.org'))).toBe(false)
})

test('isRegistryHost matches case-insensitively and ignores a trailing dot (ei0.16)', () => {
  expect(ax.isRegistryHost('pypi.org')).toBe(true)
  expect(ax.isRegistryHost('PyPI.org')).toBe(true)
  expect(ax.isRegistryHost('PYPI.ORG')).toBe(true)
  expect(ax.isRegistryHost('pypi.org.')).toBe(true) // an absolute FQDN form, trailing dot and all
  expect(ax.isRegistryHost('api.openai.com')).toBe(false)
})

test("--egress PyPI.org (mixed case) is still stripped once a pkg-gate is on, since parseEgress's HOST regex is case-insensitive (ei0.16)", () => {
  const extra = [ax.parseEgress('PyPI.org,api.openai.com')]
  const rules = ax.egressPolicy('factory', extra, 'http://pkg-gate.pkg-gate.svc:8080').rules as {
    https?: { hostnames: string[] }
  }[]
  expect(rules.some(r => r.https?.hostnames.some(h => h.toLowerCase() === 'pypi.org'))).toBe(false)
  expect(rules.some(r => r.https?.hostnames.includes('api.openai.com'))).toBe(true)
})

test("the gate's own rule is https at its default port when the gate URL is https, and omits a default port either way", () => {
  expect(ax.egressPolicy('', [], 'https://pkg-gate.example.com').rules).toContainEqual({
    https: { hostnames: ['pkg-gate.example.com'] },
  })
  expect(ax.egressPolicy('', [], 'https://pkg-gate.example.com:8443').rules).toContainEqual({
    https: { hostnames: ['pkg-gate.example.com'], ports: { numbers: [8443] } },
  })
  expect(ax.egressPolicy('', [], 'http://pkg-gate.pkg-gate.svc').rules).toContainEqual({
    http: { hostnames: ['pkg-gate.pkg-gate.svc'] },
  })
})

test('a launched task carries the registry env only when FACTORY_AX_PKG_GATE is set, http or https', () => {
  const base = { name: 't-gate', repo: 'r', branch: 'b', image: 'i', env: {} }
  ax.launch(base)
  const envOf = () =>
    Object.fromEntries(
      JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!).spec.env.map(
        (e: { name: string; value: string }) => [e.name, e.value],
      ),
    )
  expect(envOf().GOPROXY).toBeUndefined()
  expect(envOf().PIP_INDEX_URL).toBeUndefined()

  process.env.FACTORY_AX_PKG_GATE = 'http://pkg-gate.pkg-gate.svc:8080'
  try {
    ax.launch(base)
    const env = envOf()
    expect(env).toMatchObject({
      GOPROXY: 'http://pkg-gate.pkg-gate.svc:8080/go',
      NPM_CONFIG_REGISTRY: 'http://pkg-gate.pkg-gate.svc:8080/npm/',
      BUN_CONFIG_REGISTRY: 'http://pkg-gate.pkg-gate.svc:8080/npm/',
      YARN_NPM_REGISTRY_SERVER: 'http://pkg-gate.pkg-gate.svc:8080/npm/',
      PIP_INDEX_URL: 'http://pkg-gate.pkg-gate.svc:8080/pypi/simple',
      UV_DEFAULT_INDEX: 'http://pkg-gate.pkg-gate.svc:8080/pypi/simple',
      UV_INDEX_URL: 'http://pkg-gate.pkg-gate.svc:8080/pypi/simple',
      PIP_TRUSTED_HOST: 'pkg-gate.pkg-gate.svc',
      UV_INSECURE_HOST: 'pkg-gate.pkg-gate.svc',
      // yarn berry refuses an http:// registry outright unless its host is on this whitelist (ei0.19)
      YARN_UNSAFE_HTTP_WHITELIST: 'pkg-gate.pkg-gate.svc',
    })
  } finally {
    delete process.env.FACTORY_AX_PKG_GATE
  }

  process.env.FACTORY_AX_PKG_GATE = 'https://pkg-gate.example.com'
  try {
    ax.launch(base)
    const env = envOf()
    expect(env.GOPROXY).toBe('https://pkg-gate.example.com/go')
    expect(env.PIP_TRUSTED_HOST).toBeUndefined() // https needs no trusted-host override
    expect(env.YARN_UNSAFE_HTTP_WHITELIST).toBeUndefined() // https needs no unsafe-http whitelist either
  } finally {
    delete process.env.FACTORY_AX_PKG_GATE
  }
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

test('the ChatGPT egress rule becomes two header injections on chatgpt.com paths, none without a vault', () => {
  const rule = {
    hosts: ['chatgpt.com'],
    pathPrefixes: ['/backend-api/codex/'],
    headers: [
      { header: 'Authorization', prefix: 'Bearer ', key: 'CODEX_CHATGPT' },
      { header: 'ChatGPT-Account-ID', prefix: '', key: 'CODEX_CHATGPT_ACCOUNT' },
    ],
  }
  const find = (vault: string) =>
    (ax.egressPolicy(vault, [rule]).rules as any[]).find(r => r.https.hostnames[0] === 'chatgpt.com').https
  expect(find('v')).toEqual({
    hostnames: ['chatgpt.com'],
    pathPrefixes: ['/backend-api/codex/'],
    effects: {
      replaceHeaders: [
        {
          header: 'Authorization',
          prefix: 'Bearer ',
          credentialUri: 'ate-secret://agent-vault/v/CODEX_CHATGPT',
        },
        {
          header: 'ChatGPT-Account-ID',
          prefix: '',
          credentialUri: 'ate-secret://agent-vault/v/CODEX_CHATGPT_ACCOUNT',
        },
      ],
    },
  })
  expect(find('')).toEqual({ hostnames: ['chatgpt.com'], pathPrefixes: ['/backend-api/codex/'] })
})

test('every egress pathPrefixes entry starts and ends with /', () => {
  const rule = { hosts: ['chatgpt.com'], pathPrefixes: ['/backend-api/codex/'], key: 'K' }
  const all = [...ax.egressPolicy('v', [rule]).rules, ...ax.egressPolicy('v', []).rules] as any[]
  const prefixes = all.flatMap(r => r.https?.pathPrefixes ?? [])
  expect(prefixes.length).toBeGreaterThan(0)
  for (const p of prefixes) expect(p).toMatch(/^\/.*\/$/)
})

test('a ChatGPT-mode codex task has no API-key env, and its inputs hold only placeholders', () => {
  writeFileSync(join(dir, 'actor'), '')
  process.env.FACTORY_AX_VAULT = 'factory'
  try {
    ax.launch({
      name: 't4',
      repo: 'r',
      branch: 'b',
      image: 'i',
      brief: 'x',
      harness: 'codex',
      codexAuth: 'chatgpt',
      codexHome: vmCodexHome({}, [], [], undefined, 'chatgpt'),
      env: {},
    })
    const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
    const env: Record<string, string> = Object.fromEntries(
      task.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]),
    )
    expect(env.FACTORY_HARNESS).toBe('codex')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
    const files = JSON.parse(env.FACTORY_CODEX_HOME_FILES!)
    const auth = JSON.parse(files['auth.json'])
    expect(Object.keys(auth.tokens).sort()).toEqual(['access_token', 'id_token', 'refresh_token'])
    expect(auth.tokens.refresh_token).toBe('placeholder')
    expect(auth.tokens.access_token.split('.')[2]).toBe('placeholder')
    expect(auth.tokens.id_token.split('.')[2]).toBe('placeholder')
    expect(JSON.stringify(task)).not.toMatch(/CODEX_CHATGPT/)
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

test("egressFailure finds the egress gateway's known signature in a Claude result and ignores other refusals", () => {
  const resultLine = (is_error: boolean, result: string) =>
    JSON.stringify({ type: 'result', is_error, result })
  const egressText =
    'API Error: 503 upstream connect error or disconnect/reset before headers. reset reason: remote connection failure, transport failure reason: TLS_error: ' +
    'X'.repeat(400) +
    ' CERTIFICATE_VERIFY_FAILED'
  const out = ['{"type":"system","subtype":"init","session_id":"s1"}', resultLine(true, egressText)].join(
    '\n',
  )
  const hit = worker.egressFailure('claude', out, '')
  expect(hit).not.toBeNull()
  expect(hit!.length).toBeLessThanOrEqual(300)
  expect(hit).toStartWith('API Error: 503 upstream connect error')

  const success = [
    '{"type":"system","subtype":"init","session_id":"s1"}',
    resultLine(false, 'all done'),
  ].join('\n')
  expect(worker.egressFailure('claude', success, '')).toBeNull()

  const rateLimited = resultLine(true, 'rate_limit_error: Number of request tokens has exceeded your limit')
  expect(worker.egressFailure('claude', rateLimited, '')).toBeNull()

  const overloaded = resultLine(
    true,
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  )
  expect(worker.egressFailure('claude', overloaded, '')).toBeNull()

  const otherError = resultLine(true, 'API Error: 400 invalid_request_error: bad input')
  expect(worker.egressFailure('claude', otherError, '')).toBeNull()
})

test('egressFailure for codex and pi scans the last 4000 chars of stdout+stderr', () => {
  const tail = `connecting...\n${'x'.repeat(4100)}upstream connect error or disconnect/reset before headers: remote connection failure`
  const hit = worker.egressFailure('codex', tail, '')
  expect(hit).not.toBeNull()
  expect(hit!.length).toBeLessThanOrEqual(300)
  expect(worker.egressFailure('pi', 'a clean run', 'no trouble here')).toBeNull()
  // the signature outside the last 4000 chars of out+err never matches
  const farAway = `upstream connect error or disconnect/reset before headers\n${'y'.repeat(5000)}`
  expect(worker.egressFailure('codex', farAway, '')).toBeNull()
  // the signature followed by more than 300 chars of other output: the match itself comes back,
  // not whatever the 4000-char window happens to end on
  const farAfter = `upstream connect error or disconnect/reset before headers: boom\n${'z'.repeat(400)}`
  expect(worker.egressFailure('codex', farAfter, '')).toContain('upstream connect error')
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

test.skipIf(!Bun.which('bd'))(
  "syncBeads recovers a real bd merge conflict in dependencies: the VM's own type on the shared row wins",
  () => {
    const bd = Bun.which('bd')!
    const t = mkdtempSync(join(tmpdir(), 'bd-sync-'))
    const remote = join(t, 'remote')
    const a = join(t, 'a')
    const b = join(t, 'b')
    for (const d of [remote, a, b]) mkdirSync(d, { recursive: true })
    const bdEnv = { ...process.env, BEADS_DOLT_SHARED_SERVER: '0', BD_NON_INTERACTIVE: '1' }
    const sh = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(args, { cwd, env: bdEnv })
      if (p.exitCode !== 0) throw new Error(`${args.join(' ')}: ${p.stderr.toString()}`)
      return p.stdout.toString()
    }

    // store a: the first embedded store, with the shared file:// remote and two issues linked by a dep
    sh(a, 'git', 'init', '-q', '.')
    sh(a, bd, 'init', '-p', 'x', '--non-interactive')
    sh(a, bd, 'dolt', 'remote', 'add', 'origin', `file://${remote}`)
    sh(a, bd, 'create', '--id', 'x-1', '--title', 't1', '-d', 'd', '-t', 'task', '-p', '2')
    sh(a, bd, 'create', '--id', 'x-2', '--title', 't2', '-d', 'd', '-t', 'task', '-p', '2')
    sh(a, bd, 'dep', 'add', 'x-2', 'x-1', '-t', 'related')
    sh(a, bd, 'dolt', 'push')

    // store b: a clone of the same remote, as the VM's beads directory is (setupBeads, src/worker.ts:94)
    sh(b, 'git', 'init', '-q', '.')
    mkdirSync(join(b, '.beads'), { recursive: true })
    writeFileSync(join(b, '.beads', 'config.yaml'), `sync.remote: "file://${remote}"\n`)
    sh(b, bd, 'bootstrap', '-y')

    // a changes the dep's type and pushes; b changes the same dep's type, unaware of a's push
    sh(a, bd, 'dep', 'remove', 'x-2', 'x-1')
    sh(a, bd, 'dep', 'add', 'x-2', 'x-1', '-t', 'discovered-from')
    sh(a, bd, 'dolt', 'push')
    sh(b, bd, 'dep', 'remove', 'x-2', 'x-1')
    sh(b, bd, 'dep', 'add', 'x-2', 'x-1', '-t', 'blocks')

    // b's next plain pull would hit the same conflict giv6 saw; syncBeads must get past it and push
    const was = {
      BEADS_DIR: process.env.BEADS_DIR,
      FACTORY_BD: process.env.FACTORY_BD,
      BEADS_DOLT_SHARED_SERVER: process.env.BEADS_DOLT_SHARED_SERVER,
      BD_NON_INTERACTIVE: process.env.BD_NON_INTERACTIVE,
    }
    Object.assign(process.env, {
      BEADS_DIR: join(b, '.beads'),
      FACTORY_BD: bd,
      BEADS_DOLT_SHARED_SERVER: '0',
      BD_NON_INTERACTIVE: '1',
    })
    let sync: worker.SyncResult
    try {
      sync = worker.syncBeads()
    } finally {
      for (const [k, v] of Object.entries(was)) {
        if (v === undefined) delete (process.env as Record<string, string | undefined>)[k]
        else process.env[k] = v
      }
    }
    expect(sync.ok).toBe(true)

    // the remote now holds store b's type: a's next pull sees it, not its own discovered-from
    sh(a, bd, 'dolt', 'pull')
    const dep = sh(a, bd, 'dep', 'list', 'x-2')
    rmSync(t, { recursive: true, force: true })
    expect(dep).toContain('via blocks')
  },
  30000,
)

const envOf = () => {
  const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
  return Object.fromEntries(task.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]))
}

test('a GitLab rig adds one rule for its host: PRIVATE-TOKEN from GITLAB, Basic from GITLAB_BASIC', () => {
  const uri = (key: string) => `ate-secret://agent-vault/factory/${key}`
  expect(ax.egressPolicy('', [], undefined, 'gitlab.example.com').rules).toContainEqual({
    https: { hostnames: ['gitlab.example.com'] },
  })
  const rules = ax.egressPolicy('factory', [], undefined, 'gitlab.example.com').rules
  expect(rules).toContainEqual({
    https: {
      hostnames: ['gitlab.example.com'],
      effects: {
        replaceHeaders: [
          { header: 'PRIVATE-TOKEN', prefix: '', credentialUri: uri('GITLAB') },
          { header: 'Authorization', prefix: 'Basic ', credentialUri: uri('GITLAB_BASIC') },
        ],
      },
    },
  })
  // a GitHub rig's policy is the same as before
  expect(ax.egressPolicy('factory', [], undefined, undefined)).toEqual(ax.egressPolicy('factory'))
  expect(ax.egressPolicy('factory').rules.length).toBe(rules.length - 1)
})

test('a GitLab rig gets placeholders and a second extraHeader; a GitHub rig keeps its one', () => {
  writeFileSync(join(dir, 'actor'), '')
  process.env.FACTORY_AX_VAULT = 'factory'
  try {
    const base = { repo: 'r', branch: 'b', image: 'i', brief: 'x', env: {} }
    ax.launch({ ...base, name: 't4', gitlabHost: 'gitlab.example.com' })
    expect(envOf()).toMatchObject({
      GH_TOKEN: 'placeholder',
      GITLAB_TOKEN: 'placeholder',
      GITLAB_HOST: 'gitlab.example.com',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_KEY_1: 'http.https://gitlab.example.com/.extraHeader',
      GIT_CONFIG_VALUE_1: 'Authorization: Basic placeholder',
    })
    ax.launch({ ...base, name: 't5' })
    const env = envOf()
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(Object.keys(env).filter(k => /GITLAB|KEY_1/.test(k))).toEqual([])
  } finally {
    delete process.env.FACTORY_AX_VAULT
  }
})

test('the manager lease refuses only a live manager task, and never inside it', () => {
  const t = 'f-manager'
  for (const p of ['Running', 'Pending', 'Suspended'])
    expect(ax.managerRefusal(p, {}, t)).toMatch(/f-manager.*factory attach.*factory say <text>/)
  for (const p of ['Failed', 'Terminating', null]) expect(ax.managerRefusal(p, {}, t)).toBeUndefined()
  expect(ax.managerRefusal('Running', { FACTORY_IN_AX: '1' }, t)).toBeUndefined()
})

test('remoteManager skips AX with no cluster and refuses a running manager', () => {
  const saved = { ...process.env }
  try {
    delete process.env.FACTORY_IN_AX
    delete process.env.FACTORY_AX_CONTEXT
    expect(ax.remoteManager()).toBeUndefined()
    process.env.FACTORY_AX_CONTEXT = 'c'
    // the fake ax reads its subcommand at $3: drop the --context pair
    const noctx = join(dir, 'ax-noctx')
    writeFileSync(noctx, `#!/bin/sh\nshift 2\nexec ${fake} \"$@\"\n`)
    chmodSync(noctx, 0o755)
    process.env.FACTORY_AX = noctx
    writeFileSync(join(dir, 'get'), 'status:\n  phase: Running\n')
    expect(ax.remoteManager()).toMatch(/factory attach/)
    rmSync(join(dir, 'get'))
    expect(ax.remoteManager()).toBeUndefined() // not found: no manager task
  } finally {
    process.env = saved
  }
})

test('attach reads the manager pane and say sends its text base64, so ax flags in it survive', () => {
  writeFileSync(join(dir, 'ssh'), 'pane text')
  expect(ax.attachRead()).toBe('pane text')
  expect(logged()[0]).toMatch(/ssh f-manager -- .*herdr pane read w1:p1 --lines 60/)
  const text = 'do it --context x -a evil "$(id)" \'q\''
  ax.say(text)
  const line = logged()[1]!
  expect(line).not.toContain('--context x')
  expect(line).toContain(Buffer.from(text).toString('base64'))
})

test('launchManager applies the manager task with its command and env, then retries the policy until the actor shows', async () => {
  const saved = { ...process.env }
  try {
    Object.assign(process.env, {
      FACTORY_MAX_RUNS: '16',
      FACTORY_AX_VAULT: 'v1',
      FACTORY_AX_MANAGER_AX_SERVER: 'http://ax.example.svc:8080',
      FACTORY_AX_MANAGER_ROUTER: 'http://router.example.svc',
      FACTORY_AX_MANAGER_BROKER: 'http://broker.example.svc:8080',
    })
    delete process.env.FACTORY_AX_IMAGE
    const r = await ax.launchManager('mgr@sha256:abc', ['--model', 'opus'], [], { waitMs: 0 })
    expect(r).toEqual({ name: 'f-manager', policy: true })
    const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
    expect(task.metadata).toEqual({ name: 'f-manager', atespace: 'factory' })
    expect(task.spec.image).toBe('mgr@sha256:abc')
    expect(task.spec.debug).toBe(true)
    expect(task.spec.command).toEqual(['factory', 'manager', 'host', '--model', 'opus'])
    const env = Object.fromEntries(
      task.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]),
    )
    expect(env).toMatchObject({
      FACTORY_IN_AX: '1',
      FACTORY_HOME: '/workspace/w/home',
      FACTORY_CA: 'CA-PEM',
      FACTORY_MAX_RUNS: '16',
      FACTORY_AX_VAULT: 'v1',
      CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      GH_TOKEN: 'placeholder',
    })
    expect(env.FACTORY_AX_IMAGE).toBeUndefined()
    expect(env.FACTORY_REPO).toBeUndefined()
    expect(env.FACTORY_OUTBOX).toBeUndefined()
    expect(env.AX_SERVER).toBe('http://ax.example.svc:8080')
    expect(env.FACTORY_POLICY_BROKER).toBe('http://broker.example.svc:8080')
    expect(env.AX_ROUTER).toBe('router.example.svc:80')
    const rules = JSON.parse(readFileSync(join(dir, 'policy'), 'utf8')).rules
    expect(
      rules.some((x: { https?: { hostnames: string[] } }) => x.https?.hostnames.includes('claude.ai')),
    ).toBe(true)
    expect(rules.slice(-3)).toEqual([
      { http: { hostnames: ['ax.example.svc'], ports: { numbers: [8080] } } },
      { http: { hostnames: ['router.example.svc'], ports: { numbers: [80] } } },
      { http: { hostnames: ['broker.example.svc'], ports: { numbers: [8080] } } },
    ])
    expect(logged().filter(l => l.includes('create egress-policy f-manager')).length).toBe(2) // refused once, then in
  } finally {
    process.env = saved
  }
})

test('managerEnv sets the token swap to a broker POST only when the broker is set', () => {
  expect(ax.managerEnv({}).FACTORY_AX_TOKEN_SWAP).toBeUndefined()
  expect(
    ax.managerEnv({ FACTORY_AX_MANAGER_BROKER: 'http://broker.example.svc:8080/' }).FACTORY_AX_TOKEN_SWAP,
  ).toBe('curl -sSf -m 25 -X POST http://broker.example.svc:8080/token/best')
})

test('managerEgress adds an http rule for each in-cluster address that is a URL', () => {
  expect(ax.managerEgress({})).toEqual([{ hosts: ['claude.ai'] }])
  expect(ax.managerEgress({ FACTORY_AX_MANAGER_AX_SERVER: 'not a url' })).toEqual([{ hosts: ['claude.ai'] }])
  expect(ax.managerEgress({ FACTORY_AX_MANAGER_ROUTER: 'http://r.example.svc' })).toEqual([
    { hosts: ['claude.ai'] },
    { hosts: ['r.example.svc'], port: 80, http: true },
  ])
})

// a fake curl: records the call and the body, answers by path
const curl = join(dir, 'curl')
writeFileSync(
  curl,
  `#!/bin/sh
printf 'curl %s\\n' "$*" >> ${calls}
case "$*" in
  *PUT*) cat > ${dir}/policy; printf 'created\\n201' ;;
  */ca*) printf 'CA-FROM-BROKER\\n200' ;;
  */controller*) cat ${dir}/bctl ;;
  *) printf 'no\\n502' ;;
esac
`,
)
chmodSync(curl, 0o755)

test('with FACTORY_POLICY_BROKER set, unavailable() asks the broker and does not run kubectl', () => {
  const ready = {
    metadata: { generation: 3 },
    spec: { replicas: 1 },
    status: { observedGeneration: 3, readyReplicas: 1, availableReplicas: 1 },
  }
  const saved = [process.env.FACTORY_POLICY_BROKER, process.env.FACTORY_CURL]
  process.env.FACTORY_POLICY_BROKER = 'http://broker.example.svc:8080'
  process.env.FACTORY_CURL = curl
  try {
    writeFileSync(join(dir, 'bctl'), JSON.stringify(ready) + '\n200')
    expect(ax.unavailable()).toBeUndefined()
    expect(logged().some(l => l.startsWith('kubectl'))).toBe(false)
    expect(logged().at(-1)).toContain('http://broker.example.svc:8080/controller')
    const notReady = { ...ready, status: { ...ready.status, readyReplicas: 0 } }
    writeFileSync(join(dir, 'bctl'), JSON.stringify(notReady) + '\n200')
    expect(ax.unavailable()).toContain('is not ready at its current generation')
    writeFileSync(join(dir, 'bctl'), 'controller: boom\n502')
    expect(ax.unavailable()).toContain('could not be observed')
  } finally {
    if (saved[0] === undefined) delete process.env.FACTORY_POLICY_BROKER
    else process.env.FACTORY_POLICY_BROKER = saved[0]
    if (saved[1] === undefined) delete process.env.FACTORY_CURL
    else process.env.FACTORY_CURL = saved[1]
  }
})

test('with FACTORY_POLICY_BROKER set, the policy and the CA go to the broker and kubectl is not run', () => {
  process.env.FACTORY_CURL = curl
  process.env.FACTORY_POLICY_BROKER = 'http://broker.example.svc:8080/'
  try {
    expect(ax.egressCA()).toBe('CA-FROM-BROKER')
    expect(ax.createPolicy('f-r1-1')).toBe(true)
    expect(logged()).toEqual([
      'curl -sS -m 30 -X GET -w \\n%{http_code} http://broker.example.svc:8080/ca',
      'curl -sS -m 30 -X PUT --data-binary @- -w \\n%{http_code} http://broker.example.svc:8080/policy/factory/f-r1-1',
    ])
    expect(JSON.parse(readFileSync(join(dir, 'policy'), 'utf8'))).toEqual(ax.egressPolicy())
    process.env.FACTORY_CURL = 'false'
    expect(ax.createPolicy('f-r1-1')).toBe(false)
    expect(() => ax.egressCA()).toThrow('the egress gateway')
  } finally {
    delete process.env.FACTORY_CURL
    delete process.env.FACTORY_POLICY_BROKER
  }
})

test('routerAddress gives host:port of the router URL, port 80 by default, and nothing for a non-URL', () => {
  expect(ax.routerAddress('http://r.example.svc')).toBe('r.example.svc:80')
  expect(ax.routerAddress('http://r.example.svc:8081')).toBe('r.example.svc:8081')
  expect(ax.routerAddress('r.example.svc:80')).toBeUndefined()
  expect(ax.routerAddress(undefined)).toBeUndefined()
})

test('managerEgress adds one Dolt rule for each beadsRemote host:port, and none without one', () => {
  const rig = (name: string, url?: string, egress?: ax.Egress[]) => ({
    name,
    ...(url && { beadsRemote: { name: 'origin', url, user: 'u' } }),
    ...(egress && { egress }),
  })
  const rigs = [
    rig('a', 'https://beads-dolt.beads.svc.cluster.local:50051/acme/widget'),
    rig('b', 'https://beads-dolt.beads.svc.cluster.local:50051/acme/other'),
    rig('c', 'https://dolt.example.com/acme/x'),
    rig('d'),
    rig('e', 'not a url'),
    rig('f', 'http://plain.example.com:50051/x'),
  ]
  const dolt = (hosts: string[], port: number) => ({
    hosts,
    key: 'DOLT_BASIC',
    header: 'Authorization',
    prefix: 'Basic ',
    port,
  })
  expect(ax.managerEgress({}, rigs)).toEqual([
    { hosts: ['claude.ai'] },
    dolt(['beads-dolt.beads.svc.cluster.local'], 50051),
    dolt(['dolt.example.com'], 443),
  ])
  const own = rig('g', 'https://own.example.com:8443/x', [
    { hosts: ['own.example.com'], port: 8443, key: 'ACME_DOLT', header: 'X-Auth', prefix: 'T ' },
  ])
  expect(ax.managerEgress({}, [own])[1]).toEqual({
    hosts: ['own.example.com'],
    key: 'ACME_DOLT',
    header: 'X-Auth',
    prefix: 'T ',
    port: 8443,
  })
  expect(ax.managerEgress({}, [rig('d')])).toEqual([{ hosts: ['claude.ai'] }])
})

test('managerEgress adds the Linear rule only for a rig with --linear', () => {
  const linear = { linear: { team: 't' } }
  expect(ax.managerEgress({}, [{}])).toEqual([{ hosts: ['claude.ai'] }])
  expect(ax.managerEgress({}, [linear])).toEqual([
    { hosts: ['claude.ai'] },
    { hosts: ['api.linear.app'], key: 'LINEAR', header: 'Authorization', prefix: '' },
  ])
})

test('serve writes a codex worker home and fails closed when the guard is off (claude-factory-72dq)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vm-codex-'))
  const repo = join(tmp, 'repo')
  const home = join(tmp, 'codex')
  const features = join(tmp, 'features.txt')
  const on =
    'hooks stable true\nunified_exec stable false\nshell_snapshot stable false\nmulti_agent stable false\ncode_mode stable false\n'
  writeFileSync(features, on)
  const fake = join(tmp, 'fake-codex')
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(tmp, 'argv')}'\ncat '${features}'\n`, {
    mode: 0o755,
  })
  mkdirSync(repo)
  const keep = { ...process.env }
  Object.assign(process.env, {
    FACTORY_WORKER_REPO: repo,
    FACTORY_HARNESS: 'codex',
    FACTORY_CODEX: fake,
    FACTORY_CODEX_HOME_FILES: JSON.stringify({ 'hooks.json': '{"hooks":{}}', '../config.toml': 'x = 1\n' }),
  })
  try {
    worker.codexHome(home)
    expect(readdirSync(home).sort()).toEqual(['AGENTS.md', 'config.toml', 'hooks.json'])
    expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe('{"hooks":{}}')
    expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toContain(
      readFileSync(join(import.meta.dir, 'worker-codex.md'), 'utf8'),
    )
    expect(readFileSync(join(tmp, 'argv'), 'utf8').trim().split('\n')).toEqual([
      ...CODEX_GUARD_FLAGS,
      'features',
      'list',
    ])
    writeFileSync(features, on.replace('hooks stable true', 'hooks stable false'))
    expect(() => worker.codexHome(home)).toThrow('hooks is not on')
    writeFileSync(features, on.replace('multi_agent stable false', 'multi_agent stable true'))
    expect(() => worker.codexHome(home)).toThrow('multi_agent')
    writeFileSync(features, on.replace('unified_exec stable false', 'unified_exec stable true'))
    expect(() => worker.codexHome(home)).toThrow('/etc/codex/requirements.toml with [features]')
    writeFileSync(features, on.replace('unified_exec stable false\n', ''))
    expect(() => worker.codexHome(home)).toThrow('claude-factory-fzm3')
    writeFileSync(features, on)
    mkdirSync(join(repo, '.codex'))
    expect(() => worker.codexHome(home)).toThrow('would add project config')
    rmSync(join(repo, '.codex'), { recursive: true })
    // claude-factory-8cu6: the .codex that bd init writes is allowed in the VM too
    cpSync(join(import.meta.dir, 'fixtures', 'bd-codex'), join(repo, '.codex'), { recursive: true })
    expect(() => worker.codexHome(home)).not.toThrow()
    rmSync(join(repo, '.codex'), { recursive: true })
    delete process.env.FACTORY_CODEX_HOME_FILES
    expect(() => worker.codexHome(home)).toThrow('FACTORY_CODEX_HOME_FILES')
    process.env.FACTORY_HARNESS = 'claude'
    expect(() => worker.codexHome(join(tmp, 'none'))).not.toThrow()
    expect(existsSync(join(tmp, 'none'))).toBe(false)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
    Object.assign(process.env, keep)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a session cut off mid-turn resumes with a note naming the cut-off call; an idle one does not (claude-factory-p0yt)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vm-resume-'))
  const own = join(tmp, 'own')
  const repo = join(tmp, 'repo')
  const conf = join(tmp, 'claude')
  mkdirSync(own, { recursive: true })
  mkdirSync(repo, { recursive: true })
  const projects = join(conf, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projects, { recursive: true })
  const use = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push origin HEAD' } }
  writeFileSync(
    join(projects, 's-1.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [use] } }) + '\n',
  )
  const claude = join(tmp, 'claude-bin')
  writeFileSync(
    claude,
    `#!/bin/sh\nn=$(ls ${tmp}/stdin.* 2>/dev/null | wc -l)\ncat > ${tmp}/stdin.$n\necho '{"session_id":"s-1"}'\n`,
    { mode: 0o755 },
  )
  const saved = { ...process.env }
  Object.assign(process.env, {
    FACTORY_HARNESS: 'claude',
    FACTORY_CLAUDE: claude,
    FACTORY_WORKER_DIR: own,
    FACTORY_WORKER_REPO: repo,
    FACTORY_OUTBOX: join(own, 'outbox.jsonl'),
    CLAUDE_CONFIG_DIR: conf,
  })
  for (const k of ['FACTORY_REPO', 'FACTORY_CA', 'FACTORY_BRIEF', 'FACTORY_CLAUDE_FLAGS'])
    delete process.env[k]
  try {
    writeFileSync(join(own, 'state.json'), JSON.stringify({ status: 'working', session: 's-1', pid: 1 }))
    await worker.serve(undefined, { once: true })
    const note = readFileSync(join(tmp, 'stdin.0'), 'utf8')
    expect(note).toStartWith('[factory] Your VM restarted')
    expect(note).toContain('`git push origin HEAD`')
    expect(note).toContain('may have taken effect')
    // idle when it stopped: nothing was cut off, so no note
    await worker.serve(undefined, { once: true })
    expect(existsSync(join(tmp, 'stdin.1'))).toBe(false)
  } finally {
    process.env = saved
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("withDoltEgress adds the Dolt rule of the rig's own https beadsRemote, and nothing else", () => {
  const rule = {
    hosts: ['beads-dolt.example'],
    key: 'DOLT_BASIC',
    header: 'Authorization',
    prefix: 'Basic ',
    port: 50051,
  }
  const remote = { url: 'https://beads-dolt.example:50051/db' }
  const other = [{ hosts: ['github.com'], key: 'GITHUB_BASIC' }]
  expect(ax.withDoltEgress(other, { beadsRemote: remote, egress: other })).toEqual([...other, rule])
  expect(ax.withDoltEgress(undefined, { beadsRemote: remote })).toEqual([rule])
  expect(ax.withDoltEgress(other, { egress: other })).toEqual(other)
  expect(ax.withDoltEgress(other, undefined)).toEqual(other)
  expect(ax.withDoltEgress(other, { beadsRemote: { url: 'http://beads-dolt.example:50051/db' } })).toEqual(
    other,
  )
  expect(ax.withDoltEgress(other, { beadsRemote: { url: 'not a url' } })).toEqual(other)
  const own = [{ hosts: ['beads-dolt.example'], key: 'MY_DOLT', port: 50051 }]
  expect(ax.withDoltEgress(own, { beadsRemote: remote, egress: own })).toEqual(own)
})

test('managerEnv gives an https AX server a placeholder token, and an http one or no vault none', () => {
  const https = 'https://ax.example.svc:8443'
  expect(ax.managerEnv({ FACTORY_AX_MANAGER_AX_SERVER: https, FACTORY_AX_VAULT: 'v1' })).toMatchObject({
    AX_SERVER: https,
    AX_AUTH_TOKEN: 'placeholder',
  })
  for (const env of [
    { FACTORY_AX_MANAGER_AX_SERVER: 'http://ax.example.svc:8080', FACTORY_AX_VAULT: 'v1' },
    { FACTORY_AX_MANAGER_AX_SERVER: https },
    {},
  ])
    expect('AX_AUTH_TOKEN' in ax.managerEnv(env)).toBe(false)
})

test('managerEgress gives an https AX server a keyed rule and no http rule', () => {
  expect(ax.managerEgress({ FACTORY_AX_MANAGER_AX_SERVER: 'https://ax.example.svc:8443' })).toEqual([
    { hosts: ['claude.ai'] },
    { hosts: ['ax.example.svc'], port: 8443, key: 'AX_AUTH', header: 'Authorization', prefix: 'Bearer ' },
  ])
  expect(ax.managerEgress({ FACTORY_AX_MANAGER_AX_SERVER: 'https://ax.example.svc' })[1]).toMatchObject({
    port: 443,
    key: 'AX_AUTH',
  })
  expect(ax.managerEgress({ FACTORY_AX_MANAGER_AX_SERVER: 'http://ax.example.svc:8080' })[1]).toEqual({
    hosts: ['ax.example.svc'],
    port: 8080,
    http: true,
  })
})

test('launchManager with an https AX server injects AX_AUTH and sets a placeholder token', async () => {
  const saved = { ...process.env }
  try {
    Object.assign(process.env, {
      FACTORY_AX_VAULT: 'v1',
      FACTORY_AX_MANAGER_AX_SERVER: 'https://ax.example.svc:8443',
    })
    delete process.env.FACTORY_AX_MANAGER_BROKER
    delete process.env.FACTORY_POLICY_BROKER
    await ax.launchManager('mgr@sha256:abc', [], [], { waitMs: 0 })
    const task = JSON.parse(readFileSync(join(dir, 'applied'), 'utf8').split('\n---\n')[1]!)
    const env = Object.fromEntries(
      task.spec.env.map((e: { name: string; value: string }) => [e.name, e.value]),
    )
    expect(env.AX_AUTH_TOKEN).toBe('placeholder')
    expect(env.AX_SERVER).toBe('https://ax.example.svc:8443')
    const rules = JSON.parse(readFileSync(join(dir, 'policy'), 'utf8')).rules
    expect(rules.at(-1)).toEqual({
      https: {
        hostnames: ['ax.example.svc'],
        ports: { numbers: [8443] },
        effects: {
          replaceHeaders: [
            {
              header: 'Authorization',
              prefix: 'Bearer ',
              credentialUri: 'ate-secret://agent-vault/v1/AX_AUTH',
            },
          ],
        },
      },
    })
  } finally {
    process.env = saved
  }
})

test('createPolicy refuses a manager-only vault key in a policy for any task but the manager', () => {
  const saved = { ...process.env }
  try {
    process.env.FACTORY_AX_VAULT = 'v1'
    delete process.env.FACTORY_POLICY_BROKER
    writeFileSync(join(dir, 'actor'), '')
    const rule = (key: string) => [{ hosts: ['h.example.svc'], key }]
    const refused: [string, () => unknown][] = [
      ['AX_AUTH', () => ax.createPolicy('w1', rule('AX_AUTH'))],
      [
        'AX_AUTH',
        () =>
          ax.createPolicy('w1', [
            { hosts: ['h.example.svc'], headers: [{ header: 'X', prefix: '', key: 'AX_AUTH' }] },
          ]),
      ],
      ['GITHUB_BASIC_MANAGER', () => ax.createPolicy('w1', [], undefined, undefined, 'GITHUB_BASIC_MANAGER')],
    ]
    for (const [key, run] of refused) {
      rmSync(calls, { force: true })
      expect(run).toThrow(key)
      expect(existsSync(calls)).toBe(false)
    }
    process.env.FACTORY_POLICY_BROKER = 'http://broker.example.svc:8080'
    expect(() => ax.createPolicy('w1', rule('AX_AUTH'))).toThrow('AX_AUTH')
    expect(existsSync(calls)).toBe(false)
    delete process.env.FACTORY_POLICY_BROKER
    expect(ax.createPolicy(ax.managerTask(), rule('AX_AUTH'))).toBe(true)
    for (const key of ['ANTHROPIC', 'GITHUB_BASIC', 'DOLT_BASIC', 'KUBE_READ', 'AX_AUTH_X', 'MY_AX_AUTH'])
      expect(ax.createPolicy('w2', rule(key))).toBe(true)
  } finally {
    process.env = saved
  }
})

test('the host ax call inherits AX_AUTH_TOKEN, and the fake records only whether it is set', () => {
  const saved = process.env.AX_AUTH_TOKEN
  try {
    process.env.AX_AUTH_TOKEN = 'e2e-fake'
    ax.phase('t1')
    expect(readFileSync(join(dir, 'auth'), 'utf8')).toBe('set\n')
    rmSync(join(dir, 'auth'), { force: true })
    delete process.env.AX_AUTH_TOKEN
    ax.phase('t1')
    expect(readFileSync(join(dir, 'auth'), 'utf8')).toBe('\n')
  } finally {
    if (saved === undefined) delete process.env.AX_AUTH_TOKEN
    else process.env.AX_AUTH_TOKEN = saved
  }
})

const failedTask = (cond: string) => `status:\n  phase: Failed\n  conditions:\n${cond}`
test('failureOf reads the first False condition of an ax task as "reason: message"', () => {
  const msg = 'resuming actor a/b: while running runsc restore: exit status 128'
  expect(
    ax.failureOf(
      failedTask(
        `  - type: Ready\n    status: "False"\n    reason: ActorResumeFailed\n    message: "${msg}"\n`,
      ),
    ),
  ).toBe(`ActorResumeFailed: ${msg}`)
  // a False condition with no message: the reason alone
  expect(ax.failureOf(failedTask('  - type: Ready\n    status: "False"\n    reason: Boom\n'))).toBe('Boom')
  // the first False one, after a True one
  expect(
    ax.failureOf(
      failedTask(
        '  - type: A\n    status: "True"\n    reason: Fine\n  - type: Ready\n    status: "False"\n    reason: Bad\n    message: m\n',
      ),
    ),
  ).toBe('Bad: m')
})
test('failureOf is undefined for a healthy task, no conditions or YAML that does not parse, and never throws', () => {
  expect(ax.failureOf(failedTask('  - type: Ready\n    status: "True"\n    reason: Ok\n'))).toBeUndefined()
  expect(ax.failureOf('status:\n  phase: Running\n')).toBeUndefined()
  expect(ax.failureOf('a: [unclosed\n  - : :\n\t}{')).toBeUndefined()
  expect(ax.failureOf('')).toBeUndefined()
})
