// factory pg-scratch start|stop: a disposable Postgres for each worktree (claude-factory-xxp7).
// The server uses a unix socket and trust auth. Only the worker's uid can connect.
// ponytail: if a worker never runs stop, the server stays until the worktree goes. Upgrade: a reaper in gc.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const USAGE = 'usage: factory pg-scratch start|stop'
const TMP_RE = /^\/tmp\/pgs-[0-9a-f]{12}$/

export function sockDir(top: string): string {
  const own = join(top, '.scratch', 'pg-scratch')
  if (`${own}/.s.PGSQL.5432`.length <= 100 && /^[A-Za-z0-9/._-]+$/.test(own)) return own
  return `/tmp/pgs-${createHash('sha256').update(top).digest('hex').slice(0, 12)}`
}

// The only delete path: refuses anything but the two directories this command makes.
export function guardRm(path: string, top: string): string {
  if (path === join(top, '.scratch', 'pg-scratch') || TMP_RE.test(path)) return path
  throw new Error(`pg-scratch: refusing to delete ${path}`)
}

export function resolveBin(env: Record<string, string | undefined>): string {
  const found = Bun.which('initdb', { PATH: env.PATH ?? '' })
  if (found) return dirname(realpathSync(found))
  let out = ''
  try {
    const r = Bun.spawnSync(['nix', 'build', '--no-link', '--print-out-paths', 'nixpkgs#postgresql'], {
      env: env as Record<string, string>,
      stderr: 'ignore',
    })
    if (r.exitCode === 0) out = r.stdout.toString().trim().split('\n')[0] ?? ''
  } catch {} // no nix on PATH: Bun throws; the error below says so
  if (!out) throw new Error('pg-scratch: no initdb on PATH and nix build nixpkgs#postgresql failed')
  return join(out, 'bin')
}

export interface Opts {
  cwd: string
  env: Record<string, string | undefined>
  uid?: number
}

export function pgScratch(args: string[], o: Opts): number {
  const err = (m: string) => process.stderr.write(m + '\n')
  if (args.length !== 1 || (args[0] !== 'start' && args[0] !== 'stop')) {
    err(USAGE)
    return 2
  }
  const g = Bun.spawnSync(['git', '-C', o.cwd, 'rev-parse', '--show-toplevel'], { stderr: 'ignore' })
  const top = g.exitCode === 0 ? realpathSync(g.stdout.toString().trim()) : ''
  if (!top) {
    err('pg-scratch: not in a git worktree')
    return 1
  }
  if ((o.uid ?? process.getuid?.()) === 0) {
    err('pg-scratch: postgres refuses root; run as a non-root user')
    return 1
  }
  const base = join(top, '.scratch', 'pg-scratch')
  const data = join(base, 'data')
  const sock = sockDir(top)
  const stop = args[0] === 'stop'
  if (stop && !existsSync(base) && !existsSync(sock)) return 0
  let bin: string
  try {
    bin = resolveBin(o.env)
  } catch (e) {
    err((e as Error).message)
    return 1
  }
  // pg_ctl and initdb talk on stdout; the command's own stdout is the URL line only.
  const run = (cmd: string, a: string[]) => {
    const r = Bun.spawnSync([join(bin, cmd), ...a], { env: o.env as Record<string, string> })
    process.stderr.write(r.stdout)
    process.stderr.write(r.stderr)
    return r.exitCode
  }
  const running = () => existsSync(join(data, 'PG_VERSION')) && run('pg_ctl', ['-D', data, 'status']) === 0
  if (stop) {
    if (running() && run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']) !== 0 && running()) {
      err('pg-scratch: pg_ctl stop failed; the data directory stays')
      return 1
    }
    rmSync(guardRm(base, top), { recursive: true, force: true })
    if (sock !== base) rmSync(guardRm(sock, top), { recursive: true, force: true })
    return 0
  }
  mkdirSync(base, { recursive: true, mode: 0o700 })
  mkdirSync(sock, { recursive: true, mode: 0o700 })
  if (!existsSync(join(data, 'PG_VERSION'))) {
    const i = run('initdb', [
      '-D',
      data,
      '-U',
      'postgres',
      '--auth=trust',
      '-E',
      'UTF8',
      '--no-locale',
      '--no-sync',
    ])
    if (i !== 0) return (err('pg-scratch: initdb failed'), 1)
  }
  if (!running()) {
    const opts = `-k ${sock} -c listen_addresses= -c unix_socket_permissions=0700 -F`
    if (run('pg_ctl', ['-D', data, '-l', join(base, 'log'), '-w', '-t', '30', '-o', opts, 'start']) !== 0)
      return (err('pg-scratch: pg_ctl start failed; see ' + join(base, 'log')), 1)
  }
  console.log(`TEST_DATABASE_URL=postgres://postgres@/postgres?host=${sock}&sslmode=disable`)
  return 0
}
