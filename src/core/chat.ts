// The manager chat of the core: one conversation file for each id, one model turn at a time.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { line } from '../../mod/hooks/view'
import { appendUsage, type ModelResult } from '../once'
import { stepPrompt } from '../steps'
import { inProc, type Ctx, type RunResult, type Port } from './catalog'
import { refuseWorker } from './caller'
import { check } from './guards'

/** the same file as CLI in src/cli.ts */
export const CLI = join(import.meta.dir, '..', '..', 'bin', 'factory')

export type Front = 'cli' | 'web' | 'claude-mod' | 'herdr-mod'
export type Turn = {
  who: 'person' | 'manager'
  text: string
  front: Front
  at: number
  /** the Bash commands that the model tried, with their tool_use ids; a refused command is in it too */
  commands?: { id: string; command: string }[]
  /** the commands of `commands` that need the person's approval */
  asks?: { id: string; question: string }[]
  /** the tool_use id of the ask that the person approved for this turn */
  approve?: string
  ran?: { id: string; command: string; code: number; out: string }
  session?: string
  error?: string
  reason?: string
}

/** the session goes into argv after --resume: the first character cannot be '-' */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export async function runApproved(
  _c: Parameters<Port['chatRun']>[0],
): Promise<{ code: number; out: string }> {
  throw new Error('not built')
}

export function conversationFile(home: string, id: string): string {
  if (!CONVERSATION.test(id)) throw new Error(`bad conversation id: ${line(id, 40)}`)
  return join(home, 'conversations', `${id}.jsonl`)
}

function readTurns(path: string): Turn[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(l => {
      try {
        const t = JSON.parse(l)
        const good = t && typeof t === 'object' && (t.who === 'person' || t.who === 'manager')
        return good && typeof t.text === 'string' ? [t as Turn] : []
      } catch {
        return [] // a half-written line: skip it
      }
    })
}

const sessionOf = (turns: Turn[]): string | null =>
  turns
    .filter(t => t.who === 'manager')
    .map(t => t.session)
    .reverse()
    .find((s): s is string => typeof s === 'string' && SESSION.test(s)) ?? null

export function show(home: string, id: string): { id: string; session: string | null; turns: Turn[] } {
  const turns = readTurns(conversationFile(home, id))
  return { id, session: sessionOf(turns), turns }
}

/** the tail of each conversation's queue; an entry leaves the map when its turn is the last one */
export const queue = new Map<string, Promise<void>>()

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const HASH = /^[0-9a-f]{64}$/
const SOCK = /^\/[A-Za-z0-9._/-]{1,100}$/

const PUB = /^[0-9a-f]{88}$/
const NONCE = /^[0-9a-f]{32}$/

/**
 * the one-use count of an approval, in this process. The hook sends `<hash> <nonce>`; the first right hash gets
 * `yes <signature>` over `<hash> <nonce> yes`. The private key stays in this process, the public key goes in the hook argv:
 * a model that replaces the socket cannot sign, and a captured answer fails on the next nonce.
 */
function approvalServer(hash: string): Promise<{ path: string; server: Server; pub: string }> {
  const path = join(tmpdir(), `fcg-${randomBytes(12).toString('hex')}.sock`)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
  let used = false
  const server = createServer(c => {
    c.setEncoding('utf8')
    c.once('data', d => {
      const [h, n, ...rest] = String(d).trim().split(' ')
      if (used || h !== hash || !NONCE.test(n ?? '') || rest.length) return void c.end('no')
      used = true
      c.end(`yes ${sign(null, Buffer.from(`${h} ${n} yes`), privateKey).toString('hex')}`)
    })
    c.on('error', () => {})
  })
  return new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(path, () => res({ path, server, pub }))
  })
}

/** ask the core for the one use; any failure, or an answer without the core's signature, is no */
const askUse = (path: string, hash: string, pub: string) =>
  new Promise<boolean>(res => {
    const nonce = randomBytes(16).toString('hex')
    let out = ''
    const c = connect(path)
    c.setEncoding('utf8')
    c.setTimeout(5000, () => c.destroy())
    c.on('data', d => (out += d))
    c.on('error', () => res(false))
    c.on('close', () => {
      const m = /^yes ([0-9a-f]{128})$/.exec(out)
      try {
        const key = createPublicKey({ key: Buffer.from(pub, 'hex'), format: 'der', type: 'spki' })
        res(!!m && verify(null, Buffer.from(`${hash} ${nonce} yes`), key, Buffer.from(m[1]!, 'hex')))
      } catch {
        res(false)
      }
    })
    c.write(`${hash} ${nonce}`)
  })

/** a model can leave a half line: write a newline first, so the next turn stays readable */
const append = (path: string, t: Turn) => {
  let pre = ''
  if (existsSync(path) && statSync(path).size > 0) {
    const b = readFileSync(path)
    if (b[b.length - 1] !== 10) pre = '\n'
  }
  appendFileSync(path, pre + JSON.stringify(t) + '\n')
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object'

/** the command that the person approves: the ask `id` of the last manager turn; throws a refusal */
function approved(turns: Turn[], id: string): string {
  const last = turns.filter(t => t.who === 'manager').at(-1)
  if (!last) throw new Error('the approval is refused: the conversation has no manager turn')
  const list = (x: unknown) => (Array.isArray(x) ? x.filter(isObj) : [])
  const ask = list(last.asks).find(e => e.id === id && typeof e.question === 'string')
  if (!ask) throw new Error(`the approval is refused: the last manager turn has no ask ${id}`)
  const cmd = list(last.commands).find(e => e.id === id && typeof e.command === 'string')
  if (!cmd) throw new Error(`the approval is refused: the last manager turn has no command ${id}`)
  const command = cmd.command as string
  const v = check(command, 'manager')
  if (v.decision === 'deny') throw new Error('the approval is refused: the command is denied')
  if (v.decision === 'allow') throw new Error('the approval is refused: the command needs no approval')
  if (v.question !== ask.question)
    throw new Error('the approval is refused: the question does not match the command')
  return command
}

export function send(
  ctx: Ctx,
  a: { id: string; text: string; front: Front; approve?: string },
): Promise<RunResult> {
  return inProc(async print => {
    refuseWorker(ctx.env, 'chat', true)
    const path = conversationFile(ctx.home, a.id)
    const turn = async (): Promise<Turn> => {
      const turns = readTurns(path)
      const session = sessionOf(turns)
      const command = a.approve === undefined ? undefined : approved(turns, a.approve)
      mkdirSync(join(ctx.home, 'conversations'), { recursive: true })
      let hook = `'${CLI}' chat-guard`
      let server: Server | undefined
      if (command !== undefined) {
        const hash = sha(command)
        const s = await approvalServer(hash)
        server = s.server
        hook += ` ${hash} ${s.path} ${s.pub}`
      }
      try {
        append(path, {
          who: 'person',
          text: a.text,
          front: a.front,
          at: Date.now(),
          ...(a.approve === undefined ? {} : { approve: a.approve }),
        })
        const guard = { type: 'command', command: hook }
        let res: ModelResult
        try {
          res = await ctx.port.chatModel({
            system: stepPrompt('chat', { cli: CLI }),
            input:
              command === undefined
                ? a.text
                : `${a.text}\n\nThe person approved one run of this exact command in this turn:\n${command}`,
            model: 'claude-opus-5-5',
            tools: 'Bash,Read,Grep,Glob,Write',
            maxTurns: 40,
            settings: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [guard] }] } },
            baseEnv: ctx.env,
            env: { FACTORY_HOME: ctx.home, FACTORY_MAIN_CHAT: '1' },
            cwd: ctx.home,
            timeoutMs: 15 * 60_000,
            persist: true,
            ...(session ? { resume: session } : {}),
          })
        } catch (e) {
          res = {
            isOk: false,
            text: '',
            error: line(String(e), 300),
            reason: 'spawn-failed',
            durationMs: 0,
            commands: [],
            calls: [],
          }
        }
        const asks = res.calls.flatMap(c => {
          const v = check(c.command, 'manager')
          return v.decision === 'ask' ? [{ id: c.id, question: v.question }] : []
        })
        const out: Turn = {
          who: 'manager',
          text: res.text,
          front: a.front,
          at: Date.now(),
          commands: res.calls,
          asks,
          ...(res.session && SESSION.test(res.session) ? { session: res.session } : {}),
          ...(res.isOk ? {} : { error: res.error ?? 'the model failed', reason: res.reason }),
        }
        append(path, out)
        appendUsage(ctx.home, 'chat', res.usage)
        return out
      } finally {
        server?.close()
      }
    }
    // the stored tail never rejects: a failed turn reaches only its own caller
    const run = (queue.get(path) ?? Promise.resolve()).then(turn)
    const tail = run.then(
      () => {},
      () => {},
    )
    queue.set(path, tail)
    void tail.then(() => {
      if (queue.get(path) === tail) queue.delete(path)
    })
    const out = await run
    print(JSON.stringify(out))
    if (out.error) throw new Error(`the manager turn failed: ${out.error}`)
  })
}

/**
 * the body of `factory chat-guard [<sha256> <socket> <public key>]`: every result but allow gives code 2.
 * The three words are the approval of one asked command: the core process counts the use on its socket and signs its answer.
 * ponytail: a model that runs a script can still kill the core's socket (a denial only) or relay one hook to it. Upgrade: the sandbox (see claude-factory-xrbpw).
 */
export async function guardHook(stdin: string, args: string[] = []): Promise<{ code: number; err: string }> {
  const bad =
    args.length !== 0 &&
    !(args.length === 3 && HASH.test(args[0]!) && SOCK.test(args[1]!) && PUB.test(args[2]!))
  if (bad) return { code: 2, err: 'bad chat-guard arguments\n' }
  let command: unknown
  try {
    command = JSON.parse(stdin)?.tool_input?.command
  } catch {}
  if (typeof command !== 'string') return { code: 2, err: 'the hook input has no Bash command\n' }
  const v = check(command, 'manager')
  if (v.decision === 'allow') return { code: 0, err: '' }
  if (v.decision === 'deny') return { code: 2, err: v.reason + '\n' }
  if (args.length === 3 && sha(command) === args[0] && (await askUse(args[1]!, args[0]!, args[2]!)))
    return { code: 0, err: '' }
  return {
    code: 2,
    err: `${v.question}\nthe person must approve this command; a chat turn cannot run it: tell the person\n`,
  }
}
