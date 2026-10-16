// This is the Linear pull loop (claude-factory-b6c).
// The loop moves Linear issues from each opted-in rig to that rig's beads store.
//
// The loop uses the bd command `bd linear sync --pull-if-stale`.
// The loop must not use `--push`.
//
// The loop reads the API key, or the client ID and secret of an OAuth app, from the environment when it runs.
// The loop gets this value from a shell command that is set in `$FACTORY_HOME/linear.json`.
//
// The command is like the `token` command in devenv.json. For example, it can be an `op read` command.
// The loop must keep the value off disk, out of the command-line arguments, out of a log, out of a bead,
// and out of git.
import { existsSync, readFileSync } from 'node:fs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The argument of `--linear <team_id[,team_id]>`: one or more Linear team UUIDs. */
export function parseLinearTeams(spec: string): string[] {
  const ids = spec
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const bad = ids.find(id => !UUID.test(id))
  if (bad !== undefined) throw new Error(`--linear team id "${bad}" is not a UUID`)
  if (!ids.length) throw new Error('--linear needs at least one team UUID')
  return ids
}

/** `$FACTORY_HOME/linear.json` holds a command that prints the API key, or two commands that print an
 * OAuth app's client ID and client secret. It must not hold the literal value. Each run that reads a
 * value checks that the value does not have the shape of a Linear key. */
export type LinearConfig = { apiKey: string } | { clientId: string; clientSecret: string }

const LITERAL = /^(lin_api_|lin_oauth_)/
function asCommand(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`linear.json: "${name}" must be a non-empty command string`)
  if (LITERAL.test(value.trim()))
    throw new Error(`linear.json: "${name}" looks like a literal Linear key, not a command that prints one`)
  return value
}

export function readLinearConfig(file: string): LinearConfig {
  if (!existsSync(file)) throw new Error(`no ${file}: see docs/beads.md`)
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  if (cfg && typeof cfg === 'object' && 'apiKey' in cfg) return { apiKey: asCommand('apiKey', cfg.apiKey) }
  if (cfg && typeof cfg === 'object' && ('clientId' in cfg || 'clientSecret' in cfg))
    return { clientId: asCommand('clientId', cfg.clientId), clientSecret: asCommand('clientSecret', cfg.clientSecret) }
  throw new Error(`${file}: needs "apiKey", or "clientId" and "clientSecret", each a command that prints the value`)
}

const LINEAR_ENV_KEYS = ['LINEAR_API_KEY', 'LINEAR_OAUTH_CLIENT_ID', 'LINEAR_OAUTH_CLIENT_SECRET']

/** This function runs a `linear.json` command (like the `token` command in devenv.json). It returns the
 * trimmed output. It must not log the output. */
function resolve(cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
  if (p.exitCode !== 0)
    throw new Error(`linear.json command failed: ${p.stderr.toString().trim().split('\n')[0] || 'no output'}`)
  const out = p.stdout.toString().trim()
  if (!out) throw new Error('linear.json command printed nothing')
  return out
}

/**
 * This function makes the environment for the command `bd linear sync`.
 * It puts the resolved key, or the OAuth pair, only in environment variables.
 * It does not put them on disk, in the command-line arguments, or in a bead.
 *
 * A `LINEAR_*` variable from an earlier operation can stay in this environment.
 * The function removes each `LINEAR_*` variable first.
 * This makes sure that a stray OAuth pair cannot override the value in the rig's own `linear.json`.
 * Then it adds the new value from the rig's own `linear.json`.
 */
export function syncEnv(
  cfg: LinearConfig,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const stripped = Object.fromEntries(Object.entries(base).filter(([k]) => !LINEAR_ENV_KEYS.includes(k)))
  return 'apiKey' in cfg
    ? { ...stripped, LINEAR_API_KEY: resolve(cfg.apiKey) }
    : { ...stripped, LINEAR_OAUTH_CLIENT_ID: resolve(cfg.clientId), LINEAR_OAUTH_CLIENT_SECRET: resolve(cfg.clientSecret) }
}

/** This is the argv for `bd linear sync --pull-if-stale ...`. It pulls only, for the opted-in team IDs.
 * It must not include `--push` or the key. */
export const syncArgs = (teamIds: string[]): string[] => [
  'linear',
  'sync',
  '--pull-if-stale',
  '--threshold',
  '15m',
  '--team',
  teamIds.join(','),
  '--json',
]

export type SyncOutcome =
  | { fresh: true; lastPull?: string }
  | { fresh: false; pulled: number; created: number; updated: number }
  | { error: string }

/**
 * `bd linear sync --json` (bd 1.3.0) returns one of three shapes.
 *
 * The first shape is a skip. The sync did not run because the data is not stale.
 * It has the fields `is_fresh`, `skipped: true`, `last_pull`, and `age`.
 *
 * The second shape is a pull that ran.
 * It has `skipped: false` and a `stats` object with the fields `pulled`, `created`, `updated`, and more.
 *
 * The third shape is an engine error.
 * It has an `error` field and a nonzero exit code.
 *
 * A nonzero exit code that has none of these shapes is also an error.
 */
export function parseSync(stdout: string, exitCode: number): SyncOutcome {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return {
      error: exitCode === 0 ? 'bd linear sync: no JSON on stdout' : stdout.trim() || `bd linear sync exited ${exitCode}`,
    }
  }
  const j = json as Record<string, unknown>
  if (j?.error) return { error: String(j.error) }
  if (exitCode !== 0) return { error: `bd linear sync exited ${exitCode}` }
  if (j?.skipped) return { fresh: true, ...(j.last_pull !== undefined && { lastPull: String(j.last_pull) }) }
  const s = (j?.stats as Record<string, number>) ?? {}
  return { fresh: false, pulled: s.pulled ?? 0, created: s.created ?? 0, updated: s.updated ?? 0 }
}

/** This function removes each secret value from error text before the text goes into a log, a bead, or
 * mail. It then cuts the text to 200 characters when the text is longer than that. */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets.filter(Boolean)) out = out.split(s).join('***')
  return out.length > 200 ? `${out.slice(0, 200)}…` : out
}
