// `factory core` end to end (claude-factory-hpmc.4, specs/008-frontend-parity quickstart 3).
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActor } from 'xstate'
import { compile, type Factory } from './machine'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const SLOW = { timeout: 90_000 }

const cleanEnv = (home: string, extra: Record<string, string> = {}) => {
  const {
    FACTORY_OUTBOX,
    FACTORY_FROM,
    FACTORY_RUN,
    FACTORY_DEF_NAME,
    BEADS_ACTOR,
    FACTORY_PATROL,
    FACTORY_SERVER,
    ...laptop
  } = process.env
  return {
    ...laptop,
    FACTORY_HOME: home,
    FACTORY_SELF_UPDATE: '0',
    FACTORY_GC: '0',
    FACTORY_NO_KICK: '1',
    ...extra,
  } as Record<string, string>
}

const spawned: { kill: () => void; pid: number }[] = []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
afterEach(async () => {
  const ps = spawned.splice(0)
  for (const p of ps)
    try {
      process.kill(p.pid, 'SIGTERM')
    } catch {}
  const t0 = Date.now()
  while (ps.some(p => alive(p.pid)) && Date.now() - t0 < 3000) await Bun.sleep(50)
  for (const p of ps)
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {}
})

const tmp = () => mkdtempSync(join(tmpdir(), 'core-cli-'))
const run = (home: string, args: string[], extra: Record<string, string> = {}) => {
  const p = Bun.spawnSync([CLI, ...args], { env: cleanEnv(home, extra) })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
/** async, so the event loop reaps the core child that this test started: a zombie would look alive to `core stop` */
const runAsync = async (home: string, args: string[]) => {
  const p = Bun.spawn([CLI, ...args], { env: cleanEnv(home), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}
const start = (home: string, args: string[] = ['--port', '0'], extra: Record<string, string> = {}) => {
  const dir = tmp()
  const { herdr, claude } = fakeHerdr(dir)
  const p = Bun.spawn([CLI, 'core', ...args], {
    env: cleanEnv(home, {
      FACTORY_CORE_TICK_MS: '200',
      FACTORY_HERDR: herdr,
      FACTORY_CLAUDE: claude,
      FACTORY_CODEX: claude,
      CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config'),
      ...extra,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  spawned.push({ kill: () => p.kill(9), pid: p.pid })
  return p
}
const until = async (f: () => boolean, ms = 30_000) => {
  const t0 = Date.now()
  while (!f() && Date.now() - t0 < ms) await Bun.sleep(50)
  expect(f()).toBe(true)
}
const json = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
const running = (home: string): { port: number; pid: number; holder: string } | undefined => {
  const j = json(join(home, 'core.json'))
  return j?.pid ? j : undefined
}

const DEF: Factory = {
  name: 'ship',
  start: 'a',
  nodes: {
    a: { prompt: 'do a', next: { ready: 'b' } },
    b: { prompt: 'do b', next: { ready: 'c' } },
    c: { prompt: 'do c', next: { ready: 'done' } },
  },
}

/** one run of a 3-station factory, saved after its first TICK */
function makeRun(home: string, dir: string) {
  const id = `ship-${Date.now().toString(36)}x`
  const d = join(home, 'runs', id)
  const wt = join(dir, id)
  mkdirSync(wt, { recursive: true })
  mkdirSync(d, { recursive: true })
  const file = join(d, 'factory.ts')
  writeFileSync(file, `export default ${JSON.stringify(DEF)}`)
  writeFileSync(
    join(d, 'run.json'),
    JSON.stringify({ id, factory: file, repo: wt, goal: 'g', ws: 'w1', worktree: wt, branch: 'b' }),
  )
  const actor = createActor(compile(DEF)).start()
  actor.send({ type: 'TICK', at: 0 })
  writeFileSync(join(d, 'state.json'), JSON.stringify({ cursor: 0, snapshot: actor.getPersistedSnapshot() }))
  writeFileSync(join(d, 'inbox.jsonl'), '')
  return { id, d }
}

const fakeHerdr = (dir: string) => {
  const herdr = join(dir, 'ok-herdr')
  writeFileSync(
    herdr,
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      `  "tab create") printf '{"result":{"root_pane":{"pane_id":"p1"}}}\\n' ;;`,
      '  "pane run") exit 0 ;;',
      "  *) echo '{}' ;;",
      'esac',
    ].join('\n'),
  )
  chmodSync(herdr, 0o755)
  const claude = join(dir, 'no-claude')
  writeFileSync(claude, '#!/bin/sh\nexit 1\n')
  chmodSync(claude, 0o755)
  return { herdr, claude }
}

describe('quickstart 3', () => {
  test(
    'a core with no front end moves a run through 3 stations; a second core names the holder',
    async () => {
      const dir = tmp()
      const home = join(dir, 'home')
      const r = makeRun(home, dir)
      const { herdr, claude } = fakeHerdr(dir)
      start(home, ['--port', '0'], {
        FACTORY_HERDR: herdr,
        FACTORY_CLAUDE: claude,
        CLAUDE_CONFIG_DIR: join(dir, 'no-claude-config'),
      })
      await until(() => !!running(home))
      const c = running(home)!
      const token = readFileSync(join(home, 'core.token'), 'utf8')
      const headers = { authorization: `Bearer ${token}` }
      const base = `http://127.0.0.1:${c.port}`

      // a stream that opens before the first DONE
      const res = await fetch(`${base}/v1/events`, { headers })
      let text = ''
      void (async () => {
        const dec = new TextDecoder()
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>)
            text += dec.decode(chunk)
        } catch {} // the core stops at the end of the test
      })()

      const worked: string[] = []
      const state = () => json(join(r.d, 'state.json'))
      const t0 = Date.now()
      while (Date.now() - t0 < 60_000) {
        const s = state()
        const v = s?.snapshot?.value
        if (v === 'done') break
        const node = v && typeof v === 'object' ? Object.keys(v)[0] : undefined
        if (node && v[node] === 'working' && !worked.includes(node)) {
          worked.push(node)
          appendFileSync(
            join(r.d, 'inbox.jsonl'),
            `${JSON.stringify({ type: 'DONE', seq: s.snapshot.context.seq, outcome: 'ready', summary: 's', at: Date.now() })}\n`,
          )
        }
        await Bun.sleep(50)
      }
      expect(worked).toEqual(['a', 'b', 'c'])
      expect(state().snapshot.value).toBe('done')

      const lease = json(join(home, 'manager.lease'))
      expect(lease).toMatchObject({ holder: `core:${c.pid}`, kind: 'core', pid: c.pid })
      const st = (await (await fetch(`${base}/v1/core`, { headers })).json()) as { ticks: number }
      expect(st.ticks).toBeGreaterThanOrEqual(3)
      expect(text).toContain(`"resource":"run:${r.id}"`)
      expect(existsSync(join(home, 'manager-tick.json'))).toBe(true)
      const m1 = statSync(join(home, 'manager-tick.json')).mtimeMs
      await until(() => statSync(join(home, 'manager-tick.json')).mtimeMs > m1)

      const second = run(home, ['core', '--port', '0'], { FACTORY_CORE_TICK_MS: '200' })
      expect(second.code).toBe(1)
      expect(second.err).toContain(`core:${c.pid}`)
      expect(second.err).toContain('holds the manager lease')
      expect(json(join(home, 'core.json')).port).toBe(c.port)

      const status = run(home, ['core', 'status'])
      expect(status.code).toBe(0)
      expect(status.out.trim()).toMatch(
        new RegExp(
          `^core core:${c.pid} runs on http://127\\.0\\.0\\.1:${c.port} \\(pid ${c.pid}, catalog version 1, \\d+ ticks\\)$`,
        ),
      )
      const stop = await runAsync(home, ['core', 'stop'])
      expect(stop.code).toBe(0)
      expect(stop.out.trim()).toBe('core stopped')
      expect(existsSync(join(home, 'manager.lease'))).toBe(false)
      expect(json(join(home, 'core.json')).pid).toBeUndefined()
      const after = run(home, ['core', 'status'])
      expect(after.code).toBe(1)
      expect(after.err).toContain(`no core on ${home}`)
      expect(run(home, ['core', 'stop']).code).toBe(1)
    },
    SLOW,
  )
})

describe('lease rows', () => {
  test('a live lease of another kind blocks the core and is named', () => {
    const home = tmp()
    writeFileSync(
      join(home, 'manager.lease'),
      JSON.stringify({ holder: 'pane:p9', kind: 'claude', at: Date.now() }),
    )
    const r = run(home, ['core', '--port', '0'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('pane:p9')
    expect(existsSync(join(home, 'core.json'))).toBe(false)
  })
  test(
    'a stale lease does not block',
    async () => {
      const home = tmp()
      writeFileSync(
        join(home, 'manager.lease'),
        JSON.stringify({ holder: 'pane:p9', kind: 'claude', at: Date.now() - 120_000 }),
      )
      start(home)
      await until(() => !!running(home))
      expect(json(join(home, 'manager.lease')).holder).toBe(`core:${running(home)!.pid}`)
    },
    SLOW,
  )
  test(
    'a lease with a dead pid does not block',
    async () => {
      const home = tmp()
      writeFileSync(
        join(home, 'manager.lease'),
        JSON.stringify({ holder: 'cli:x', kind: 'cli', pid: 2 ** 22 + 77, at: Date.now() }),
      )
      start(home)
      await until(() => !!running(home))
    },
    SLOW,
  )
})

describe('refusals', () => {
  test('a worker env cannot run core, core stop or core status', () => {
    const home = tmp()
    for (const a of [['core'], ['core', 'stop'], ['core', 'status']]) {
      const r = run(home, a, { FACTORY_RUN: 'x' })
      expect(r.code).toBe(1)
      expect(r.err).toContain('a worker cannot run factory core')
    }
    expect(existsSync(join(home, 'core.json'))).toBe(false)
  })
  test('a patrol cannot run core', () => {
    const r = run(tmp(), ['core'], { FACTORY_PATROL: '1' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('a patrol cannot run factory core')
  })
  test('server mode has no core', () => {
    const r = run(tmp(), ['core'], { FACTORY_SERVER: 'http://127.0.0.1:1' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('has no server mode')
  })
  test('bad flags exit 1 with the usage and take no lease', () => {
    const home = tmp()
    for (const a of [
      ['--bogus'],
      ['--port', 'x'],
      ['--port', '70000'],
      ['--port', '1', '--port', '2'],
      ['status', 'extra'],
    ]) {
      const r = run(home, ['core', ...a])
      expect(r.code).toBe(1)
      expect(r.err).toContain('usage: factory core')
    }
    expect(existsSync(join(home, 'manager.lease'))).toBe(false)
  })
  test('a bad FACTORY_CORE_TICK_MS exits 1 and takes no lease', () => {
    const home = tmp()
    const r = run(home, ['core', '--port', '0'], { FACTORY_CORE_TICK_MS: '50' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('FACTORY_CORE_TICK_MS must be an integer from 100 to 5000')
    expect(existsSync(join(home, 'manager.lease'))).toBe(false)
  })
  test('a bad token file exits 1 and names the file', () => {
    const home = tmp()
    writeFileSync(join(home, 'core.token'), 'abc', { mode: 0o600 })
    const r = run(home, ['core', '--port', '0'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(join(home, 'core.token'))
    expect(existsSync(join(home, 'manager.lease'))).toBe(false)
  })
  test('--home must be a directory', () => {
    const f = join(tmp(), 'file')
    writeFileSync(f, '')
    expect(run(tmp(), ['core', '--home', f, 'status']).code).toBe(1)
    expect(run(tmp(), ['core', '--home', join(tmp(), 'nope'), '--port', '0']).err).toContain(
      'not a directory',
    )
  })
})

describe('--home', () => {
  test(
    'runs the core on the named home and writes nothing in FACTORY_HOME',
    async () => {
      const a = tmp()
      const b = tmp()
      start(a, ['--home', b, '--port', '0'])
      await until(() => !!running(b))
      expect(existsSync(join(b, 'manager.lease'))).toBe(true)
      expect(existsSync(join(a, 'core.json'))).toBe(false)
      expect(existsSync(join(a, 'manager.lease'))).toBe(false)
      expect(run(a, ['core', '--home', b, 'status']).code).toBe(0)
      expect(run(a, ['core', 'status']).code).toBe(1)
      expect((await runAsync(a, ['core', 'stop', '--home', b])).out.trim()).toBe('core stopped')
    },
    SLOW,
  )
})
