import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isStale, type Lease } from './lease'

/** the Herdr app folder: $HERDR_APP_HOME, else ~/.config/herdr-app */
export const appHomeOf = (env: Record<string, string | undefined>) =>
  env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app')

/** what config.json holds. `machine` makes the mod a view and control client of a manager on that machine. */
export type ModConfig = { cli: string; home: string; machine?: string }

/** the defaults of a remote install: the factory CLI on the machine, and the home of the AX manager */
export const REMOTE_CLI = 'factory'
export const REMOTE_HOME = '/workspace/w/home'

/**
 * Why a local-mode install must refuse a home, or undefined. `remote` is the answer of ax.remoteManager():
 * the AX manager task lives. A live lease of kind "ax" shows the same.
 */
export function localRefusal(
  home: string,
  remote: string | undefined,
  lease: Lease | undefined,
  now: number,
) {
  const ax =
    remote ?? (lease?.kind === 'ax' && !isStale(lease, now, () => true) ? `lease ${lease.holder}` : undefined)
  return ax
    ? `the manager of ${home} runs in AX (${ax}). A local mod would start a second manager. Use: factory herdr install --machine <machine>`
    : undefined
}

/**
 * `factory herdr install` (claude-factory-s01d.3): copies the factory mod and its layout into the Herdr
 * app folder. It writes config.json beside the mod. The file names this CLI and this factory home.
 * With `machine`, the file names the manager machine too (claude-factory-hpmc.14).
 * A second install replaces the files. The app reloads the mod.
 */
export function install(repo: string, appHome: string, cfg: ModConfig) {
  const mod = join(appHome, 'mods', 'factory')
  mkdirSync(mod, { recursive: true })
  cpSync(join(repo, 'herdr', 'mods', 'factory'), mod, { recursive: true })
  writeFileSync(join(mod, 'config.json'), JSON.stringify(cfg, null, 2) + '\n')
  mkdirSync(join(appHome, 'layouts'), { recursive: true })
  cpSync(join(repo, 'herdr', 'layouts', 'factory.json'), join(appHome, 'layouts', 'factory.json'))
  return { mod, layout: join(appHome, 'layouts', 'factory.json') }
}
