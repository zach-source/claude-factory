// The rule body stays in the mod until hpmc.9. The mod cannot import src/.
import { INSTALL_VERB, META_WRITE, bdWrite, gatedCommand } from '../../mod/hooks/view'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { insideOf, realPath } from '../token-guard'
export { INSTALL_VERB, META_WRITE, PATROL_VERB, bdWrite, gatedCommand } from '../../mod/hooks/view'

export type Role = 'manager' | 'subagent'
export type Verdict =
  | { decision: 'allow' }
  | { decision: 'ask'; question: string; reason: string }
  | { decision: 'deny'; reason: string }

export const GRAMMAR_REASON = 'The server patrol accepts only literal factory and bd commands.'
export const SECRET_PATH_REASON = 'The server patrol cannot access secret paths or their ancestors.'
export const TOOL_REASON = 'The server patrol received an invalid tool call.'
export const SERVER_VERBS: ReadonlySet<string> = new Set([
  'status',
  'mail',
  'poke',
  'retry',
  'goto',
  'abort',
  'fork',
  'rm',
  'start',
  'queue',
  'backlog',
  'waiting',
  'home',
  'memory',
  'rig',
  'file-elsewhere',
])
const SECRET_ROOTS = ['/etc/factory', '/run/secrets', '/var/run/secrets', '/proc']
const SECRET_ANCESTORS = new Set(
  SECRET_ROOTS.flatMap(root => {
    const paths = [root]
    while (dirname(root) !== root) {
      root = dirname(root)
      paths.push(root)
    }
    return paths
  }),
)

export function secretPath(abs: string): boolean {
  return SECRET_ANCESTORS.has(abs) || SECRET_ROOTS.some(root => abs.startsWith(root + sep))
}

const hit = (p: string) => {
  const abs = resolve(p)
  const real = realPath(abs)
  return secretPath(abs) || (real !== undefined && secretPath(real))
}

export function serverBashReason(
  command: string,
  cwd: string | undefined,
  cli: string,
  run: typeof check = check,
): string | undefined {
  if (!cwd || !isAbsolute(cwd) || hit(cwd) || realPath(cwd) === undefined) return SECRET_PATH_REASON
  const words: string[] = []
  let word = ''
  let started = false
  let quote = ''
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = ''
      else {
        if (quote === '"' && /[$`\\!]/.test(c)) return GRAMMAR_REASON
        word += c
      }
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === ' ' || c === '\t') {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      if (!/[A-Za-z0-9_./:=@%+,-]/.test(c)) return GRAMMAR_REASON
      word += c
      started = true
    }
  }
  if (quote) return GRAMMAR_REASON
  if (started) words.push(word)
  const [exe, verb, ...args] = words
  if (exe !== 'factory' && exe !== cli && exe !== 'bd') return GRAMMAR_REASON
  if (exe !== 'bd') {
    if (!verb || !SERVER_VERBS.has(verb)) return GRAMMAR_REASON
    if (verb === 'memory' && args[0] !== 'search' && args[0] !== 'add') return GRAMMAR_REASON
    if (verb === 'rig' && !(args.length === 0 || (args.length === 1 && args[0] === 'list')))
      return GRAMMAR_REASON
    if (verb === 'start' || verb === 'queue') {
      const name = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
      const exists = (v: string) => lstatSync(resolve(cwd, v), { throwIfNoEntry: false }) !== undefined
      if (verb === 'queue') {
        if (args.length !== 1 || !name.test(args[0]!) || exists(args[0]!)) return GRAMMAR_REASON
      } else {
        const parts = (args[0] ?? '').split('@')
        if (
          args.length < 2 ||
          args.length > 3 ||
          parts.length > 2 ||
          !parts.every(p => name.test(p)) ||
          !name.test(args[1]!) ||
          exists(parts[0]!) ||
          exists(args[1]!)
        )
          return GRAMMAR_REASON
      }
    }
  }
  for (const arg of words.slice(1)) {
    const values = [arg]
    if (arg.includes('=')) values.push(arg.slice(arg.indexOf('=') + 1))
    if (/^-[A-Za-z].+/.test(arg)) values.push(arg.slice(2))
    // ponytail: an argument with a symlink loop passes. The Read hook and OS barrier must cover it.
    if (values.some(v => hit(resolve(cwd, v)))) return SECRET_PATH_REASON
  }
  const result = run(command, 'subagent')
  return result.decision === 'deny' ? result.reason : undefined
}

export function serverToolReason(
  tool: string,
  input: unknown,
  cwd: string | undefined,
  factoryHome: string | undefined,
): string | undefined {
  if (!input || typeof input !== 'object' || !cwd || !isAbsolute(cwd)) return TOOL_REASON
  const fields = input as Record<string, unknown>
  if (!['Read', 'Grep', 'Glob', 'Write'].includes(tool)) return TOOL_REASON
  const raw = tool === 'Read' || tool === 'Write' ? fields.file_path : fields.path
  if (
    (raw !== undefined && typeof raw !== 'string') ||
    ((tool === 'Read' || tool === 'Write') && raw === undefined) ||
    (tool === 'Glob' && typeof fields.pattern !== 'string')
  )
    return TOOL_REASON
  const path = raw as string | undefined
  if (tool === 'Write') {
    if (!factoryHome || !isAbsolute(factoryHome)) return TOOL_REASON
    const root = join(factoryHome, 'text')
    if (resolve(cwd, path!) === root || !insideOf(root)(path!, cwd))
      return `In the server, the patrol writes only under ${factoryHome}/text/.`
    return undefined
  }
  if (tool === 'Glob') {
    const pattern = fields.pattern as string
    if (!/^[A-Za-z0-9_.*?-][A-Za-z0-9_.*?/-]*$/.test(pattern) || pattern.split('/').includes('..'))
      return SECRET_PATH_REASON
  }
  const abs = resolve(cwd, path ?? '.')
  if (hit(abs) || realPath(abs) === undefined) return SECRET_PATH_REASON
  return undefined
}

export function check(command: string, role: Role): Verdict {
  const gated = gatedCommand(command)
  if (role === 'manager') {
    if (!gated) return { decision: 'allow' }
    return gated.ask
      ? { decision: 'ask', question: gated.question, reason: gated.deny }
      : { decision: 'deny', reason: gated.deny }
  }
  if (gated)
    return { decision: 'deny', reason: `${gated.deny} A patrol never decides this: leave it for the person.` }
  const joined = command.replace(/\\\n/g, '')
  if (INSTALL_VERB.test(joined))
    return {
      decision: 'deny',
      reason:
        'a subagent never installs or rejects a skill or proposal: only the manager or the person installs',
    }
  if (META_WRITE.test(joined)) return { decision: 'deny', reason: 'a subagent never writes bead metadata' }
  if (bdWrite(joined))
    return {
      decision: 'deny',
      reason:
        'a subagent runs bd only as bd show|view|list|ready|search|children|comments|comment|undefer, with the verb first. Never pass --actor, --author or -a, and never set BEADS_ACTOR: they set the comment author. Write a bd command in literal words with bd as its first word: no $, backtick, glob, brace, # or <. Put other comment text in a file: bd comments add <id> -f <file>',
    }
  return { decision: 'allow' }
}
