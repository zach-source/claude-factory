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

/** an egress-gateway outage serve is retrying a turn through (egressFailure): see docs/remote-runner.md */
export type Egress = { since: number; tries: number; last: string }
type State = { status: 'working' | 'idle'; session?: string; pid: number; egress?: Egress }
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

/** the usage line for each outbox-replayable command, shown both for `--help`/`-h` (exit 0) and malformed
 * args (exit 1): see `outboxUsage` */
export const OUTBOX_USAGE = {
  report: 'usage: factory report <run> <seq> <outcome> <summary...>',
  mail: 'usage: factory mail <run> <node|manager> <text...>',
  memory: 'usage: factory memory add [--rig r] [--from run/station] [--anyway] <summary> [body...]',
}

/**
 * whether `factory report|mail|memory add`'s own args, inside a VM, ask for help, are malformed, or are fine
 * to queue: 'help' when `--help`/`-h` sits in a positional slot (report's run/seq/outcome, mail's run/node,
 * memory add's summary) -- never in free text, so a report outcome that happens to mention '-h' still queues
 * -- a usage string when the args are malformed, else null. Before this, `report --help` queued a fake report
 * indistinguishable from a real one, which let a worker fake "reported ready" twice (claude-factory-4x1)
 */
export function outboxUsage(cmd: string, args: string[]): 'help' | string | null {
  const helpAt = (slots: (string | undefined)[]) => slots.some(a => a === '--help' || a === '-h')
  if (cmd === 'report') {
    if (helpAt(args.slice(0, 3))) return 'help'
    if (args.length < 3 || !/^\d+$/.test(args[1] ?? '') || (args[2] ?? '').startsWith('-'))
      return OUTBOX_USAGE.report
    return null
  }
  if (cmd === 'mail') {
    if (helpAt(args.slice(0, 2))) return 'help'
    if (args.length < 2) return OUTBOX_USAGE.mail
    return null
  }
  if (cmd === 'memory' && args[0] === 'add') {
    if (helpAt([args[1]])) return 'help'
    if (!args[1]) return OUTBOX_USAGE.memory
    return null
  }
  return null
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

/** The result of syncBeads for a push, a pull, or every try. It is ok. Or it names the command that does not succeed and bd's own last error line. */
export type SyncResult = { ok: true } | { ok: false; step: 'pull' | 'push'; error: string }

/**
 * This returns the last line of stderr that is not empty. It comes from a bd command that does not succeed, and has a maximum of 300 chars.
 * src/cli.ts uses this line in its refusal message.
 * Each http(s) or file URL becomes <url>.
 * A Dolt remote URL can contain its host.
 * A refusal must not repeat that host where the worker's mail or logs can send it on.
 */
function lastError(stderr: string): string {
  const line = stderr.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? ''
  return line.replace(/\b(?:https?|file):\/\/\S+/g, '<url>').slice(0, 300)
}

/**
 * syncBeads sends the VM's bd writes to GitHub, where the laptop pulls them. It pulls first, then pushes.
 * The pull gets writes from the laptop or from another worker.
 * If another push gets to GitHub first, syncBeads tries again.
 * If the writes do not get to GitHub, it returns { ok: false, step, error }.
 * The result names the command that does not succeed.
 *
 * The laptop and this VM can change the same row on the same day.
 * So a pull can stop with a merge conflict.
 * In that case, syncBeads tries the pull again with `--strategy ours`.
 * The ours strategy keeps the VM's own writes, because the VM did the work that it will report.
 * The laptop's pull function, pullResolving in src/cli.ts, uses the same rule in the opposite direction.
 * If a pull stops for another cause, it still stops in the same way after the second try.
 */
export function syncBeads({ tries = 3 } = {}): SyncResult {
  if (!process.env.BEADS_DIR) return { ok: true }
  const bd = process.env.FACTORY_BD ?? 'bd'
  let last: { step: 'pull' | 'push'; error: string } = { step: 'pull', error: '' }
  for (let i = 0; i < tries; i++) {
    const spawn = (args: string[]) => Bun.spawnSync([bd, ...args], { env: bdEnv(), stderr: 'pipe' })
    let pulled = spawn(['dolt', 'pull'])
    if (pulled.exitCode !== 0) {
      const conflict = pulled.stderr.toString().includes('conflict')
      pulled = spawn(['dolt', 'pull', '--strategy', 'ours'])
      if (pulled.exitCode === 0 && conflict)
        console.error('bd sync: your bd changes and upstream changed the same rows; your version was kept')
    }
    if (pulled.exitCode !== 0) {
      last = { step: 'pull', error: lastError(pulled.stderr.toString()) }
      continue
    }
    const pushed = spawn(['dolt', 'push'])
    if (pushed.exitCode === 0) return { ok: true }
    last = { step: 'push', error: lastError(pushed.stderr.toString()) }
  }
  return { ok: false, ...last }
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

/**
 * Envoy's local reply for a failed upstream connect on the dynamic forward proxy to api.anthropic.com (see
 * docs/remote-runner.md): ate-system/atenet-egress denies every new connection while agent-vault's credential
 * is stale, then keeps failing some of them (its auto_san_validation) until a rollout restart, sometimes not
 * even then. Only this exact Envoy text counts: a generic 5xx or a rate-limit refusal is Claude's own, which it
 * already retries, so matching it here would mask a real API failure instead of the gateway's
 */
const EGRESS_SIGNATURE = /upstream connect error or disconnect\/reset before headers/i

/**
 * the egress gateway's signature in a finished turn's output, clipped to 300 chars; null for a success, a
 * usage-limit or overload refusal, or any other error. Claude's headless stream ends in one `result` line,
 * `is_error` true or false; codex and pi have no fixed shape, so their last 4000 chars of stdout+stderr are
 * searched instead
 */
export function egressFailure(h: Harness, out: string, err: string): string | null {
  if (h === 'claude') {
    for (const line of out.split('\n').reverse()) {
      if (!line.includes('"type":"result"')) continue
      try {
        const e = JSON.parse(line)
        if (e.type !== 'result') continue
        if (!e.is_error) return null
        const text = String(e.result ?? '')
        return EGRESS_SIGNATURE.test(text) ? text.slice(0, 300) : null
      } catch {
        // the first line of a cut stream
      }
    }
    return null
  }
  const text = `${out}${err}`.slice(-4000)
  if (!EGRESS_SIGNATURE.test(text)) return null
  // the matching line, not whatever the 4000-char window happens to end on: the signature can sit
  // well before the window's tail, with unrelated agent output after it
  const line = text.split('\n').findLast(l => EGRESS_SIGNATURE.test(l))
  return (line ?? text).slice(0, 300)
}

/**
 * one turn of the station's agent: its session id, given the one before, and the egress gateway's failure, if
 * it was that. stdout is streamed (not buffered to exit): each chunk lands in own()/<h>.jsonl as it arrives, so
 * poll's lastTurn can read it while the turn is still running, and `onSession` fires once, the moment the
 * session id first appears in the output (pi's is known up front), instead of only after the whole process
 * exits -- a single claude -p call can run 30-90+ min, which left poll's tail null for the turn's entire length
 * (claude-factory-xq3)
 */
async function turn(text: string, model?: string, session?: string, onSession?: (id: string) => void) {
  const h = harness()
  // pi has no output to read an id from: it takes one on first use
  const id = h === 'pi' ? (session ?? crypto.randomUUID()) : session
  if (id && h === 'pi') onSession?.(id)
  const argv = turnArgv(h, text, {
    model,
    provider: process.env.FACTORY_PROVIDER,
    session: id,
    claudeFlags: process.env.FACTORY_CLAUDE_FLAGS ? JSON.parse(process.env.FACTORY_CLAUDE_FLAGS) : [],
    piDir: join(own(), 'pi'),
  })
  // env spelled out: Bun's default is the env at startup, without what setup() added
  const p = Bun.spawn(argv, { cwd: repo(), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  const errP = new Response(p.stderr).text()
  const chunkFile = join(own(), `${h}.jsonl`)
  const reader = p.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let found = h === 'pi' // already given up front; claude and codex name theirs in the stream
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const piece = decoder.decode(value, { stream: true })
    out += piece
    appendFileSync(chunkFile, piece)
    if (!found) {
      const sid = sessionIn(h, out)
      if (sid) {
        found = true
        onSession?.(sid)
      }
    }
  }
  const last = decoder.decode() // a multi-byte char split across the final chunk
  if (last) {
    out += last
    appendFileSync(chunkFile, last)
  }
  const err = await errP
  const code = await p.exited
  if (code !== 0 || err) appendFileSync(serveLog(), `${new Date().toISOString()} ${h} exited ${code}: ${err.slice(-4000)}\n`)
  return { session: h === 'pi' ? id : (sessionIn(h, out) ?? session), egress: egressFailure(h, out, err) }
}

/** sent instead of the queued prompt (or the brief again, with no session yet) on a retry: see turnWithRetry */
export const EGRESS_RETRY_PROMPT =
  'The last turn failed on the egress gateway refusing a new connection to the model API (see above). Try again.'

const egressWaitMs = () => Number(process.env.FACTORY_EGRESS_WAIT_MS ?? 30_000)
const egressBudgetMs = () => Number(process.env.FACTORY_EGRESS_BUDGET_MS ?? 30 * 60_000)

/**
 * one turn, retried in place while it ends on the egress gateway's known failure: the same session (once
 * there is one) and the continuation prompt, else the brief again; backoff doubles from FACTORY_EGRESS_WAIT_MS
 * (default 30s), capped at 10x that (5 min at the default), for up to FACTORY_EGRESS_BUDGET_MS (default 30
 * min) counted from the outage's own start (`initial`, serveTurns' own `egress`), not this call's: a turn
 * that gives up still has its queued prompt replaced by the manager's reply (see reconcile's TIME_UP warn),
 * and the outage is almost always still open when that reply's turn starts, so the budget has to span every
 * call it takes, not restart counting from zero each time. `onEgress` is given the session each call learns,
 * too (not just the egress state), so a crash or restart mid-retry resumes the session already opened, rather
 * than silently losing it and re-briefing. It records the outage for poll as it goes, and clears it once a
 * turn gets through. `onSession` fires as soon as the running turn's own session id streams in (see turn()),
 * well before this call returns, so poll can read the live transcript while a long turn is still going
 */
async function turnWithRetry(
  text: string,
  model: string | undefined,
  session: string | undefined,
  onEgress: (e: Egress | undefined, session?: string) => void,
  onSession: (id: string) => void,
  initial?: Egress,
) {
  const waitMs = egressWaitMs()
  const budgetMs = egressBudgetMs()
  const capMs = waitMs * 10
  let cur = session
  let prompt = text
  let tries = initial?.tries ?? 0
  let since = initial?.since ?? 0
  for (;;) {
    const r = await turn(prompt, model, cur, id => {
      cur = id
      onSession(id)
    })
    cur = r.session
    if (!r.egress) {
      onEgress(undefined, cur)
      return cur
    }
    tries++
    since ||= Date.now()
    onEgress({ since, tries, last: r.egress }, cur)
    appendFileSync(
      serveLog(),
      `${new Date().toISOString()} egress failure, retry ${tries}: ${r.egress.slice(0, 200)}\n`,
    )
    if (Date.now() - since >= budgetMs) return cur
    await Bun.sleep(Math.min(waitMs * 2 ** (tries - 1), capMs))
    prompt = cur ? EGRESS_RETRY_PROMPT : text
  }
}

function sh(cmd: string[], cwd?: string) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env }, stderr: 'pipe' })
  return { ok: p.exitCode === 0, err: p.stderr.toString().trim() }
}

/**
 * kubectl takes no server or token from the env: a rig with cluster access (FACTORY_KUBE_SERVER, the API server's
 * URL) gets a kubeconfig whose bearer token is a placeholder the gateway replaces, trusting the gateway's CA
 */
function kubeconfig() {
  const dir = join(process.env.HOME ?? homedir(), '.kube')
  mkdirSync(dir, { recursive: true })
  const ca = process.env.FACTORY_CA ? { 'certificate-authority': join(own(), 'egress-ca.crt') } : {}
  // JSON is YAML, so kubectl reads it as written
  const config = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 'factory', cluster: { server: process.env.FACTORY_KUBE_SERVER, ...ca } }],
    users: [{ name: 'factory', user: { token: 'placeholder' } }],
    contexts: [{ name: 'factory', context: { cluster: 'factory', user: 'factory' } }],
    'current-context': 'factory',
  }
  writeFileSync(join(dir, 'config'), JSON.stringify(config, null, 2))
}

/**
 * the rig's bazel flags, and the gateway's CA for bazel: its gRPC (a remote cache) takes the PEM, but its JVM,
 * which fetches modules and toolchains, reads only a Java trust store, which keytool makes (from Nix: the image
 * has no JDK, and its OpenSSL cannot write one Java trusts)
 */
export function bazelrc() {
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
  // with a pkg-gate (launch() set these in the VM's env), rules_go/rules_python/rules_js fetch through it too,
  // instead of straight to proxy.golang.org/pypi.org/registry.npmjs.org, which the gate's egress strip refuses
  for (const v of ['GOPROXY', 'PIP_INDEX_URL', 'NPM_CONFIG_REGISTRY'])
    if (process.env[v]) lines.push(`common --repo_env=${v}=${process.env[v]}`)
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
const home = () => `/home/${WORKER_USER}`

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
  // Substrate shows the image's files as root's whatever their owner (substrate#2036), so the user's home and
  // Nix's store and database are given to it here; the workspace only once, being all of a resumed task's work
  const chown = (...a: string[]) => Bun.spawnSync(['chown', ...a]).exitCode === 0
  const given =
    chown('-R', `${WORKER_USER}:`, home(), '/nix/var') &&
    chown(`${WORKER_USER}:`, '/nix/store') &&
    (statSync(ws).uid !== 0 || chown('-R', `${WORKER_USER}:`, ws))
  if (!given)
    return void console.error(`serve: cannot give its files to ${WORKER_USER} (no CHOWN), staying root`)
  const p = Bun.spawnSync([...as, ...process.argv], {
    env: { ...process.env, HOME: home(), USER: WORKER_USER },
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
  if (process.env.FACTORY_KUBE_SERVER) kubeconfig()
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
  // read once: a save below with no egress field would otherwise wipe out an outage a crash or
  // suspend left in progress, resetting its budget on every restart instead of carrying it through
  const prior = state()
  // working from the start: until the first turn there is no state, which poll would read as exited
  save({ status: 'working', session: prior?.session, pid: process.pid, egress: prior?.egress })
  await setup()
  setupBeads() // after the clone: both wait on the task's egress policy
  loadDevenv()
  let session = prior?.session
  let egress: Egress | undefined = prior?.egress
  const set = (status: State['status']) => save({ status, session, pid: process.pid, egress })
  // cur: the session the retried turn itself just learned, which may be ahead of the outer `session`
  // (not yet assigned, since turnWithRetry hasn't returned) while an outage is still being retried
  const onEgress = (e: Egress | undefined, cur?: string) => {
    egress = e
    if (cur) session = cur
    set('working')
  }
  // fires the moment the running turn's session id streams in, not only once it ends: without this, state.json's
  // session (and so poll's tail) stays whatever it was before the turn for the turn's whole length, which for one
  // big agentic call is 30-90+ min (claude-factory-xq3)
  const onSession = (id: string) => {
    session = id
    set('working')
  }
  if (!session) {
    // a brief too long for the env (Substrate takes 32 KiB a value) comes as brief.md
    const brief = process.env.FACTORY_BRIEF ?? (await sentFile('brief.md')).toString()
    set('working')
    session = await turnWithRetry(brief, model, undefined, onEgress, onSession, egress)
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
    session = await turnWithRetry(readFileSync(file, 'utf8'), model, session, onEgress, onSession, egress)
    rmSync(file) // after the turn (retried in place through an egress outage): a prompt cut off by a crash runs again
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
    head: gitHead(),
    bytes: streamBytes(),
    log: logTail(),
    ...(s?.egress && { egress: s.egress }),
  }
}

/** the worker repo's HEAD, read inside the VM; '' on any error (no repo yet, no commits), never throws */
function gitHead() {
  const p = Bun.spawnSync(['git', '-C', repo(), 'rev-parse', 'HEAD'])
  return p.exitCode === 0 ? p.stdout.toString().trim() : ''
}

/**
 * the size of the harness's own live stream copy (own()/<h>.jsonl, written chunk by chunk by turn()); 0 if absent.
 * pi -p only prints once its turn exits (own()/pi.jsonl never grows mid-turn), so a constant size there would look
 * like no progress to the stall signature and fail a productive pi turn that happens not to commit; undefined for
 * pi keeps it out of that signature the way an unknown-session Claude tail already is (claude-factory-xq3)
 */
function streamBytes() {
  if (harness() === 'pi') return undefined
  try {
    return statSync(join(own(), `${harness()}.jsonl`)).size
  } catch {
    return 0
  }
}

/** the last assistant entry in a Claude transcript file (its last 512 KiB); undefined when there is none */
function lastAssistant(file: string) {
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

/**
 * a Claude session's last assistant entry: the laptop reads a usage limit and the context size from it. The
 * project transcript (~/.claude/projects/.../<session>.jsonl) is Claude's own, canonical copy, read first when
 * there is a session and it exists; else (no session yet, or the project transcript is missing -- a path
 * mismatch, or simply not written yet) this falls back to own()/claude.jsonl, the live copy turn() streams to as
 * the current turn runs, so poll has something to read for the whole length of a turn, not just once it ends
 * (claude-factory-xq3)
 */
export function lastTurn(session?: string) {
  if (harness() !== 'claude') return undefined
  if (session) {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    const file = join(dir, 'projects', repo().replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
    if (existsSync(file)) return lastAssistant(file)
  }
  return lastAssistant(join(own(), 'claude.jsonl'))
}

export function prompt(base64: string) {
  mkdirSync(prompts(), { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
  writeFileSync(join(prompts(), name), Buffer.from(base64, 'base64').toString())
}
