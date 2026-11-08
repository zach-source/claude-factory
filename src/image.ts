import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettings, setSetting } from './settings'

export type Target = 'worker' | 'manager'
export const IMAGE_KEY: Record<Target, string> = { worker: 'ax.image', manager: 'ax.manager-image' }

const NO_DIGEST = 'the build metadata has no sha256 digest'

/** Returns `containerimage.digest` of the buildx metadata text. Only `sha256:` and 64 lowercase hex pass. Any other input throws. */
export function parseDigest(text: string): string {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    throw new Error(NO_DIGEST)
  }
  const d =
    typeof o === 'object' && o !== null ? (o as Record<string, unknown>)['containerimage.digest'] : undefined
  if (typeof d !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(d)) throw new Error(NO_DIGEST)
  return d
}

/** Reads a stored setting that must hold one word with no space or control character. */
function word(file: string, key: string): string {
  const v = readSettings(file)[key]
  // eslint-disable-next-line no-control-regex
  if (v === undefined || !/^[^\s\x00-\x1f\x7f]+$/.test(v))
    throw new Error(`${key} is not set: run factory settings set ${key} <value>`)
  return v
}

/**
 * Builds and pushes the worker or manager image as hack/push-worker.sh did. `run` gets the argv after `docker`
 * and resolves to the exit code. The setting `ax.image` (or `ax.manager-image`) changes only after a push with a good digest.
 * Returns `<tag>@<digest>`.
 */
export async function buildImage(o: {
  target: Target
  settingsFile: string
  root: string
  sha: string
  env: Record<string, string | undefined>
  run: (argv: string[]) => Promise<number>
}): Promise<string> {
  const registry = word(o.settingsFile, 'image.registry')
  const builder = word(o.settingsFile, 'image.builder')
  const tag = `${registry}/factory-${o.target}:${o.sha}`
  const dir = mkdtempSync(join(tmpdir(), 'factory-image-'))
  const meta = join(dir, 'meta.json')
  const args = ['AX_CLI_REPO', 'AX_CLI_COMMIT'].flatMap(k =>
    o.env[k] ? ['--build-arg', `${k}=${o.env[k]}`] : [],
  )
  try {
    const code = await o.run([
      'buildx',
      'build',
      '--builder',
      builder,
      '--platform',
      'linux/amd64',
      '--target',
      o.target,
      '--push',
      '--metadata-file',
      meta,
      ...args,
      '-t',
      tag,
      '-f',
      join(o.root, 'Dockerfile.worker'),
      o.root,
    ])
    if (code !== 0) throw new Error(`docker buildx build failed (exit ${code})`)
    let text = ''
    try {
      text = readFileSync(meta, 'utf8')
    } catch {
      // a missing file gives the same refusal as a bad one
    }
    const ref = `${tag}@${parseDigest(text)}`
    try {
      setSetting(o.settingsFile, IMAGE_KEY[o.target], ref)
    } catch (e) {
      throw new Error(`pushed ${ref} but could not store ${IMAGE_KEY[o.target]}: ${(e as Error).message}`)
    }
    return ref
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
