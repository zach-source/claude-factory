import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** the Herdr app folder: $HERDR_APP_HOME, else ~/.config/herdr-app */
export const appHomeOf = (env: Record<string, string | undefined>) =>
  env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app')

/**
 * `factory herdr install` (claude-factory-s01d.3): copies the factory mod and its layout into the Herdr
 * app folder. It writes config.json beside the mod. The file names this CLI and this factory home.
 * A second install replaces the files. The app reloads the mod.
 */
export function install(repo: string, appHome: string, cli: string, home: string) {
  const mod = join(appHome, 'mods', 'factory')
  mkdirSync(mod, { recursive: true })
  cpSync(join(repo, 'herdr', 'mods', 'factory'), mod, { recursive: true })
  writeFileSync(join(mod, 'config.json'), JSON.stringify({ cli, home }, null, 2) + '\n')
  mkdirSync(join(appHome, 'layouts'), { recursive: true })
  cpSync(join(repo, 'herdr', 'layouts', 'factory.json'), join(appHome, 'layouts', 'factory.json'))
  return { mod, layout: join(appHome, 'layouts', 'factory.json') }
}
