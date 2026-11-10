// Who calls an operation: the worker rules. The CLI gives process.env. The server gives personEnv.
import { readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Env } from './catalog'

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
export const MAIN_CHAT_KINDS = ['decide', 'answer', 'owned', 'wiki-init', 'image', 'token'] as const

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
  return undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * claude-factory-6g6ud: the main chat's hook sets FACTORY_MAIN_CHAT on each model command. Under it, a gated kind needs the
 * one-time token the hook wrote at the person's Allow (FACTORY_ALLOW, a file in <home>/allow). Returns the refusal, else undefined.
 * ponytail: one Allow permits one gated call; upgrade path: a count per kind. The token file is renamed first, so two calls cannot both use it.
 */
export function mainChatRefusal(env: Env, home: string, kind: string): string | undefined {
  if (!env.FACTORY_MAIN_CHAT) return undefined
  const refuse = `factory ${kind} is the person's call: refused without the person's Allow (FACTORY_MAIN_CHAT is set). Ask the person to run it.`
  const token = env.FACTORY_ALLOW
  if (!token || !UUID.test(token)) return refuse
  const used = join(home, 'allow', `${token}.${process.pid}.used`)
  try {
    renameSync(join(home, 'allow', `${token}.json`), used)
    const body = readFileSync(used, 'utf8')
    unlinkSync(used)
    const t = JSON.parse(body) as { kinds?: unknown; exp?: unknown }
    if (Array.isArray(t.kinds) && t.kinds.includes(kind) && typeof t.exp === 'number' && t.exp > Date.now())
      return undefined
  } catch {
    // no file, a second use, a bad body: refuse
  }
  return refuse
}
