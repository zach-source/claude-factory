// This file fast-forwards the checkout that holds bin/factory to its upstream. This action
// makes a merge to main live on the manager's machine. The merge goes live within
// FACTORY_SELF_UPDATE_MS. The manager needs no manual `git pull` (claude-factory-5h9.8, part of
// claude-factory-5h9's acceptance #6). cli.ts's tick() starts this update, at most that often.
// tick() takes the same lock, 'tick.lock', for the update. So no tick runs during the update.
//
// This module stays pure: it takes no env vars, holds no locks and sends no mail. selfUpdate()
// takes every switch as an argument. A test can drive it with no change to process.env. A
// change to process.env can leak into other test files in the same bun test process. See
// claude-factory-5h9.4's fix for 3 cases of exactly that leak.

export type Runner = (cwd: string, cmd: string[]) => { code: number; out: string; err: string }
export type State = { at: number; from: string; to: string; ok: boolean; why: string }

const runGit: Runner = (cwd, cmd) => {
  const p = Bun.spawnSync(cmd, { cwd })
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

function git(run: Runner, cwd: string, ...args: string[]) {
  return run(cwd, ['git', ...args])
}

/** true when `lastAt` is missing, or `intervalMs` has passed since it: the kick's own throttle. */
export function isDue(lastAt: number | undefined, now: number, intervalMs: number): boolean {
  return lastAt === undefined || now - lastAt >= intervalMs
}

/**
 * Fast-forwards `cwd` to its upstream and reports what happened.
 *
 * It refuses, and makes no change, in each of these cases. It names the reason in each case.
 * - `enabled` is false (FACTORY_SELF_UPDATE=0).
 * - The branch is not `wantBranch`.
 * - The branch has no upstream, or its upstream is not `origin/<wantBranch>`.
 * - The tree has tracked changes. Untracked files are fine on their own. But `git merge
 *   --ff-only` itself refuses when the merge would overwrite an untracked file.
 * - The fetch fails.
 * - HEAD is not an ancestor of the fetched upstream: a diverged history. A plain `merge
 *   --ff-only` would also refuse this case. This function checks the ancestor relationship
 *   first, so its reason names the real cause, not git's own merge error text.
 */
export function selfUpdate(
  cwd: string,
  opts: { enabled?: boolean; wantBranch?: string; run?: Runner; now?: number } = {},
): State {
  const wantBranch = opts.wantBranch ?? 'main'
  const run = opts.run ?? runGit
  const at = opts.now ?? Date.now()
  const from = git(run, cwd, 'rev-parse', 'HEAD').out

  const refuse = (why: string): State => ({ at, from, to: from, ok: false, why })

  if (opts.enabled === false) return refuse('FACTORY_SELF_UPDATE=0')

  const branch = git(run, cwd, 'rev-parse', '--abbrev-ref', 'HEAD').out
  if (branch !== wantBranch) return refuse(`branch is ${branch || '(detached)'}, not ${wantBranch}`)

  const up = git(run, cwd, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  const upstream = up.code === 0 ? up.out : ''
  if (upstream !== `origin/${wantBranch}`)
    return refuse(`upstream is ${upstream || '(none)'}, not origin/${wantBranch}`)

  const status = git(run, cwd, 'status', '--porcelain')
  if (status.out.split('\n').some(line => line && !line.startsWith('??')))
    return refuse('the tree has tracked changes')

  const fetch = git(run, cwd, 'fetch', 'origin', wantBranch)
  if (fetch.code !== 0) return refuse(`git fetch origin ${wantBranch} failed: ${fetch.err}`)

  const ancestor = git(run, cwd, 'merge-base', '--is-ancestor', from, upstream)
  if (ancestor.code !== 0)
    return refuse(`${from.slice(0, 7)} is not an ancestor of ${upstream}; history diverged`)

  const merge = git(run, cwd, 'merge', '--ff-only', upstream)
  if (merge.code !== 0) return refuse(`git merge --ff-only ${upstream} failed: ${merge.err}`)

  const to = git(run, cwd, 'rev-parse', 'HEAD').out
  if (to === from) return { at, from, to, ok: true, why: 'already up to date' }

  const lockChanged = git(run, cwd, 'diff', '--name-only', from, to, '--', 'bun.lock').out.trim() !== ''
  if (lockChanged) {
    const install = run(cwd, ['bun', 'install', '--frozen-lockfile'])
    if (install.code !== 0)
      return {
        at,
        from,
        to,
        ok: false,
        why: `updated ${from.slice(0, 7)}..${to.slice(0, 7)} but bun install failed: ${install.err}`,
      }
  }

  return {
    at,
    from,
    to,
    ok: true,
    why: `updated ${from.slice(0, 7)}..${to.slice(0, 7)}${lockChanged ? ' (bun.lock changed, ran bun install)' : ''}`,
  }
}
