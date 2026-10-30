import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Sign an empty commit the way `git commit` does, with the repo's own signing config. Nothing
 * lands in the repo: the object goes to a temp object dir. When commit.gpgsign is not on, no
 * signer runs. claude-factory-8je: dispatch holds local runs while this fails. */
export function signingProbe(repo: string, timeoutMs = 10_000): { ok: true } | { ok: false; error: string } {
  const on = Bun.spawnSync(['git', '-C', repo, 'config', '--type=bool', '--get', 'commit.gpgsign'], {
    env: process.env,
  })
  if (on.stdout.toString().trim() !== 'true') return { ok: true }
  const tmp = mkdtempSync(join(tmpdir(), 'factory-sign-'))
  try {
    const p = Bun.spawnSync(
      ['git', '-C', repo, 'commit-tree', '-S', EMPTY_TREE, '-m', 'factory-signing-probe'],
      {
        env: { ...process.env, GIT_OBJECT_DIRECTORY: tmp },
        timeout: timeoutMs,
      },
    )
    if (p.exitCode === 0) return { ok: true }
    if (p.exitCode === null || p.signalCode)
      return { ok: false, error: `timed out after ${timeoutMs / 1000}s` }
    const line =
      p.stderr
        .toString()
        .split('\n')
        .find(l => l.trim()) ?? `git exited ${p.exitCode}`
    return { ok: false, error: line.trim().slice(0, 200) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
