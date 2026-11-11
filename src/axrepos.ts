import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { bootstrapBeads } from './worker'

/**
 * Rig repos and beads stores for a manager inside the AX task (claude-factory-192.4). rigs.json holds the
 * laptop's paths; in the task each rig's working repo is a clone under a repos root of its own.
 */

type Env = Record<string, string | undefined>
type RigLike = { name: string; repo: string; remote?: string; beadsRemote?: { url: string; user: string } }

export const inAx = (env: Env = process.env) => env.FACTORY_IN_AX === '1'

/**
 * The runner name of a station. On the laptop it is the station's own, else the rig's, else the default.
 * In the AX manager a station never gets a local runner: a herdr pane there would sit next to the factory home.
 * A local name gives way to the rig's runner, else to the default if it is remote, else to `ax`.
 */
export function stationRunnerName(
  inVm: boolean,
  station: string | undefined,
  rig: string | undefined,
  dflt: string,
  isLocal: (name: string) => boolean,
) {
  const name = station ?? rig ?? dflt
  if (!inVm || !isLocal(name)) return name
  return [rig, dflt].find(n => n !== undefined && !isLocal(n)) ?? 'ax'
}

/** a worker address with no `scheme://` is a herdr pane id: in the AX manager it can only come from the laptop */
export const isLaptopPane = (inVm: boolean, pane: string | null | undefined) =>
  inVm && !!pane && !pane.includes('://')

/** an https remote a VM can clone: the egress gateway puts GitHub's credential in, and the VM has no ssh key */
export const httpsRemote = (url: string) => url.replace(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/, 'https://$1/')

/** claude-factory-v8iw: why a rig remote (after httpsRemote) must not go to git, else undefined. The reason never holds the URL */
export function remoteRefusal(url: string): string | undefined {
  if (!/^https:\/\/[\x21-\x7e]+$/.test(url) || !URL.canParse(url)) return 'it must be an https:// or git@ URL'
  if (/[@\\]/.test(url)) return 'it carries a user or password'
}

/** an https URL with no user or password: the egress gateway puts the credential in */
export const noUserinfo = (url: string) => url.replace(/^https:\/\/+[^/?#\\]*@/, 'https://')

export const reposRoot = (env: Env = process.env) => env.FACTORY_REPOS ?? '/workspace/w/repos'

/** where a rig's repo is in the task */
export const axRepoPath = (name: string, env: Env = process.env) => join(reposRoot(env), name)

/** the rigs as this process uses them: in the task, `repo` is the clone; on the laptop, as written */
export const mapRigs = <R extends RigLike>(rigs: R[], env: Env = process.env) =>
  inAx(env) ? rigs.map(r => ({ ...r, repo: axRepoPath(r.name, env) })) : rigs

/** a run's repo as written (a laptop path), to the clone of the rig that has that repo; an unknown path stays */
export function mapRunRepo(rigs: RigLike[], repo: string, env: Env = process.env) {
  const rig = inAx(env) ? rigs.find(r => r.repo === repo) : undefined
  return rig ? axRepoPath(rig.name, env) : repo
}

/**
 * The worktree of a run in the task. A run that the laptop made has a rig's laptop repo path (see mapRunRepo).
 * Its worktree is then `FACTORY_HOME/worktrees/<run id>`. A run made in the task keeps its own worktree.
 */
export function mapRunWorktree(
  rigs: RigLike[],
  run: { id: string; repo: string; worktree: string },
  env: Env = process.env,
) {
  const laptop = inAx(env) && rigs.some(r => r.repo === run.repo)
  return laptop ? join(env.FACTORY_HOME ?? '/workspace/w/home', 'worktrees', run.id) : run.worktree
}

/** a repo's beads store in the task: a directory of its own, as the worker keeps one (the repo's .beads names a laptop server) */
export const beadsDirOf = (home: string, repo: string) => join(home, 'beads', basename(repo))

/**
 * the env for a bd command in `repo`. On the laptop it is the env unchanged. In the task, once the rig's store
 * is bootstrapped, bd uses it (BEADS_DIR) and never the shared server, with the rig's Dolt remote user (written
 * by `repos sync`), like the worker's bd
 */
export function bdEnv(repo: string, env: Env = process.env) {
  const home = env.FACTORY_HOME
  if (!inAx(env) || !home) return env
  const dir = beadsDirOf(home, repo)
  if (!existsSync(join(dir, '.beads'))) return env
  let extra: Record<string, string> = {}
  try {
    extra = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'))
  } catch {}
  return {
    ...env,
    ...extra,
    BEADS_DOLT_SHARED_SERVER: '0',
    BD_NON_INTERACTIVE: '1',
    BEADS_DIR: join(dir, '.beads'),
  }
}

/**
 * claude-factory-d289.26: the env keys for a manager shell `bd` in the rig repo `top` (a git toplevel).
 * It gives nothing on the laptop, outside a rig's clone under the repos root, or before the rig's store exists.
 */
export function bdExports(top: string | undefined, env: Env = process.env): Record<string, string> {
  if (!top || !inAx(env)) return {}
  try {
    if (realpathSync(dirname(top)) !== realpathSync(reposRoot(env))) return {}
  } catch {
    return {}
  }
  const full = bdEnv(top, env)
  return Object.fromEntries(
    Object.entries(full).filter((e): e is [string, string] => e[1] !== undefined && env[e[0]] !== e[1]),
  )
}

/**
 * whether a rig's repo has beads. On the laptop that is the repo's own .beads. In the task a rig may keep no .beads
 * in git (its beads live on its beadsRemote), so a beadsRemote, or a store that `repos sync` made, counts too
 */
export function hasRigBeads(repo: string, rigs: RigLike[], env: Env = process.env) {
  if (existsSync(join(repo, '.beads'))) return true
  if (!inAx(env)) return false
  if (rigs.some(r => r.repo === repo && r.beadsRemote)) return true
  return !!env.FACTORY_HOME && existsSync(join(beadsDirOf(env.FACTORY_HOME, repo), '.beads'))
}

export type RepoStep =
  | { rig: string; path: string; do: 'clone'; url: string }
  | { rig: string; path: string; do: 'fetch' }
  | { rig: string; path: string; do: 'missing'; why: string }

/** what `repos sync` does for each rig: clone what is absent (https), fetch what is there, name a rig with no remote */
export function planRepoSync(
  rigs: RigLike[],
  exists: (path: string) => boolean,
  env: Env = process.env,
): RepoStep[] {
  return rigs.map(r => {
    const path = axRepoPath(r.name, env)
    if (exists(join(path, '.git'))) return { rig: r.name, path, do: 'fetch' }
    if (!r.remote)
      return { rig: r.name, path, do: 'missing', why: `rig ${r.name} has no "remote" in rigs.json` }
    const url = httpsRemote(r.remote)
    const why = remoteRefusal(url)
    if (why)
      return {
        rig: r.name,
        path,
        do: 'missing',
        why: `rig ${r.name}: the "remote" in rigs.json is refused: ${why}`,
      }
    return { rig: r.name, path, do: 'clone', url }
  })
}

// env: Bun gives a child its start env unless told; the host's trustCA() sets the git CA var at runtime
const run = (cmd: string[], cwd?: string) =>
  Bun.spawnSync(cmd, { cwd, env: { ...process.env }, stdin: 'ignore', timeout: 600_000 })
const errLine = (p: ReturnType<typeof run>) => p.stderr.toString().trim().split('\n').at(-1) ?? ''

/**
 * clone or fetch each rig's repo, then bootstrap its beads store the worker's way (BEADS_DOLT_SHARED_SERVER=0; from
 * the rig's beadsRemote, else from the GitHub origin's refs/dolt). Returns one line per problem; none means all is in place.
 * ponytail: rigs go one after the other, and a store bootstraps once: a later fetch does not refresh it (the beads pass pulls)
 */
export function syncRepos(rigs: RigLike[], home: string, env: Env = process.env) {
  const problems: string[] = []
  for (const step of planRepoSync(rigs, existsSync, env)) {
    if (step.do === 'missing') {
      problems.push(step.why)
      continue
    }
    mkdirSync(reposRoot(env), { recursive: true })
    const p =
      step.do === 'clone'
        ? run(['git', 'clone', '-q', '--', step.url, step.path])
        : run(['git', 'fetch', '-q', 'origin'], step.path)
    if (p.exitCode !== 0) {
      problems.push(`${step.rig}: git ${step.do}: ${errLine(p)}`)
      continue
    }
    const rig = rigs.find(r => r.name === step.rig)!
    if (!existsSync(join(step.path, '.beads')) && !rig.beadsRemote) continue
    try {
      const dir = beadsDirOf(home, step.path)
      const origin = run(['git', 'remote', 'get-url', 'origin'], step.path).stdout.toString().trim()
      const extra = rig.beadsRemote
        ? { DOLT_REMOTE_USER: rig.beadsRemote.user, DOLT_REMOTE_PASSWORD: 'placeholder' }
        : {}
      bootstrapBeads(dir, rig.beadsRemote?.url, httpsRemote(origin), { ...process.env, ...extra })
      writeFileSync(join(dir, 'env.json'), JSON.stringify(extra))
    } catch (e) {
      problems.push(`${step.rig}: beads: ${(e as Error).message}`)
    }
  }
  return problems
}
