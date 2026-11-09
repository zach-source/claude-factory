// Who calls an operation: the worker rules. The CLI gives process.env. The server gives personEnv.
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
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
