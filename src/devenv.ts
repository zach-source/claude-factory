// `factory devenv`: builds each AX rig's devenv where Nix can build (an amd64 buildx builder; local Nix builds
// fail under the VMs' gVisor) and pushes its closure to the rig's binary cache (FACTORY_NIX_CACHE), which the
// VM's worker loads it from. A rig is rebuilt when its devenv files or the worker image change.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO } from './ax'
import { rmSafe } from './home-guard'

/**
 * `$FACTORY_HOME/devenv.json`: the buildx builder, a command printing the cache's push token, and the shell
 * the build runs to push $ROOTS with that token at /run/secrets/cache (`attic push ...`, say)
 */
export type DevenvConfig = { builder: string; token: string; push: string }

export type Stamp = { key: string; ok: boolean; at: number; rev: string }

/** what a devenv's derivations depend on that a rig's repo changes: its devenv files, as git blobs */
export const DEVENV_FILES = ['devenv.nix', 'devenv.yaml', 'devenv.lock']

/**
 * the build's identity: the devenv files' blobs and the worker image, whose devenv and Nix evaluate them.
 * ponytail: a devenv.nix that imports other files of the repo misses their changes; hash those too if one does
 */
export const cacheKey = (blobs: string, image: string) =>
  createHash('sha256').update(`${image}\n${blobs}`).digest('hex').slice(0, 16)

/** whether a rig needs a build: never built, or built from other files or another image */
export const isDue = (stamp: Stamp | undefined, key: string, force = false) => force || stamp?.key !== key

// at REPO, the path the VM clones to: a devenv's derivations depend on its root
export const DOCKERFILE = `# syntax=docker/dockerfile:1
ARG IMAGE
FROM \${IMAGE}
ARG REMOTE
ARG REV
ARG PUSH
ARG KEY
RUN --mount=type=secret,id=gh,required=true --mount=type=secret,id=cache,required=true <<'EOF'
set -eu
echo "devenv $KEY"
mkdir -p ${REPO} && cd ${REPO} && git init -q
auth=$(printf 'x-access-token:%s' "$(cat /run/secrets/gh)" | base64 -w0)
git -c http.https://github.com/.extraHeader="Authorization: Basic $auth" fetch -q --depth 1 "$REMOTE" "$REV"
git checkout -q FETCH_HEAD
devenv print-dev-env > /tmp/env.sh 2> /tmp/devenv.log || { tail -40 /tmp/devenv.log; exit 1; }
ROOTS=$(for r in .devenv/gc/* .devenv/profile; do [ -e "$r" ] && readlink -f "$r"; done | sort -u | tr '\\n' ' ')
export ROOTS
echo "roots: $ROOTS"
sh -euc "$PUSH"
EOF
`

const run = (cmd: string[], o: { cwd?: string; env?: Record<string, string | undefined> } = {}) => {
  const p = Bun.spawnSync(cmd, { ...o, stdout: 'pipe', stderr: 'pipe' })
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
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

/**
 * builds one rig's devenv and pushes it; the log, whose secrets buildx never prints, goes to `log`.
 * The tokens reach the build only as buildx secrets, from this process's env
 */
export function build(
  cfg: DevenvConfig,
  a: { image: string; remote: string; rev: string; key: string; log: string; force?: boolean },
) {
  const ctx = mkdtempSync(join(tmpdir(), 'factory-devenv-'))
  try {
    writeFileSync(join(ctx, 'Dockerfile'), DOCKERFILE)
    const gh = run(['gh', 'auth', 'token'])
    const token = run(['sh', '-c', cfg.token])
    if (!gh.ok || !token.ok)
      return {
        ok: false,
        why: `tokens: ${gh.ok ? '' : 'gh auth token failed; '}${token.ok ? '' : 'token command failed'}`,
      }
    const p = run(
      [
        ...[
          'docker',
          'buildx',
          'build',
          '--builder',
          cfg.builder,
          '--platform',
          'linux/amd64',
          '--progress',
          'plain',
        ],
        ...[
          '--build-arg',
          `IMAGE=${a.image}`,
          '--build-arg',
          `REMOTE=${a.remote}`,
          '--build-arg',
          `REV=${a.rev}`,
        ],
        ...['--build-arg', `PUSH=${cfg.push}`, '--build-arg', `KEY=${a.key}`],
        ...['--secret', 'id=gh,env=FACTORY_DEVENV_GH', '--secret', 'id=cache,env=FACTORY_DEVENV_CACHE'],
        ...(a.force ? ['--no-cache'] : []),
        ...['--output', 'type=cacheonly', ctx],
      ],
      { env: { ...process.env, FACTORY_DEVENV_GH: gh.out, FACTORY_DEVENV_CACHE: token.out } },
    )
    writeFileSync(a.log, `${p.out}\n${p.err}\n`)
    return { ok: p.ok, why: p.ok ? '' : p.err.split('\n').slice(-15).join('\n') }
  } finally {
    rmSafe(ctx, { recursive: true, force: true })
  }
}

export const readStamp = (file: string): Stamp | undefined =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined

export function writeStamp(file: string, stamp: Stamp) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(stamp)}\n`)
}
