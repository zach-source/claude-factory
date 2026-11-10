// Who calls an operation: the worker rules. The CLI gives process.env. The server gives personEnv.
import { readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Env } from './catalog'
import { check } from './guards'

/**
 * claude-factory-5y7b: the env marker that says a worker runs this command, else undefined.
 * forMail skips FACTORY_FROM and FACTORY_RUN: the manager mails with FACTORY_FROM=manager (remote.test.ts) and a run worker mails its own station (run-scope.test.ts), so managerSender keeps its old three markers.
 * ponytail: env only. A cwd check for say, stop and start needs a scan of every run; the worker hook covers the rest.
 */
export function workerMarker(forMail = false, env: Env = process.env): string | undefined {
  return env.FACTORY_FROM && !forMail
    ? 'FACTORY_FROM is set'
    : env.FACTORY_RUN && !forMail
      ? 'FACTORY_RUN is set'
      : env.FACTORY_DEF_NAME
        ? 'FACTORY_DEF_NAME is set'
        : env.BEADS_ACTOR?.startsWith('factory/')
          ? 'BEADS_ACTOR names a factory worker'
          : undefined
}

/** the person and the manager run these verbs; a worker mails the manager instead. With patrol, a patrol (FACTORY_PATROL) must not run it either */
export function refuseWorker(env: Env, verb: string, patrol = false) {
  const marker = workerMarker(false, env)
  if (marker) throw new Error(`a worker cannot run factory ${verb} (${marker}): mail the manager instead`)
  if (patrol && env.FACTORY_PATROL)
    throw new Error(`a patrol cannot run factory ${verb}: leave it for the person or the manager`)
}

/** true when cwd is the run worktree or under it; false for a run whose worktree is its repo, or a path that does not resolve */
export function insideWorktree(run: { worktree?: string; repo?: string }, cwd: string): boolean {
  if (!run.worktree || run.worktree === run.repo) return false
  try {
    const wt = realpathSync(run.worktree)
    const real = realpathSync(cwd)
    return real === wt || real.startsWith(wt + sep)
  } catch {
    return false
  }
}

/**
 * claude-factory-ab8n: the sender for mail the manager posts (mail, poke and fork).
 * A worker has FACTORY_DEF_NAME, a factory/ BEADS_ACTOR, or a cwd inside its run's worktree.
 * It must not mail as the manager, because the owner-only rule trusts mail from the manager.
 * It returns 'manager' when no marker is present. Otherwise it throws and the caller posts nothing.
 */
export function managerSender(env: Env, cwd: string, run: { worktree?: string; repo?: string }): 'manager' {
  const marker =
    workerMarker(true, env) ??
    (insideWorktree(run, cwd) ? 'the working directory is inside the run worktree' : undefined)
  if (marker)
    throw new Error(`a worker cannot send mail as the manager (${marker}); a worker mails as its own station`)
  return 'manager'
}

/** claude-factory-6g6ud: the ids of the GATED_KINDS rows (mod/hooks/view.ts). A test keeps both lists equal. */
export const MAIN_CHAT_KINDS = [
  'decide',
  'answer',
  'owned',
  'wiki-init',
  'image',
  'token',
  'settings',
] as const

/** the gated kind a command does, else undefined. A closed table: `decisions propose` is not gated (the interview prompt runs it). */
export function mainChatKind(
  cmd: string | undefined,
  args: string[],
): (typeof MAIN_CHAT_KINDS)[number] | undefined {
  if (cmd === 'decide') return 'decide'
  if (cmd === 'decisions' && args[0] === 'answer') return 'answer'
  if (cmd === 'start' && args.includes('--owned')) return 'owned'
  if (cmd === 'wiki' && args.includes('init')) return 'wiki-init'
  if (cmd === 'image') return 'image'
  if (cmd === 'token' && args.length > 0 && args[0] !== 'list') return 'token'
  if (cmd === 'settings' && (args[0] === 'set' || args[0] === 'unset')) return 'settings'
  return undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** claude-factory-d289.25: an Allow for this turn token lives at most this long (the hook writes exp 30 min on) */
const TURN_ALLOW_MAX_MS = 30 * 60_000

type AllowToken = { kinds?: unknown; exp?: unknown; turn?: unknown }
const allows = (t: AllowToken, kind: string, now: number) =>
  Array.isArray(t.kinds) && t.kinds.includes(kind) && typeof t.exp === 'number' && t.exp > now

/**
 * claude-factory-6g6ud: the main chat's hook sets FACTORY_MAIN_CHAT on each model command. Under it, a gated kind needs the
 * token the hook wrote at the person's Allow (FACTORY_ALLOW, a file in <home>/allow). Returns the refusal, else undefined.
 * A one-time token is renamed first, so two calls cannot both use it.
 * claude-factory-d289.25: a token with turn: true (Allow for this turn) is read and kept, so it works for many calls of its kinds.
 * The hook empties its file when the turn ends; an empty file or a past exp refuses. An exp over 30 min away refuses too.
 */
export function mainChatRefusal(env: Env, home: string, kind: string): string | undefined {
  if (!env.FACTORY_MAIN_CHAT) return undefined
  const refuse = `factory ${kind} is the person's call: refused without the person's Allow (FACTORY_MAIN_CHAT is set). Ask the person to run it.`
  const token = env.FACTORY_ALLOW
  if (!token || !UUID.test(token)) return refuse
  const file = join(home, 'allow', `${token}.json`)
  try {
    const peek = JSON.parse(readFileSync(file, 'utf8')) as AllowToken
    if (peek.turn === true) {
      const now = Date.now()
      return allows(peek, kind, now) && (peek.exp as number) <= now + TURN_ALLOW_MAX_MS ? undefined : refuse
    }
  } catch {
    // no file, an empty file or a bad body: the one-time path below refuses it
  }
  const used = join(home, 'allow', `${token}.${process.pid}.used`)
  try {
    renameSync(file, used)
    const body = readFileSync(used, 'utf8')
    unlinkSync(used)
    if (allows(JSON.parse(body) as AllowToken, kind, Date.now())) return undefined
  } catch {
    // no file, a second use, a bad body: refuse
  }
  return refuse
}

/**
 * claude-factory-y3f8w.5: what the Claude patrol-guard hook refuses for the factory CLI, now in core.
 * Under FACTORY_PATROL a patrol (any harness) cannot run a gated kind, install or reject a skill or proposal,
 * or answer a decision. The Claude hook stays as a second layer. Returns the refusal, else undefined.
 */
const OWN_REFUSAL = new Set(['decide', 'answer', 'owned', 'image'])
export function patrolRefusal(cmd: string | undefined, args: string[], env: Env): string | undefined {
  if (!env.FACTORY_PATROL) return undefined
  // these four keep their own refusals in the command (claude-factory-72v.19)
  const gated = mainChatKind(cmd, args)
  const kind =
    (gated && OWN_REFUSAL.has(gated) ? undefined : gated) ??
    ((cmd === 'skills' || cmd === 'proposals') && (args[0] === 'install' || args[0] === 'reject')
      ? `${cmd} ${args[0]}`
      : undefined)
  return kind
    ? `a patrol cannot run factory ${kind}: leave it for the person or the manager (FACTORY_PATROL is set)`
    : undefined
}

const BARE = /^[A-Za-z0-9_./:=,@%+-]+$/
const quoted = (a: string) => (BARE.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)

/**
 * The bd shim of a patrol (claude-factory-y3f8w.5): the same rule as the hook's bd check, on the argument list.
 * A harness with no hook (codex) gets a `bd` that runs this first. Best-effort, as bdWrite is: a call by absolute path is not seen.
 */
export function patrolBdRefusal(args: string[]): string | undefined {
  const v = check(`bd ${args.map(quoted).join(' ')}`, 'subagent')
  return v.decision === 'allow' ? undefined : v.reason
}
