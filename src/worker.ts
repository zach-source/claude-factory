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
import { basename, dirname, join } from 'node:path'
import {
  beadsOnlyCodexDir,
  CODEX_GUARD_FLAGS,
  codexFeaturesBad,
  codexSkills,
  cutOffCall,
  cutOffNote,
  piFlags,
  VM_PLUGIN_DIRS,
} from './harness'
import { rmSafe } from './home-guard'
import { sessionOf, type Usage } from './metrics'

export const own = () => process.env.FACTORY_WORKER_DIR ?? '/workspace/w/.factory-worker'
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
export function queue(argv: string[], usage?: Usage[]) {
  appendFileSync(
    outbox(),
    JSON.stringify({
      argv,
      from: process.env.FACTORY_FROM,
      at: Date.now(),
      ...(usage?.length && { usage }),
    }) + '\n',
  )
}

/**
 * what this VM's Claude session spent, with its subagents, for the report to carry. The laptop cannot
 * read the VM's transcripts. A worker with no Claude transcript (codex, pi) gives none. Never throws.
 */
export function usageOfSession(run: string): Usage[] {
  try {
    const session = state()?.session
    if (!session || !/^[A-Za-z0-9-]+$/.test(session)) return []
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
    const dir = readdirSync(projects)
      .map(d => join(projects, d))
      .find(d => existsSync(join(d, `${session}.jsonl`)))
    if (!dir) return []
    const read = (f: string) => readFileSync(f, 'utf8').split('\n')
    const subDir = join(dir, session, 'subagents')
    const subs = existsSync(subDir)
      ? readdirSync(subDir)
          .filter(g => g.endsWith('.jsonl'))
          .map(g => read(join(subDir, g)))
      : []
    return sessionOf(read(join(dir, `${session}.jsonl`)), run, () => '?', session, subs)
  } catch {
    return []
  }
}

/** the usage line for each outbox-replayable command, shown both for `--help`/`-h` (exit 0) and malformed
 * args (exit 1): see `outboxUsage` */
export const OUTBOX_USAGE = {
  report: 'usage: factory report <run> <seq> <outcome> <summary...>',
  mail: 'usage: factory mail <run> <node|manager> <text...>',
  memory:
    'usage: factory memory add [--rig r] [--from run/station] --kind fact|rule|recipe [--until <bead|owner/repo#N|YYYY-MM-DD>] [--anyway] <summary> [body...]',
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
  rmSafe(dir, { recursive: true, force: true })
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
 * a bd store in `dir`, bootstrapped once. config.yaml always holds sync.remote: the Dolt `remote`, else git+`origin`,
 * and the origin must then hold refs/dolt/data. It is the worker's store, and the AX manager's, one per rig (src/axrepos.ts)
 */
export function bootstrapBeads(
  dir: string,
  remote: string | undefined,
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (existsSync(join(dir, '.beads', 'embeddeddolt'))) return
  rmSafe(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // bd bootstraps an empty store, and exits 0, from an origin with no refs/dolt/data: refuse that
  if (!remote) {
    const ls = Bun.spawnSync(['git', 'ls-remote', origin, 'refs/dolt/data'], { env, stderr: 'pipe' })
    if (ls.exitCode !== 0 || !ls.stdout.toString().trim())
      throw new Error(`beads in the VM: ${origin} has no refs/dolt/data, set the rig's beadsRemote`)
  }
  mkdirSync(join(dir, '.beads'), { recursive: true })
  const syncRemote = remote ?? `git+${origin}`
  writeFileSync(join(dir, '.beads', 'config.yaml'), `sync.remote: ${JSON.stringify(syncRemote)}\n`)
  for (const cmd of [
    ['git', 'init', '-q', '.'],
    ...(remote ? [] : [['git', 'remote', 'add', 'origin', origin]]),
    [process.env.FACTORY_BD ?? 'bd', 'bootstrap', '-y'],
  ]) {
    const p = Bun.spawnSync(cmd, {
      cwd: dir,
      env: { ...env, BEADS_DOLT_SHARED_SERVER: '0', BD_NON_INTERACTIVE: '1' },
      stderr: 'pipe',
    })
    if (p.exitCode !== 0)
      throw new Error(`beads in the VM: ${cmd.join(' ')}: ${lastError(p.stderr.toString())}`)
  }
}

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
  bootstrapBeads(dir, remote, process.env.FACTORY_REPO!)
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
  const line =
    stderr
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .at(-1) ?? ''
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
 * the argv of one headless turn of an agent. Claude: `-p --resume <id>`; codex: `exec`, then
 * `exec resume <id>`; pi: `-p --session-id <id>`, which pi creates on first use. The brief is the first turn,
 * with no session yet; later turns resume it with the next prompt. The agents' permission prompts are off:
 * the microVM is the sandbox.
 *
 * This argv never carries the prompt text. turn() sends the prompt to the agent on stdin instead. Linux's
 * execve() caps one argv string at MAX_ARG_STRLEN (131072 bytes). A prompt over that limit made posix_spawn
 * fail with ENAMETOOLONG, and that error killed the worker turn (claude-factory-kcg). `claude -p` with no
 * prompt argument reads stdin. codex exec's trailing `-` does the same. So does `pi -p` with no message
 * argument.
 */
export function turnArgv(
  h: Harness,
  o: {
    model?: string
    provider?: string
    session?: string
    claudeFlags?: string[]
    piDir?: string
    plugins?: string[]
  } = {},
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
      ]
    case 'codex':
      return [
        process.env.FACTORY_CODEX ?? 'codex',
        // the deny hook on, the features that skip it off (codexHome checks they hold)
        ...CODEX_GUARD_FLAGS,
        ...['exec', ...(o.session ? ['resume'] : [])],
        ...['--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
        ...model('-m'),
        // after --, so a resumed session id is never read as a flag; '-' reads the prompt from stdin
        ...['--', ...(o.session ? [o.session] : []), '-'],
      ]
    case 'pi':
      return [
        process.env.FACTORY_PI ?? 'pi',
        ...['-p', '--session-dir', o.piDir!, '--session-id', o.session!],
        // the worker rules and the image's skills, as a Claude or codex worker gets them (constitution I)
        ...piFlags(join(import.meta.dir, 'worker-system.md'), o.plugins ?? VM_PLUGIN_DIRS),
        ...(o.provider ? ['--provider', o.provider] : []),
        ...model('--model'),
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
  const argv = turnArgv(h, {
    model,
    provider: process.env.FACTORY_PROVIDER,
    session: id,
    claudeFlags: process.env.FACTORY_CLAUDE_FLAGS ? JSON.parse(process.env.FACTORY_CLAUDE_FLAGS) : [],
    piDir: join(own(), 'pi'),
  })
  // env spelled out: Bun's default is the env at startup, without what setup() added. The prompt goes on
  // stdin, not argv (see turnArgv): a Blob holds the whole text in memory, same as the string already did
  const p = Bun.spawn(argv, {
    cwd: repo(),
    env: { ...process.env },
    stdin: new Blob([text]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
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
  if (code !== 0 || err)
    appendFileSync(serveLog(), `${new Date().toISOString()} ${h} exited ${code}: ${err.slice(-4000)}\n`)
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
 * It drops print-dev-env's closing 'eval ${shellHook:-}' line, so enterShell does not run here either.
 * Every start: the environment lives only in this process. A devenv that will not load leaves the VM as it was
 */
export function loadDevenv() {
  if (!process.env.FACTORY_NIX_CACHE || !existsSync(join(repo(), 'devenv.nix'))) return
  const script = join(own(), 'devenv.sh')
  const env = { ...process.env } as Record<string, string>
  const made = Bun.spawnSync(['devenv', 'print-dev-env'], { cwd: repo(), env, stderr: 'pipe' })
  if (made.exitCode !== 0)
    return void console.error(`devenv print-dev-env: ${made.stderr.toString().trim().slice(-2000)}`)
  // the script ends with 'eval ${shellHook:-}', which runs enterShell: drop it
  writeFileSync(script, made.stdout.toString().replace(/^[ \t]*eval "?\$\{shellHook:-\}"?[ \t]*$/gm, ''))
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

/** devenv 2.2.2's process.ready.http.get value. It is an object, never a URL string (claude-factory-5sn.5). */
export type DevenvHttpGet = { host: string; port: number; path: string; scheme: string }

/** One process that a devenv declares in services.* or processes.*. It is read from DEVENV_TASK_FILE. */
export type DevenvProcess = {
  name: string
  command: string
  cwd?: string
  readyExec?: string
  readyHttp?: DevenvHttpGet
  /** the task names (stripped and de-suffixed in orderByAfter) this process's own 'after' list names */
  after: string[]
  /** processes.<name>.env: devenv puts it on the task itself, never in the command script (claude-factory-5sn.7) */
  env: Record<string, string>
}

/**
 * This function reads a devenv's processes from DEVENV_TASK_FILE. That is devenv 2.2.2's tasks.json file.
 * The plan verified this path in claude-factory-5sn plan#1. A devenv's processes are its services.* and
 * processes.* options.
 *
 * This function returns each entry named 'devenv:processes:<name>'. Each entry's type must be 'process'.
 * Each entry's process.start.enable must not be false.
 *
 * Devenv's oneshots, for example devenv:enterShell and devenv:files, are never processes. They never appear here.
 *
 * This function returns no processes for a missing file, or one it cannot parse. It raises no error for
 * either case. This leaves an old devenv, with no DEVENV_TASK_FILE, unaffected. It also leaves a rig with no
 * processes declared unaffected.
 */
type DevenvTask = {
  name: string
  type: string
  command?: string
  cwd?: string
  after?: string[]
  env?: Record<string, string>
  process?: {
    start?: { enable?: boolean }
    ready?: { exec?: string | null; http?: { get?: DevenvHttpGet | null } } | null
  }
}

export function devenvProcesses(file: string): DevenvProcess[] {
  if (!existsSync(file)) return []
  let tasks: unknown
  try {
    tasks = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(tasks)) return []
  return (tasks as DevenvTask[])
    .filter(t => t?.type === 'process' && typeof t.command === 'string' && t.process?.start?.enable !== false)
    .map(t => ({
      name: t.name.replace(/^devenv:processes:/, ''),
      command: t.command!,
      cwd: t.cwd,
      readyExec: t.process?.ready?.exec ?? undefined,
      readyHttp: t.process?.ready?.http?.get ?? undefined,
      after: t.after ?? [],
      env: t.env ?? {},
    }))
}

/**
 * This function reorders a devenv's processes (claude-factory-5sn.6).
 * Each process's own 'after' list names its dependencies.
 * This function starts, and waits on, each dependency before the process that names it.
 * tasks.json lists processes by name, not by dependency.
 * Without this function, a dependent process can start before the process it depends on, and then stay failed.
 *
 * An 'after' entry names a task, such as 'devenv:processes:web' or 'devenv:processes:web@ready'.
 * This function strips the prefix and any '@suffix'.
 * It then matches the result against the other processes in this same list.
 * An entry that names a task outside this list, such as an oneshot or a disabled process, is not a dependency here.
 * Only a process in this list ever starts.
 * This function never loops forever on a cycle: it skips a process it is already placing, and does not revisit it.
 */
export function orderByAfter(procs: DevenvProcess[]): DevenvProcess[] {
  const byName = new Map(procs.map(p => [p.name, p]))
  const depsOf = (p: DevenvProcess) =>
    p.after
      .map(a => a.replace(/^devenv:processes:/, '').replace(/@\w+$/, ''))
      .filter(name => name !== p.name && byName.has(name))
  const ordered: DevenvProcess[] = []
  const placed = new Set<string>()
  const visiting = new Set<string>()
  const visit = (p: DevenvProcess) => {
    if (placed.has(p.name) || visiting.has(p.name)) return
    visiting.add(p.name)
    for (const dep of depsOf(p)) visit(byName.get(dep)!)
    visiting.delete(p.name)
    placed.add(p.name)
    ordered.push(p)
  }
  for (const p of procs) visit(p)
  return ordered
}

/**
 * This function returns the agent's DATABASE_URL. See A2 of claude-factory-5sn's plan.
 * If the devenv sets DATABASE_URL, this function returns that value.
 * Otherwise, this function builds the URL from PGHOST and PGPORT.
 * devenv's services.postgres sets PGHOST and PGPORT. It does not set DATABASE_URL.
 * This was verified in plan#1 against devenv 2.2.2.
 *
 * If PGHOST starts with '/', it is a Unix socket directory. It is not a host.
 * Postgres takes that directory as a url-encoded ?host=<dir> query parameter in the connection URL.
 *
 * If PGHOST is not set, this function returns undefined.
 * This happens when no services.* ran. It also happens when the service is not Postgres.
 */
export function databaseUrl(env: Record<string, string | undefined>): string | undefined {
  if (env.DATABASE_URL) return env.DATABASE_URL
  const host = env.PGHOST
  if (!host) return undefined
  const port = env.PGPORT
  if (host.startsWith('/')) {
    const params = new URLSearchParams({ host })
    if (port) params.set('port', port)
    return `postgresql:///postgres?${params.toString()}`
  }
  return port ? `postgresql://${host}:${port}/postgres` : `postgresql://${host}/postgres`
}

/** The directory where serve writes the log of each process: own()/services/<name>.log */
const servicesDir = () => join(own(), 'services')

/**
 * How long startServices waits for one process to answer its ready probe.
 * The default value is 120000ms (120s).
 * This function falls back to the default value for a bad FACTORY_SERVICES_WAIT_MS (claude-factory-5sn.8).
 * A bad value is a value that is not a positive, finite number, for example 'abc'.
 * A bad value such as 'abc' gives NaN.
 * A check of elapsed time against NaN is never true.
 * So a service that never turns ready blocks the first turn forever, unless this function falls back.
 */
export const servicesWaitMs = () => {
  const n = Number(process.env.FACTORY_SERVICES_WAIT_MS ?? 120_000)
  return Number.isFinite(n) && n > 0 ? n : 120_000
}

/** One devenv process that startServices tries to start. Its result is ready, or failed. A failed result gives the reason and the log file. */
export type ServiceResult = { name: string; ok: boolean; log: string; detail: string }

/** This function builds the URL waitReady fetches from devenv's ready.http.get object (claude-factory-5sn.5). */
function httpGetUrl(g: DevenvHttpGet): string {
  return `${g.scheme}://${g.host}:${g.port}${g.path}`
}

/**
 * waitReady probes one running process until it answers ready, exits, or the wait time ends.
 * If the entry has readyExec, bash runs its script with a 4s timeout, as devenv does for its probe.
 * The given env already merges the process's own env over the serve env (claude-factory-5sn.7).
 *
 * If the process entry has readyHttp, waitReady builds the URL from the {host,port,path,scheme} object.
 * It fetches the URL with a 4s timeout (claude-factory-5sn.5, claude-factory-iap). A URL string there
 * made fetch() throw, so each HTTP-probed service used to fail at the end of the full wait time. Without
 * its own timeout, a connection that opens but never answers can also hold one fetch call past waitMs.
 *
 * If the process entry has neither readyExec nor readyHttp, waitReady counts the process ready at 2s.
 * waitReady does not throw. A failed probe counts as not ready yet. Causes include a bad script, a
 * refused connection and a probe timeout.
 */
async function waitReady(
  p: DevenvProcess,
  exited: Promise<number>,
  startedAt: number,
  waitMs: number,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; detail: string }> {
  let exitCode: number | undefined
  exited.then(code => (exitCode = code))
  for (;;) {
    if (exitCode !== undefined) return { ok: false, detail: `exit ${exitCode}` }
    let ready = false
    try {
      if (p.readyExec) {
        ready =
          Bun.spawnSync(['bash', '-c', p.readyExec], { cwd: p.cwd ?? repo(), env, timeout: 4000 })
            .exitCode === 0
      } else if (p.readyHttp) {
        ready = (await fetch(httpGetUrl(p.readyHttp), { signal: AbortSignal.timeout(4000) })).ok
      } else {
        ready = Date.now() - startedAt >= 2000
      }
    } catch {
      ready = false
    }
    const elapsed = Date.now() - startedAt
    if (ready) return { ok: true, detail: `ready in ${Math.round(elapsed / 1000)}s` }
    if (elapsed >= waitMs) return { ok: false, detail: `not ready after ${Math.round(elapsed / 1000)}s` }
    await Bun.sleep(1000)
  }
}

/**
 * startServices starts every process that the repo's devenv declares (services.* and processes.*), before the
 * agent's first turn.
 * startServices reads DEVENV_TASK_FILE. loadDevenv() already put it in process.env.
 * startServices starts the processes in orderByAfter's order, so a process starts only once each process in
 * its own 'after' list already answers ready (claude-factory-5sn.6).
 *
 * startServices runs each process's own command directly. It never runs `devenv up` or `devenv shell`, so no
 * oneshot (devenv:enterShell, say) runs here.
 * It spawns each process, and probes its readiness, with the serve process's own env merged with the
 * process's own 'env' field from the task (claude-factory-5sn.7).
 *
 * startServices sends the stdout and stderr of each process to its own log under servicesDir(). It never sends
 * them to serve's own output. A daemonized child must not keep a pipe to this process open past a suspend.
 * startServices spawns each child unref'd, so serve does not wait for it.
 * The child keeps running after this function returns.
 *
 * If FACTORY_SERVICES is '0', startServices changes nothing.
 * It also changes nothing when the devenv has no DEVENV_TASK_FILE (an old devenv, or none cached), or when it
 * declares no process.
 * In these cases, no process starts, and startServices does not change process.env.
 *
 * After startServices tries every process, it sets DATABASE_URL on process.env from PGHOST/PGPORT.
 * It does not set DATABASE_URL when the devenv itself sets it, or when process.env has neither PGHOST nor PGPORT.
 */
export async function startServices(): Promise<ServiceResult[]> {
  if (process.env.FACTORY_SERVICES === '0') return []
  const file = process.env.DEVENV_TASK_FILE
  if (!file) return []
  const procs = orderByAfter(devenvProcesses(file))
  if (!procs.length) return []
  const waitMs = servicesWaitMs()
  mkdirSync(servicesDir(), { recursive: true })
  const results: ServiceResult[] = []
  for (const p of procs) {
    const log = join(servicesDir(), `${p.name}.log`)
    const startedAt = Date.now()
    const fd = openSync(log, 'a')
    const env = { ...process.env, ...p.env }
    let sub: ReturnType<typeof Bun.spawn>
    try {
      sub = Bun.spawn(['bash', '-c', p.command], {
        cwd: p.cwd ?? repo(),
        env,
        stdin: 'ignore',
        stdout: fd,
        stderr: fd,
      })
    } finally {
      closeSync(fd)
    }
    sub.unref()
    const r = await waitReady(p, sub.exited, startedAt, waitMs, env)
    const line = r.ok
      ? `services: ${p.name} ${r.detail}`
      : `services: ${p.name} failed: ${r.detail}, see ${log}`
    appendFileSync(serveLog(), `${new Date().toISOString()} ${line}\n`)
    results.push({ name: p.name, ok: r.ok, log, detail: r.detail })
  }
  if (!process.env.DATABASE_URL) {
    const url = databaseUrl(process.env)
    if (url) process.env.DATABASE_URL = url
  }
  return results
}

/**
 * servicesNote builds the [factory] note from the results of startServices.
 * servicesNote adds the note to the brief of the first turn only.
 * A resumed VM restarts the processes, but it is never briefed again.
 *
 * When startServices starts nothing (A7), servicesNote returns an empty string.
 * This means no note, the same as when the devenv declares no services.
 */
export function servicesNote(results: ServiceResult[], env: Record<string, string | undefined>): string {
  if (!results.length) return ''
  const ready = results.filter(r => r.ok).map(r => r.name)
  const failed = results.filter(r => !r.ok)
  const parts: string[] = []
  if (ready.length) parts.push(`ready: ${ready.join(', ')}`)
  if (failed.length)
    parts.push(`failed: ${failed.map(f => `${f.name} (${f.detail}, see ${f.log})`).join('; ')}`)
  const dbLine = env.DATABASE_URL ? ' DATABASE_URL is set.' : ''
  return `\n\n[factory] services: ${parts.join('; ')}.${dbLine}`
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
export function asWorker() {
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
 * makes git ignore a worker's `.scratch/` dir, with no commit, in any rig repo (claude-factory-9wu). It adds
 * one line to the shared info/exclude file (`git rev-parse --git-common-dir`), so every worktree of the repo
 * shares it. It writes the line once: a line already there, from an earlier call or another worktree, stops
 * a second write. Outside a git repo (a test fixture with no .git), it does nothing.
 */
export function excludeScratch(dir: string) {
  const p = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (p.exitCode !== 0) return
  const common = p.stdout.toString().trim()
  const infoDir = join(common, 'info')
  mkdirSync(infoDir, { recursive: true })
  const file = join(infoDir, 'exclude')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.split('\n').some(line => line.trim() === '.scratch/')) return
  writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.scratch/\n`)
}

/** trust the egress gateway's CA (FACTORY_CA): write it and point every TLS client at it */
export function trustCA() {
  if (!process.env.FACTORY_CA) return
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

/**
 * A codex worker's CODEX_HOME, written at each start. It holds the files the laptop sent (cli.ts vmCodexHome)
 * AGENTS.md from this image's worker rules, and the image's skills (constitution I). It fails closed, as a pane's launch does (cli.ts codexWorker):
 * a .codex directory in the repo would add project config (all but the one `bd init` writes), and `codex features list` must show the guard on
 * (claude-factory-72dq).
 */
export function codexHome(dir = process.env.CODEX_HOME, timeoutMs = 30_000, plugins = VM_PLUGIN_DIRS) {
  if (harness() !== 'codex') return
  const files = process.env.FACTORY_CODEX_HOME_FILES
  if (!files || !dir)
    throw new Error('a codex worker needs FACTORY_CODEX_HOME_FILES and CODEX_HOME from the laptop')
  const local = join(repo(), '.codex')
  if (existsSync(local) && !beadsOnlyCodexDir(local))
    throw new Error(`a codex worker keeps the deny hook on: ${local} would add project config`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  for (const [name, text] of Object.entries(JSON.parse(files) as Record<string, string>))
    writeFileSync(join(dir, basename(name)), text, { mode: 0o600 })
  writeFileSync(
    join(dir, 'AGENTS.md'),
    readFileSync(join(import.meta.dir, 'worker-system.md'), 'utf8') +
      readFileSync(join(import.meta.dir, 'worker-codex.md'), 'utf8'),
  )
  codexSkills(dir, plugins)
  const p = Bun.spawnSync([process.env.FACTORY_CODEX ?? 'codex', ...CODEX_GUARD_FLAGS, 'features', 'list'], {
    env: { ...process.env, CODEX_HOME: dir },
    stdin: 'ignore',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  const bad = p.exitedDueToTimeout
    ? 'codex features list timed out'
    : p.exitCode !== 0
      ? 'codex features list failed'
      : codexFeaturesBad(p.stdout.toString())
  if (bad) throw new Error(`a codex worker keeps the deny hook on: the feature check failed (${bad})`)
}

/**
 * every start, since only the workspace survives a suspend: trust the egress gateway's CA (it decrypts all
 * HTTPS out) and clone the run's branch, retrying while the task's egress policy does not exist yet
 */
export async function setup({ tries = 60, waitMs = 5000 } = {}) {
  trustCA()
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
    rmSafe(repo(), { recursive: true, force: true })
    const r = sh(['git', 'clone', '--branch', process.env.FACTORY_BRANCH ?? 'main', remote, repo()])
    if (r.ok) {
      excludeScratch(repo())
      return
    }
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
  codexHome()
  const services = await startServices()
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
    session = await turnWithRetry(
      brief + servicesNote(services, process.env),
      model,
      undefined,
      onEgress,
      onSession,
      egress,
    )
  } else if (prior?.status === 'working') {
    // the VM stopped mid-turn (a restart, a suspend): say so, and name the call it cut off (claude-factory-p0yt)
    set('working')
    session = await turnWithRetry(resumeNote(session), model, session, onEgress, onSession, egress)
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

/**
 * Find the usage limit that ended a codex turn. Read the last turn.failed or error line of `codex exec --json`
 * output. It is a limit when the message says "You've hit your usage limit" (curly or plain apostrophe).
 * A later turn.completed, any other failure or a cut first line gives null. `at` is the time of the last write.
 */
export function codexLimit(out: string, at = Date.now()) {
  for (const line of out.split('\n').reverse()) {
    try {
      const e = JSON.parse(line)
      if (e.type === 'turn.completed') return null
      if (e.type !== 'turn.failed' && e.type !== 'error') continue
      const text = String(e.type === 'error' ? e.message : e.error?.message)
      return /hit your usage limit/i.test(text) ? { at, kind: 'usage', resetsAt: 0 } : null
    } catch {
      // not a JSON line: the cut first line of the tail
    }
  }
  return null
}

/** the usage limit in the last 64 KiB of the codex stream; null for another harness or no stream yet */
function codexLimitNow() {
  if (harness() !== 'codex') return null
  try {
    const file = join(own(), 'codex.jsonl')
    const { size, mtimeMs } = statSync(file)
    const buf = Buffer.alloc(Math.min(size, 64 * 1024))
    const fd = openSync(file, 'r')
    readSync(fd, buf, 0, buf.length, size - buf.length)
    closeSync(fd)
    return codexLimit(buf.toString(), mtimeMs)
  } catch {
    return null
  }
}

/** the laptop's view: the worker's state and the outbox past its cursor */
export function poll(cursor: number) {
  const s = state()
  const limit = codexLimitNow()
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
    ...(limit && { limit }),
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

/**
 * the turn a session resumed mid-turn gets first. Before it, a VM that restarted during the brief went idle
 * with nothing to do, and the run waited for its deadline (claude-factory-p0yt)
 */
export function resumeNote(session: string) {
  const call = harness() === 'claude' ? cutOffCall(transcriptTail(session)) : undefined
  return (
    `[factory] Your VM restarted and this session was resumed.${cutOffNote(call)} Carry on where you left off: ` +
    `check git status and git log first. When finished, report exactly once, as your brief says.`
  )
}

/** the end of a Claude session's transcript, else of the turn stream; empty when neither is there */
function transcriptTail(session: string) {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const file = join(dir, 'projects', repo().replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
  for (const f of [file, join(own(), 'claude.jsonl')]) {
    try {
      const size = statSync(f).size
      const buf = Buffer.alloc(Math.min(size, 512 * 1024))
      const fd = openSync(f, 'r')
      readSync(fd, buf, 0, buf.length, size - buf.length)
      closeSync(fd)
      return buf.toString()
    } catch {
      // not there: try the next
    }
  }
  return ''
}

export function prompt(base64: string) {
  mkdirSync(prompts(), { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`
  writeFileSync(join(prompts(), name), Buffer.from(base64, 'base64').toString())
}
