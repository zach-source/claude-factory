// Who calls an operation: the worker rules. The CLI gives process.env. The server gives personEnv.
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
