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

/** the platform's data dir for the factory: XDG_DATA_HOME, else ~/Library/Application Support on macOS, else ~/.local/share */
export function platformHome(
  env: Record<string, string | undefined>,
  platform: string,
  home: string,
): string {
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'claude-factory')
  return platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'claude-factory')
    : join(home, '.local', 'share', 'claude-factory')
}

/**
 * The default home: `fresh` (platformHome), unless only one of the `old` defaults holds a factory
 * (`has`: the dir has a rigs.json). Then that old dir, with a note that names the new path.
 */
export function defaultHome(
  fresh: string,
  old: string[],
  has: (dir: string) => boolean,
): { dir: string; note?: string } {
  if (has(fresh)) return { dir: fresh }
  const found = old.find(has)
  return found
    ? { dir: found, note: `factory: using the old default home ${found}; the new default is ${fresh}` }
    : { dir: fresh }
}

/**
 * The first arg is the factory dir, unless it starts with '-'.
 * Then use FACTORY_HOME if it is not empty, else `fallback` (the default home).
 * The other args go to the manager.
 */
export function upDir(
  args: string[],
  env: Record<string, string | undefined>,
  home: string,
  fallback: string,
): { dir: string; rest: string[] } {
  const first = args[0]
  const named = first !== undefined && first !== '' && !first.startsWith('-')
  const dir = named ? first : env.FACTORY_HOME || fallback
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
