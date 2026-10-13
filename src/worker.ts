// Inside an AX task's microVM: `factory worker serve` is the task's command. It runs the station's
// agent (Claude, codex or pi) headless on the brief, then each prompt the laptop queues (a nudge, a mail, the time warning)
// as another turn of the same session. The factory commands a worker runs only append to the outbox;
// the laptop pulls it with `factory worker poll` and replays it there.
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const own = () => process.env.FACTORY_WORKER_DIR ?? '/workspace/w/.factory-worker'
const repo = () => process.env.FACTORY_WORKER_REPO ?? '/workspace/w/repo'
const outbox = () => process.env.FACTORY_OUTBOX ?? join(own(), 'outbox.jsonl')
const prompts = () => join(own(), 'prompts')
const stateFile = () => join(own(), 'state.json')
/** serve's own errors and its agent's stderr: the VM's stdout reaches no log the laptop can read */
const serveLog = () => join(own(), 'serve.log')
const logTail = () => (existsSync(serveLog()) ? readFileSync(serveLog(), 'utf8').slice(-2000) : '')

type State = { status: 'working' | 'idle'; session?: string; pid: number }
const state = (): State | null =>
  existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), 'utf8')) : null
const save = (s: State) => writeFileSync(stateFile(), JSON.stringify(s))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** what `factory report|mail|memory add` does in a VM: queue the command line for the laptop to run */
export function queue(argv: string[]) {
  appendFileSync(outbox(), JSON.stringify({ argv, from: process.env.FACTORY_FROM, at: Date.now() }) + '\n')
}

/**
 * a file the laptop sends in parts (`factory worker put <name> <part> <parts> <base64>`): each part lands on
 * its own, so a part sent again is harmless, and the whole file appears, decoded, once the last is in
 */
export function put(name: string, part: number, parts: number, base64: string) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`put: a file name, not "${name}"`)
  const dir = join(own(), 'put', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, String(part)), base64)
  const have = readdirSync(dir).length
  if (have < parts) return
  const all = Array.from({ length: parts }, (_, i) => readFileSync(join(dir, String(i)), 'utf8')).join('')
  writeFileSync(join(own(), name), Buffer.from(all, 'base64'))
  rmSync(dir, { recursive: true, force: true })
}

/** the real kube-apiserver where envtest's setup put it (KUBEBUILDER_ASSETS) or its default directory */
export const APISERVER_WRAPPER = `#!/bin/sh
for d in "$KUBEBUILDER_ASSETS" /usr/local/kubebuilder/bin; do
  [ -n "$d" ] && [ -x "$d/kube-apiserver" ] && exec "$d/kube-apiserver" --advertise-address=127.0.0.1 "$@"
done
echo "kube-apiserver: none in KUBEBUILDER_ASSETS ($KUBEBUILDER_ASSETS) or /usr/local/kubebuilder/bin" >&2
exit 127
`

/** a file the laptop sends once the task runs (put), waited for; the laptop resends a part that failed */
async function sentFile(name: string, { waitMs = 2000, tries = 300 } = {}) {
  const file = join(own(), name)
  for (let i = 0; !existsSync(file); i++) {
    if (i >= tries) throw new Error(`the laptop never sent ${name}`)
    await Bun.sleep(waitMs)
  }
  return readFileSync(file)
}

/** bd in the VM: a store of its own, never the laptop's dolt server that the repo's .beads config names */
const bdEnv = () => ({ ...process.env, BEADS_DOLT_SHARED_SERVER: '0', BD_NON_INTERACTIVE: '1' })

/**
 * the rig's beads in the VM, when the run has some (FACTORY_BEADS): a clone of the store the laptop syncs to
 * the repo's GitHub origin (refs/dolt/data), in a directory of its own, since the repo's .beads config names
 * the laptop's server; the agent's bd finds it through BEADS_DIR. A resumed task keeps it
 */
export function setupBeads() {
  if (!process.env.FACTORY_BEADS) return
  const dir = join(own(), 'beads')
  const remote = process.env.FACTORY_BEADS_REMOTE
  // Dolt sends its user and password as an Authorization header, which the egress gateway replaces with the
  // vault's: the VM holds only this placeholder (DOLT_REMOTE_USER comes in the rig's env)
  if (remote) process.env.DOLT_REMOTE_PASSWORD ??= 'placeholder'
  if (!existsSync(join(dir, '.beads', 'embeddeddolt'))) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    // a rig's shared Dolt remote (FACTORY_BEADS_REMOTE), else the repo's GitHub origin
    if (remote) {
      mkdirSync(join(dir, '.beads'), { recursive: true })
      writeFileSync(join(dir, '.beads', 'config.yaml'), `sync.remote: ${JSON.stringify(remote)}\n`)
    }
    for (const cmd of [
      ['git', 'init', '-q', '.'],
      ...(remote ? [] : [['git', 'remote', 'add', 'origin', process.env.FACTORY_REPO!]]),
      [process.env.FACTORY_BD ?? 'bd', 'bootstrap', '-y'],
    ]) {
      const p = Bun.spawnSync(cmd, { cwd: dir, env: bdEnv(), stderr: 'pipe' })
      if (p.exitCode !== 0)
        throw new Error(`beads in the VM: ${cmd.join(' ')}: ${p.stderr.toString().trim()}`)
    }
  }
  Object.assign(process.env, { ...bdEnv(), BEADS_DIR: join(dir, '.beads') })
}

/**
 * the VM's bd writes back to GitHub, where the laptop pulls them: pull (merging what the laptop or another
 * worker pushed since) and push, again when another push won the race. false when it never went through
 */
export function syncBeads({ tries = 3 } = {}) {
  if (!process.env.BEADS_DIR) return true
  const bd = process.env.FACTORY_BD ?? 'bd'
  for (let i = 0; i < tries; i++) {
    const run = (args: string[]) =>
      Bun.spawnSync([bd, ...args], { env: bdEnv(), stderr: 'pipe' }).exitCode === 0
    if (run(['dolt', 'pull']) && run(['dolt', 'push'])) return true
  }
  return false
}

type Harness = 'claude' | 'codex' | 'pi'
const harness = (): Harness => (process.env.FACTORY_HARNESS as Harness | undefined) ?? 'claude'

/**
 * the argv of one headless turn of an agent: the brief when there is no session yet, else the next prompt
 * resuming it. Claude: `-p --resume <id>`; codex: `exec`, then `exec resume <id>`; pi: `-p --session-id <id>`,
 * which pi creates on first use. The agents' permission prompts are off: the microVM is the sandbox.
 */
export function turnArgv(
  h: Harness,
  text: string,
  o: { model?: string; provider?: string; session?: string; claudeFlags?: string[]; piDir?: string } = {},
) {
  const model = (flag: string) => (o.model ? [flag, o.model] : [])
  switch (h) {
    case 'claude':
      return [
        process.env.FACTORY_CLAUDE ?? 'claude',
        ...['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'],
        ...(o.claudeFlags ?? []),
        ...model('--model'),
        ...(o.session ? ['--resume', o.session] : []),
        text,
      ]
    case 'codex':
      return [
        process.env.FACTORY_CODEX ?? 'codex',
        ...['exec', ...(o.session ? ['resume'] : [])],
        ...['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
        ...model('-m'),
        // after --, so a prompt that starts with a dash is not a flag
        ...['--', ...(o.session ? [o.session] : []), text],
      ]
    case 'pi':
      return [
        process.env.FACTORY_PI ?? 'pi',
        ...['-p', '--session-dir', o.piDir!, '--session-id', o.session!],
        ...(o.provider ? ['--provider', o.provider] : []),
        ...model('--model'),
        text,
      ]
  }
}

/** the session a turn's output names: Claude's init event, codex's thread.started; pi's id is ours, given up front */
export function sessionIn(h: Harness, out: string) {
  if (h === 'claude') return out.match(/"session_id":"([^"]+)"/)?.[1]
  if (h === 'codex') return out.match(/"type":"thread\.started"[^\n]*?"thread_id":"([^"]+)"/)?.[1]
}

/** one turn of the station's agent; returns its session id, given the one before */
async function turn(text: string, model?: string, session?: string) {
  const h = harness()
  // pi has no output to read an id from: it takes one on first use
  const id = h === 'pi' ? (session ?? crypto.randomUUID()) : session
  const argv = turnArgv(h, text, {
    model,
    provider: process.env.FACTORY_PROVIDER,
    session: id,
    claudeFlags: process.env.FACTORY_CLAUDE_FLAGS ? JSON.parse(process.env.FACTORY_CLAUDE_FLAGS) : [],
    piDir: join(own(), 'pi'),
  })
  // env spelled out: Bun's default is the env at startup, without what setup() added
  const p = Bun.spawn(argv, { cwd: repo(), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  const err = new Response(p.stderr).text()
  const out = await new Response(p.stdout).text()
  const code = await p.exited
  if (code !== 0 || (await err))
    appendFileSync(
      serveLog(),
      `${new Date().toISOString()} ${h} exited ${code}: ${(await err).slice(-4000)}\n`,
    )
  appendFileSync(join(own(), `${h}.jsonl`), out)
  return h === 'pi' ? id : (sessionIn(h, out) ?? session)
}

function sh(cmd: string[], cwd?: string) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env }, stderr: 'pipe' })
  return { ok: p.exitCode === 0, err: p.stderr.toString().trim() }
}

/**
 * the rig's bazel flags, and the gateway's CA for bazel: its gRPC (a remote cache) takes the PEM, but its JVM,
 * which fetches modules and toolchains, reads only a Java trust store, which keytool makes (from Nix: the image
 * has no JDK, and its OpenSSL cannot write one Java trusts)
 */
function bazelrc() {
  const lines = [process.env.FACTORY_BAZELRC!]
  if (process.env.FACTORY_CA) {
    const ca = join(own(), 'egress-ca.crt')
    const store = join(own(), 'egress.jks')
    rmSync(store, { force: true }) // the CA is written anew every start
    const keytool = process.env.FACTORY_KEYTOOL
      ? [process.env.FACTORY_KEYTOOL]
      : ['nix', 'shell', 'nixpkgs#jdk21_headless', '-c', 'keytool']
    // a trust store holds no secret: its password is Java's well-known default
    const made = sh([
      ...keytool,
      '-importcert',
      '-noprompt',
      '-alias',
      'egress',
      '-file',
      ca,
      '-keystore',
      store,
      '-storepass',
      'changeit',
    ])
    if (!made.ok) console.error(`bazel will not trust the egress gateway: keytool: ${made.err}`)
    lines.push(
      `common --tls_certificate=${ca}`,
      `startup --host_jvm_args=-Djavax.net.ssl.trustStore=${store} --host_jvm_args=-Djavax.net.ssl.trustStorePassword=changeit`,
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * the rig's binary cache of its repo's devenv (FACTORY_NIX_CACHE: its URL and public key), which Nix asks with a
 * placeholder password the gateway replaces with the cache's token: every local Nix build fails under gVisor, so
 * a devenv loads only when a cache holds what the repo builds itself
 */
function nixCache() {
  const [url, key] = (process.env.FACTORY_NIX_CACHE ?? '').trim().split(/\s+/)
  if (!url || !key) return
  const netrc = join(own(), 'nix.netrc')
  writeFileSync(netrc, `machine ${new URL(url).hostname}\nlogin factory\npassword placeholder\n`)
  process.env.NIX_CONFIG = [
    process.env.NIX_CONFIG,
    `extra-substituters = ${url}`,
    `extra-trusted-public-keys = ${key}`,
    `netrc-file = ${netrc}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** what of a devenv's environment stays the worker's: the VM's own places and CA, and the image's libraries */
const NOT_DEVENV = new Set([
  'HOME',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'SHELL',
  'TERM',
  'TMP',
  'TEMP',
  'TEMPDIR',
  'TMPDIR',
  'NIX_BUILD_TOP',
  'NIX_LOG_FD',
  // ponytail: the agent's own node and bun would load the devenv's libraries; a tool that needs them sets it itself
  'LD_LIBRARY_PATH',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'SSL_CERT_FILE',
  'NIX_SSL_CERT_FILE',
])

/**
 * the repo's devenv.nix, when its rig caches it, as the worker's own environment, so the agent and all it runs
 * have the repo's toolchain without devenv shell, whose enterShell runs the repo's git hooks (minutes of bazel).
 * Every start: the environment lives only in this process. A devenv that will not load leaves the VM as it was
 */
export function loadDevenv() {
  if (!process.env.FACTORY_NIX_CACHE || !existsSync(join(repo(), 'devenv.nix'))) return
  const script = join(own(), 'devenv.sh')
  const env = { ...process.env } as Record<string, string>
  const made = Bun.spawnSync(['devenv', 'print-dev-env'], { cwd: repo(), env, stderr: 'pipe' })
  if (made.exitCode !== 0)
    return void console.error(`devenv print-dev-env: ${made.stderr.toString().trim().slice(-2000)}`)
  writeFileSync(script, made.stdout)
  const dumped = Bun.spawnSync(
    ['bash', '-c', `e=$(command -v env); . '${script}' >/dev/null 2>&1; "$e" -0`],
    { cwd: repo(), env },
  )
  const basePath = process.env.PATH
  for (const pair of dumped.stdout.toString().split('\0')) {
    const eq = pair.indexOf('=')
    const k = pair.slice(0, eq)
    // the shell's own variables only: stdenv's lowercase attributes (name, out, phases) are not for tools
    if (eq > 0 && /^[A-Z_][A-Z0-9_]*$/.test(k) && k !== '_' && !NOT_DEVENV.has(k))
      process.env[k] = pair.slice(eq + 1)
  }
  if (process.env.PATH !== basePath) process.env.PATH = `${process.env.PATH}:${basePath}`
}

/** the VM has no /etc/hosts, so localhost does not resolve (a test's local API server, say) */
function localhost() {
  if (!existsSync('/etc/hosts') || !/^127\.0\.0\.1\s+localhost\b/m.test(readFileSync('/etc/hosts', 'utf8')))
    try {
      appendFileSync('/etc/hosts', '127.0.0.1 localhost\n::1 localhost\n')
    } catch {
      // not root (a test, or serve as the worker user after asWorker wrote it): tests resolve what they can
    }
}

/** the image's user that serve runs as: Substrate starts every task as root, which tools such as initdb refuse */
export const WORKER_USER = 'worker'

/**
 * as root with the task's capabilities (SETUID, SETGID, CHOWN; see ax.ts): do what only root can, then run serve
 * again as WORKER_USER and exit with it. The actor's / and /workspace are 0700, so a user could exec nothing, and
 * the workspace is root's. Without the capabilities (a task from an AX without spec.capabilities) serve stays root
 */
function asWorker() {
  if (process.getuid?.() !== 0) return
  localhost()
  const ws = dirname(own())
  for (const d of ['/', dirname(ws)]) chmodSync(d, 0o755)
  const as = ['setpriv', `--reuid=${WORKER_USER}`, `--regid=${WORKER_USER}`, '--init-groups']
  if (Bun.spawnSync([...as, 'true']).exitCode !== 0)
    return void console.error(`serve: cannot become ${WORKER_USER} (no SETUID/SETGID), staying root`)
  mkdirSync(ws, { recursive: true })
  if (statSync(ws).uid === 0 && Bun.spawnSync(['chown', '-R', `${WORKER_USER}:`, ws]).exitCode !== 0)
    return void console.error(`serve: cannot give ${ws} to ${WORKER_USER} (no CHOWN), staying root`)
  const p = Bun.spawnSync([...as, ...process.argv], {
    env: { ...process.env, HOME: `/home/${WORKER_USER}`, USER: WORKER_USER },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(p.exitCode ?? 1)
}

/**
 * every start, since only the workspace survives a suspend: trust the egress gateway's CA (it decrypts all
 * HTTPS out) and clone the run's branch, retrying while the task's egress policy does not exist yet
 */
export async function setup({ tries = 60, waitMs = 5000 } = {}) {
  if (process.env.FACTORY_CA) {
    const ca = join(own(), 'egress-ca.crt')
    writeFileSync(ca, process.env.FACTORY_CA)
    // the gateway re-signs every HTTPS host the VM may reach, so its CA is the only root needed
    Object.assign(process.env, {
      NODE_EXTRA_CA_CERTS: ca,
      GIT_SSL_CAINFO: ca,
      SSL_CERT_FILE: ca,
      NIX_SSL_CERT_FILE: ca,
    })
  }
  localhost()
  // bazel takes no rc file from the env: a rig's remote cache flags (its key a placeholder the gateway
  // replaces) go in the home rc, which every workspace reads
  // HOME, not homedir(): Bun's homedir() ignores a HOME set at runtime, so a test would write the real one
  if (process.env.FACTORY_BAZELRC) writeFileSync(join(process.env.HOME ?? homedir(), '.bazelrc'), bazelrc())
  nixCache()
  // go's toolchain downloads go nowhere the egress allows: use the go that nix shell gives
  process.env.GOTOOLCHAIN ??= 'local'
  // the VM's only address is link-local, which kube-apiserver will not advertise, so envtest's control plane
  // never starts: envtest runs this wrapper (TEST_ASSET_KUBE_APISERVER) instead, advertising 127.0.0.1
  const bin = join(own(), 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'kube-apiserver'), APISERVER_WRAPPER, { mode: 0o755 })
  process.env.TEST_ASSET_KUBE_APISERVER ??= join(bin, 'kube-apiserver')
  const remote = process.env.FACTORY_REPO
  if (!remote || existsSync(join(repo(), '.git'))) return
  let err = ''
  for (let i = 0; i < tries; i++) {
    rmSync(repo(), { recursive: true, force: true })
    const r = sh(['git', 'clone', '--branch', process.env.FACTORY_BRANCH ?? 'main', remote, repo()])
    if (r.ok) return
    err = r.err
    await Bun.sleep(waitMs)
  }
  throw new Error(`git clone ${remote}: ${err}`)
}

/**
 * the worker: the brief once, then queued prompts in order, one turn at a time. A resumed task restarts
 * it with the workspace as it was, so a session already started is never briefed again.
 */
export async function serve(model?: string, o: { idleMs?: number; once?: boolean } = {}) {
  asWorker()
  try {
    await serveTurns(model, o)
  } catch (e) {
    appendFileSync(serveLog(), `${new Date().toISOString()} serve died: ${(e as Error).stack ?? e}\n`)
    throw e
  }
}

async function serveTurns(model?: string, { idleMs = 1000, once = false } = {}) {
  mkdirSync(prompts(), { recursive: true })
  // working from the start: until the first turn there is no state, which poll would read as exited
  save({ status: 'working', session: state()?.session, pid: process.pid })
  await setup()
  setupBeads() // after the clone: both wait on the task's egress policy
  loadDevenv()
  let session = state()?.session
  const set = (status: State['status']) => save({ status, session, pid: process.pid })
  if (!session) {
    // a brief too long for the env (Substrate takes 32 KiB a value) comes as brief.md
    const brief = process.env.FACTORY_BRIEF ?? (await sentFile('brief.md')).toString()
    set('working')
    session = await turn(brief, model)
  }
  for (;;) {
    const next = readdirSync(prompts()).sort()[0]
    if (!next) {
      set('idle')
      if (once) return
      await Bun.sleep(idleMs)
      continue
    }
    set('working')
    const file = join(prompts(), next)
    session = await turn(readFileSync(file, 'utf8'), model, session)
    rmSync(file) // after the turn: a prompt cut off by a crash runs again
  }
}

/** the laptop's view: the worker's state and the outbox past its cursor */
export function poll(cursor: number) {
  const s = state()
  const lines = existsSync(outbox()) ? readFileSync(outbox(), 'utf8').split('\n').filter(Boolean) : []
  return {
    status: !s || !alive(s.pid) ? 'exited' : s.status,
    session: s?.session,
    lines: lines.slice(cursor),
    tail: lastTurn(s?.session),
    log: logTail(),
  }
}

/** a Claude session's last assistant entry: the laptop reads a usage limit and the context size from it */
export function lastTurn(session?: string) {
  if (harness() !== 'claude' || !session) return undefined
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const file = join(dir, 'projects', repo().replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
  if (!existsSync(file)) return undefined
  const size = statSync(file).size
  const buf = Buffer.alloc(Math.min(size, 512 * 1024))
  const fd = openSync(file, 'r')
  readSync(fd, buf, 0, buf.length, size - buf.length)
  closeSync(fd)
  return buf
    .toString()
    .split('\n')
    .findLast(l => l.includes('"type":"assistant"'))
}

export function prompt(base64: string) {
  mkdirSync(prompts(), { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
  writeFileSync(join(prompts(), name), Buffer.from(base64, 'base64').toString())
}
