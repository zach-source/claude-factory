// `factory devenv`: builds each AX rig's devenv where Nix can build (an amd64 buildx builder; local Nix builds
// fail under the VMs' gVisor) and pushes its closure to the rig's binary cache (FACTORY_NIX_CACHE), which the
// VM's worker loads it from. A rig is rebuilt when its devenv files or the worker image change.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO, parseEgress, type Egress } from './ax'
import { rmQuiet } from './home-guard'
import { SECRETS, hideSecret } from './secrets'

/**
 * `$FACTORY_HOME/devenv.json`: the builder (a buildx builder name, or the address of a BuildKit daemon where
 * buildx is missing), a command printing the cache's push token, and the shell the build runs to push $ROOTS
 * with that token at /run/secrets/cache (`attic push ...`, say). The optional `githubToken` is a command that
 * prints a GitHub token for Nix; when it prints nothing, Nix fetches without a token.
 */
export type DevenvConfig = { builder: string; token: string; push: string; githubToken?: string }

/** the fields of devenv.json that are absent, not a string or empty */
export const configMissing = (cfg: Record<string, unknown>) =>
  (['builder', 'token', 'push'] as const).filter(f => typeof cfg[f] !== 'string' || cfg[f] === '')

export type Stamp = { key: string; ok: boolean; at: number; rev: string; why?: string }

/** what a devenv's derivations depend on that a rig's repo changes: its devenv files, as git blobs */
export const DEVENV_FILES = ['devenv.nix', 'devenv.yaml', 'devenv.lock']

/**
 * the build's identity: the devenv files' blobs and the worker image, whose devenv and Nix evaluate them.
 * ponytail: a devenv.nix that imports other files of the repo misses their changes; hash those too if one does
 */
export const cacheKey = (blobs: string, image: string) =>
  createHash('sha256').update(`${image}\n${blobs}`).digest('hex').slice(0, 16)

/** whether a rig needs a build: never built, built from other files or another image, or the last build failed */
export const isDue = (stamp: Stamp | undefined, key: string, force = false) =>
  force || stamp?.key !== key || !stamp.ok

// at REPO, the path the VM clones to: a devenv's derivations depend on its root. The source is a named build
// context mounted from `src`, so the rig's .dockerignore does not apply. REPO gets a fresh git commit of it,
// the same checkout devenv sees in a clone. A GitHub token (optional) goes to Nix only.
export const DOCKERFILE = `# syntax=docker/dockerfile:1
ARG IMAGE
FROM \${IMAGE}
ARG REV
ARG PUSH
ARG KEY
RUN --mount=type=secret,id=cache,required=true --mount=type=secret,id=github,required=false --mount=type=bind,from=src,target=/src <<'EOF'
set -eu
echo "devenv $KEY"
mkdir -p ${REPO} && cp -a /src/. ${REPO}/ && cd ${REPO}
git init -q && git add -f -A
git -c user.name=factory -c user.email=factory@localhost commit -q -m "$REV"
if [ -s /run/secrets/github ]; then export NIX_CONFIG="access-tokens = github.com=$(cat /run/secrets/github)"; fi
devenv print-dev-env > /tmp/env.sh 2> /tmp/devenv.log || { tail -40 /tmp/devenv.log; exit 1; }
ROOTS=$(for r in .devenv/gc/* .devenv/profile; do [ -e "$r" ] && readlink -f "$r"; done | sort -u | tr '\\n' ' ')
export ROOTS
echo "roots: $ROOTS"
sh -euc "$PUSH"
EOF
`

/** a command that is not on PATH fails like one that exits non-zero: spawnSync throws for it (no docker on the VM) */
export const run = (cmd: string[], o: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
  try {
    const p = Bun.spawnSync(cmd, { ...o, stdout: 'pipe', stderr: 'pipe' })
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
  } catch (e) {
    return { ok: false, out: '', err: String(e) }
  }
}

/** the rig's default branch as the VMs start from it, freshly fetched, with its devenv files' blobs */
export function remoteDevenv(repo: string) {
  const head =
    run(['git', '-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out || 'origin/main'
  run(['git', '-C', repo, 'fetch', '--quiet', 'origin'])
  const rev = run(['git', '-C', repo, 'rev-parse', head]).out
  const blobs = run(['git', '-C', repo, 'ls-tree', rev, '--', ...DEVENV_FILES]).out
  return { rev, blobs, hasDevenv: /\tdevenv\.nix$/m.test(blobs) }
}

/** the files of `rev` at `dir`: from a private index, so export-ignore and the rig's worktree do not matter */
export function checkout(repo: string, rev: string, dir: string, tmp: string) {
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') }
  const r = run(['git', '-C', repo, 'read-tree', rev], { env })
  if (!r.ok) return r
  return run(['git', '-C', repo, 'checkout-index', '-a', `--prefix=${dir}/`], { env })
}

type Job = { cfg: DevenvConfig; image: string; rev: string; key: string; force?: boolean }
type Paths = { ctx: string; src: string; ca: string }

/** the build command: docker buildx where it exists, else buildctl (`prefix` runs it, `nix shell ...`, say) */
export function buildCommand(j: Job, p: Paths, o: { buildx: boolean; github: boolean; prefix?: string[] }) {
  const args = [`IMAGE=${j.image}`, `REV=${j.rev}`, `PUSH=${j.cfg.push}`, `KEY=${j.key}`]
  const secrets = [
    'id=cache,env=FACTORY_DEVENV_CACHE',
    ...(o.github ? ['id=github,env=FACTORY_DEVENV_GH'] : []),
  ]
  if (o.buildx)
    return [
      ...['docker', 'buildx', 'build', '--builder', j.cfg.builder, '--platform', 'linux/amd64'],
      ...['--progress', 'plain', '--build-context', `src=${p.src}`],
      ...args.flatMap(a => ['--build-arg', a]),
      ...secrets.flatMap(s => ['--secret', s]),
      ...(j.force ? ['--no-cache'] : []),
      ...['--output', 'type=cacheonly', p.ctx],
    ]
  return [
    ...(o.prefix ?? []),
    ...['buildctl', '--addr', j.cfg.builder, '--tlscacert', p.ca, 'build'],
    ...['--frontend', 'dockerfile.v0', '--progress', 'plain'],
    ...['--local', `context=${p.ctx}`, '--local', `dockerfile=${p.ctx}`, '--local', `src=${p.src}`],
    ...['--opt', 'context:src=local:src', '--opt', 'platform=linux/amd64'],
    ...args.flatMap(a => ['--opt', `build-arg:${a}`]),
    ...secrets.flatMap(s => ['--secret', s]),
    ...(j.force ? ['--no-cache'] : []),
  ]
}

/** the CA bundle for buildctl and Nix: the system bundle plus the egress CA (FACTORY_CA, PEM text) */
const caBundle = (env: Record<string, string | undefined>) => {
  const sys = [env.SSL_CERT_FILE, env.NIX_SSL_CERT_FILE, '/etc/ssl/certs/ca-certificates.crt'].find(
    f => f && existsSync(f),
  )
  return `${sys ? readFileSync(sys, 'utf8') : ''}\n${env.FACTORY_CA ?? ''}\n`
}

/**
 * A Docker config with a placeholder login for ghcr.io. buildctl sends it as Basic to ghcr.io/token, and the egress
 * gateway swaps in the real login (managerEgress). The file holds no secret.
 */
export function writeGhcrConfig(dir: string) {
  mkdirSync(dir, { recursive: true })
  const auth = Buffer.from('placeholder:placeholder').toString('base64')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ auths: { 'ghcr.io': { auth } } }))
  return dir
}

/** one line of a command's stderr for a reason: the first, hidden when it looks like a secret */
const firstLine = (t: string) => hideSecret(t.split('\n')[0] ?? '')

/**
 * builds one rig's devenv and pushes it; the log, whose secrets the build never prints, goes to `log`.
 * The tokens reach the build only as BuildKit secrets, from this process's env. A reason that is not the build's
 * own output goes to the log too, so `see log` is true
 */
export function build(
  cfg: DevenvConfig,
  a: { image: string; repo: string; rev: string; key: string; log: string; force?: boolean },
) {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-devenv-'))
  const bad = (why: string) => (writeFileSync(a.log, `${why}\n`), { ok: false, why })
  try {
    const paths = { ctx: join(tmp, 'ctx'), src: join(tmp, 'src'), ca: join(tmp, 'ca.pem') }
    mkdirSync(paths.ctx)
    mkdirSync(paths.src)
    writeFileSync(join(paths.ctx, 'Dockerfile'), DOCKERFILE)
    const token = run(['sh', '-c', cfg.token])
    if (!token.ok) return bad(`tokens: token command failed: ${firstLine(token.err)}`.trimEnd())
    const gh = cfg.githubToken ? run(['sh', '-c', cfg.githubToken]) : undefined
    if (gh && !gh.ok) return bad(`tokens: githubToken command failed: ${firstLine(gh.err)}`.trimEnd())
    const co = checkout(a.repo, a.rev, paths.src, tmp)
    if (!co.ok) return bad(`source: cannot check out ${a.rev.slice(0, 7)}: ${firstLine(co.err)}`)
    writeFileSync(paths.ca, caBundle(process.env))
    const buildx = run(['docker', 'buildx', 'version']).ok
    const cmd = buildCommand({ cfg, image: a.image, rev: a.rev, key: a.key, force: a.force }, paths, {
      buildx,
      github: !!gh?.out,
      prefix: Bun.which('buildctl') ? [] : ['nix', 'shell', 'nixpkgs#buildkit', '-c'],
    })
    // buildctl: the client fetches the registry token (the package is internal), so no BUILDKIT_NO_CLIENT_TOKEN
    const { BUILDKIT_NO_CLIENT_TOKEN: _drop, ...base } = process.env
    const p = run(cmd, {
      env: {
        ...(buildx ? { ...process.env, BUILDKIT_NO_CLIENT_TOKEN: 'true' } : base),
        ...(buildx ? {} : { DOCKER_CONFIG: writeGhcrConfig(join(tmp, 'docker')) }),
        NIX_SSL_CERT_FILE: paths.ca,
        FACTORY_DEVENV_CACHE: token.out,
        FACTORY_DEVENV_GH: gh?.out,
      },
    })
    writeFileSync(a.log, `${p.out}\n${p.err}\n`)
    return { ok: p.ok, why: p.ok ? '' : p.err.split('\n').slice(-15).join('\n') }
  } finally {
    rmQuiet(tmp, { recursive: true, force: true })
  }
}

export const readStamp = (file: string): Stamp | undefined =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined

export function writeStamp(file: string, stamp: Stamp) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(stamp)}\n`)
}

export type ProposalRig = {
  name: string
  repo: string
  runner?: string
  env?: Record<string, string>
  egress?: Egress[]
}

/**
 * The commands that give each ax rig with a devenv and no cache the cache of the first rig that has one
 * (`factory devenv --missing`, claude-factory-ad6r). It prints a URL, a public key and a vault key name, never a token.
 * Where it cannot copy the rule with certainty, the line says what to copy by hand. It changes nothing.
 */
export function cacheProposal(rigs: ProposalRig[], hasDevenv: (r: ProposalRig) => boolean): string[] {
  const usable = (r: ProposalRig) => {
    const words = (r.env?.FACTORY_NIX_CACHE ?? '').trim().split(/\s+/)
    if (r.runner !== 'ax' || words.length !== 2) return undefined
    try {
      return { rig: r, value: r.env!.FACTORY_NIX_CACHE!, url: new URL(words[0]!) }
    } catch {
      return undefined
    }
  }
  const tpl = rigs.map(usable).find(Boolean)
  if (!tpl) return ['no ax rig has a usable FACTORY_NIX_CACHE: nothing to copy']
  const host = tpl.url.hostname.toLowerCase()
  const rule = tpl.rig.egress?.find(e => e.hosts.some(h => h.toLowerCase() === host))
  // the runtime defaults of src/ax.ts: header Authorization and prefix "Bearer ", each on its own
  const eff = (e: Egress) => ({ header: e.header ?? 'Authorization', prefix: e.prefix ?? 'Bearer ' })
  const spec =
    rule?.key &&
    `${rule.hosts.join(',')}=${rule.key}${rule.header || rule.prefix !== undefined ? `:${eff(rule).header}:${eff(rule).prefix}` : ''}`
  const safe = (t: string) => !/['\u0000-\u001f\u007f]/.test(t) && !SECRETS.some(p => p.test(t))
  const copyable = (() => {
    if (!rule || !spec || rule.headers || rule.pathPrefixes || rule.http) return false
    if (tpl.url.username || tpl.url.password || !safe(tpl.value) || !safe(spec)) return false
    try {
      const back = parseEgress(spec)
      return (
        back.hosts.join() === rule.hosts.join() &&
        back.key === rule.key &&
        eff(back).header === eff(rule).header &&
        eff(back).prefix === eff(rule).prefix
      )
    } catch {
      return false
    }
  })()
  const out: string[] = []
  for (const r of rigs) {
    if (r.runner !== 'ax' || r.env?.FACTORY_NIX_CACHE || !hasDevenv(r)) continue
    const shared = r.egress?.some(e =>
      e.hosts.some(h => rule?.hosts.some(x => x.toLowerCase() === h.toLowerCase())),
    )
    if (!copyable || shared)
      out.push(
        `${r.name}: copy FACTORY_NIX_CACHE and the egress rule for ${host} from rig ${tpl.rig.name} (factory rig show ${tpl.rig.name})`,
      )
    else
      out.push(
        `factory rig env set ${r.name} 'FACTORY_NIX_CACHE=${tpl.value}'`,
        `factory rig egress add ${r.name} '${spec}'${rule!.port ? ` --port ${rule!.port}` : ''}`,
      )
  }
  return out
}
