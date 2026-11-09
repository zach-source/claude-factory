import { join, resolve } from 'node:path'

/** Name each missing tool as an error. Add a warning outside herdr. This function has no side effects. */
export function upCheck(
  has: (tool: string) => boolean,
  env: Record<string, string | undefined>,
): { errors: string[]; warnings: string[] } {
  const errors = ['bun', 'claude'].filter(t => !has(t)).map(t => `${t} not on PATH`)
  // The manager drives herdr panes for its workers. Outside herdr it can still run, but workers have nowhere to go.
  const warnings =
    env.HERDR_ENV === '1' ? [] : ['factory up: not in a herdr pane; start herdr first so workers get panes']
  return { errors, warnings }
}

/**
 * The first arg is the factory dir, unless it starts with '-'.
 * Then use FACTORY_HOME if it is not empty, else ~/factory.
 * The other args go to the manager.
 */
export function upDir(
  args: string[],
  env: Record<string, string | undefined>,
  home: string,
): { dir: string; rest: string[] } {
  const first = args[0]
  const named = first !== undefined && first !== '' && !first.startsWith('-')
  const dir = named ? first : env.FACTORY_HOME || join(home, 'factory')
  return {
    dir: resolve(dir.replace(/^~(?=\/|$)/, home)),
    rest: named ? args.slice(1) : args,
  }
}

/** true when root is in the read-only Nix store: there the package ships node_modules, and nothing may write */
export const inStore = (root: string): boolean => root.startsWith('/nix/store/')

// ponytail: reinstall only when there is no node_modules or the lockfile is newer
export const needsInstall = (nodeModulesMtime: number | undefined, lockMtime: number): boolean =>
  nodeModulesMtime === undefined || lockMtime > nodeModulesMtime
