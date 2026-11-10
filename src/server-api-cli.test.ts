import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const tmp = () => mkdtempSync(join(tmpdir(), 'sapi-'))
const cli = join(import.meta.dir, 'cli.ts')
const WORKER = [
  'FACTORY_OUTBOX',
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'FACTORY_PATROL',
  'BEADS_ACTOR',
  'FACTORY_SERVER',
]
const cleanEnv = (home: string) => {
  const e: Record<string, string | undefined> = {
    ...process.env,
    FACTORY_HOME: home,
    FACTORY_SELF_UPDATE: '0',
  }
  for (const k of WORKER) delete e[k]
  return e as Record<string, string>
}
const cert = (dir: string, ...rest: string[]) =>
  Bun.spawnSync([process.execPath, cli, 'cert', 'person', dir, ...rest], { env: cleanEnv(tmp()) })

test('n69b2 AC3 local, direct core, and server CLI use equivalent isolated homes', async () => {
  const serverHome = tmp()
  const localHome = tmp()
  const directHome = tmp()
  const callerHome = tmp()
  const repo = tmp()
  expect(Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]).exitCode).toBe(0)
  expect(
    Bun.spawnSync([
      'git',
      '-C',
      repo,
      '-c',
      'user.name=factory',
      '-c',
      'user.email=factory@localhost',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'root',
    ]).exitCode,
  ).toBe(0)
  for (const home of [serverHome, localHome, directHome])
    writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'acme', repo, factory: 'ship' }]))
  const serverApi = join(import.meta.dir, 'server-api.ts')
  const catalog = join(import.meta.dir, 'core/catalog.ts')
  const gc = join(import.meta.dir, 'core/ops/gc.ts')
  const env = (home: string) => ({
    ...cleanEnv(home),
    FACTORY_NO_KICK: '1',
    FACTORY_GC: '0',
    FACTORY_GC_WORKTREES: '0',
  })
  const server = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    const {corePort} = await import(${JSON.stringify(cli)});
    const {clientHandler} = await import(${JSON.stringify(serverApi)});
    const s = Bun.serve({hostname:'127.0.0.1',port:0,fetch:clientHandler({home:process.env.FACTORY_HOME,port:corePort,board:()=>null,run:async()=>{throw Error('no CLI bridge')}})});
    console.log(s.url.origin);
  `,
    ],
    { env: env(serverHome), stdout: 'pipe', stderr: 'pipe', timeout: 30000 },
  )
  try {
    const first = await server.stdout.getReader().read()
    const origin = new TextDecoder().decode(first.value).trim()
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:/)
    const rows = [
      [],
      ['--days', '.5'],
      ['--dry-run'],
      ['--worktrees'],
      ['--worktrees', '--dry-run'],
      ['--dry-run', '--rig', 'acme', '--worktrees'],
    ]
    let archived = 0
    for (const args of rows) {
      for (const home of [serverHome, localHome, directHome]) {
        const broken = join(home, 'runs', 'broken-1xx')
        mkdirSync(broken, { recursive: true })
        writeFileSync(join(broken, 'run.json'), '{')
        const def: Factory = {
          name: 'ship',
          start: 'work',
          nodes: { work: { prompt: 'do it', next: { ready: 'done' } } },
        }
        const actor = createActor(compile(def)).start()
        actor.send({
          type: 'DONE',
          seq: actor.getSnapshot().context.seq,
          outcome: 'ready',
          summary: 'done',
          at: 1,
        })
        const run = join(home, 'runs', 'ship-1xx')
        mkdirSync(run, { recursive: true })
        writeFileSync(join(run, 'factory.ts'), `export default ${JSON.stringify(def)}`)
        writeFileSync(
          join(run, 'run.json'),
          JSON.stringify({
            id: 'ship-1xx',
            factory: join(run, 'factory.ts'),
            repo,
            worktree: join(home, 'worktrees', 'ship-1xx'),
            branch: 'factory/ship-1xx',
            goal: 'g',
            ws: 'w1',
          }),
        )
        writeFileSync(
          join(run, 'state.json'),
          JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }),
        )
        actor.stop()
      }
      const local = Bun.spawnSync([process.execPath, cli, 'gc', ...args], { env: env(localHome) })
      const direct = Bun.spawnSync(
        [
          process.execPath,
          '-e',
          `
        const {corePort} = await import(${JSON.stringify(cli)});
        const {CATALOG} = await import(${JSON.stringify(catalog)});
        const {argsInput} = await import(${JSON.stringify(gc)});
        const r = await CATALOG.find(o=>o.name==='gc.run').run({home:process.env.FACTORY_HOME,env:process.env,port:corePort,board:()=>null,cli:async()=>{throw Error('no CLI bridge')}},argsInput(${JSON.stringify(args)}));
        process.stdout.write(r.out);process.stderr.write(r.err);process.exitCode=r.code;
      `,
        ],
        { env: env(directHome) },
      )
      const remote = Bun.spawnSync([process.execPath, cli, 'gc', ...args], {
        env: { ...env(callerHome), FACTORY_SERVER: origin },
      })
      const result = (p: typeof local) => ({
        code: p.exitCode,
        out: p.stdout.toString(),
        err: p.stderr.toString(),
      })
      expect(result(direct)).toEqual(result(local))
      expect(result(remote)).toEqual(result(local))
      expect(local.exitCode).toBe(0)
      if (!args.includes('--worktrees')) expect(local.stderr.toString()).toContain('gc: skipping broken-1xx:')
      if (!args.includes('--dry-run') && !args.includes('--worktrees')) archived++
      for (const home of [serverHome, localHome, directHome]) {
        expect(existsSync(join(home, 'runs', 'ship-1xx'))).toBe(
          args.includes('--dry-run') || args.includes('--worktrees'),
        )
        const metrics = readFileSync(join(home, 'metrics.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line).id)
        expect(metrics).toEqual(Array(archived).fill('ship-1xx'))
      }
    }
    for (const home of [serverHome, localHome, directHome]) {
      expect(existsSync(join(home, 'gc.stamp'))).toBe(true)
      expect(existsSync(join(home, 'gc-worktrees.stamp'))).toBe(true)
      expect(readFileSync(join(home, 'gc-worktrees.jsonl'), 'utf8')).toContain('"type":"pass"')
    }
    expect(readdirSync(callerHome)).toEqual([])
    const failure = Bun.spawnSync([process.execPath, cli, 'gc', '--worktrees', '--rig', 'unknown'], {
      env: { ...env(callerHome), FACTORY_SERVER: origin },
    })
    expect(failure.exitCode).toBe(1)
    expect(failure.stderr.toString()).toContain('no such rig')
    expect(readdirSync(callerHome)).toEqual([])
  } finally {
    server.kill()
    await server.exited
  }
  const unavailable = Bun.spawnSync([process.execPath, cli, 'gc'], {
    env: { ...env(callerHome), FACTORY_SERVER: 'http://127.0.0.1:1' },
  })
  expect(unavailable.exitCode).toBe(1)
  expect(readdirSync(callerHome)).toEqual([])
}, 30000)

describe('factory cert person', () => {
  test('prints the owner steps and no key text', () => {
    const dir = join(tmp(), 'out')
    const p = cert(dir, 'factory.lan')
    expect(p.exitCode).toBe(0)
    const out = p.stdout.toString()
    expect(out).toContain('factory-server-tls')
    expect(out).toContain('factory-person-ca')
    expect(out).not.toContain('PRIVATE KEY')
    expect(existsSync(join(dir, 'person.crt'))).toBe(true)
  })
  test('a second run on the same dir exits 1', () => {
    const dir = join(tmp(), 'out')
    expect(cert(dir, 'factory.lan').exitCode).toBe(0)
    expect(cert(dir, 'factory.lan').exitCode).toBe(1)
  })
  test('a missing server-name exits 1 and writes nothing', () => {
    const dir = join(tmp(), 'out')
    expect(cert(dir).exitCode).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })
})
