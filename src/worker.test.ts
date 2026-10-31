import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bazelrc,
  databaseUrl,
  devenvProcesses,
  excludeScratch,
  lastTurn,
  orderByAfter,
  servicesNote,
  servicesWaitMs,
  startServices,
  imagePlugins,
} from './worker'

// claude-factory-qda.4: the laptop names a station's skills in FACTORY_SKILLS; unset is an older laptop
test('imagePlugins picks the image plugin dirs by FACTORY_SKILLS', () => {
  expect(imagePlugins('')).toEqual([])
  expect(imagePlugins(undefined)).toEqual(['/opt/plugins/asd-ste100'])
  expect(imagePlugins('asd-ste100')).toEqual(['/opt/plugins/asd-ste100'])
})

function sh(cmd: string[], cwd: string) {
  const p = Bun.spawnSync(cmd, { cwd })
  if (p.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().trim()
}

// bazelrc()'s pkg-gate propagation (ei0.5, commit 3a6d54d): when launch() set registry env vars in the VM,
// rules_go/rules_python/rules_js must fetch through the gate too, via `common --repo_env=<VAR>=<value>` lines.
// Mutation-verified gap (ei0.7, verify#1): deleting that block left `bun test` all green, since nothing else
// exercised it -- this test is the regression guard.
describe('bazelrc', () => {
  const ENV_VARS = [
    'FACTORY_BAZELRC',
    'FACTORY_CA',
    'GOPROXY',
    'PIP_INDEX_URL',
    'NPM_CONFIG_REGISTRY',
  ] as const
  const saved: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const v of ENV_VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
      delete saved[v]
    }
  })

  function set(vars: Partial<Record<(typeof ENV_VARS)[number], string>>) {
    for (const v of ENV_VARS) saved[v] = process.env[v]
    for (const v of ENV_VARS) delete process.env[v]
    process.env.FACTORY_BAZELRC = 'startup --batch_cpu_scheduling'
    for (const [k, val] of Object.entries(vars)) process.env[k] = val
  }

  test('adds a --repo_env line for each registry var the gate propagation set', () => {
    set({
      GOPROXY: 'http://pkg-gate:8080/go',
      PIP_INDEX_URL: 'http://pkg-gate:8080/pypi/simple',
      NPM_CONFIG_REGISTRY: 'http://pkg-gate:8080/npm',
    })
    const rc = bazelrc()
    expect(rc).toContain('common --repo_env=GOPROXY=http://pkg-gate:8080/go')
    expect(rc).toContain('common --repo_env=PIP_INDEX_URL=http://pkg-gate:8080/pypi/simple')
    expect(rc).toContain('common --repo_env=NPM_CONFIG_REGISTRY=http://pkg-gate:8080/npm')
  })

  test('omits a --repo_env line for a var launch() left unset', () => {
    set({ GOPROXY: 'http://pkg-gate:8080/go' })
    const rc = bazelrc()
    expect(rc).toContain('common --repo_env=GOPROXY=http://pkg-gate:8080/go')
    expect(rc).not.toContain('PIP_INDEX_URL')
    expect(rc).not.toContain('NPM_CONFIG_REGISTRY')
  })

  test('writes no --repo_env line when none of the three are set', () => {
    set({})
    const rc = bazelrc()
    expect(rc).not.toContain('--repo_env=')
  })

  // claude-factory-o5n0: a JVM trustStore flag that names a missing store makes every Bazel TLS call fail
  describe('trust store', () => {
    const keys = ['FACTORY_WORKER_DIR', 'FACTORY_KEYTOOL', 'PATH'] as const
    const old: Record<string, string | undefined> = {}
    let dir = ''
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'bazelrc-'))
      for (const k of keys) old[k] = process.env[k]
      process.env.FACTORY_WORKER_DIR = dir
      delete process.env.FACTORY_KEYTOOL
    })
    afterEach(() => {
      for (const k of keys) {
        if (old[k] === undefined) delete process.env[k]
        else process.env[k] = old[k]
      }
      rmSync(dir, { recursive: true, force: true })
    })
    // a fake keytool: writes the -keystore file when WRITE=1, exits with CODE, records that it ran
    function fake(name: string, code: number, write: boolean) {
      const p = join(dir, name)
      const body = write ? 'for a; do [ "$p" = -keystore ] && : > "$a"; p=$a; done' : ':'
      writeFileSync(p, `#!/bin/sh\n${body}\necho ${name} > ${join(dir, 'ran')}\nexit ${code}\n`, { mode: 0o755 })
      return p
    }
    const quiet = (f: () => string) => {
      const e = console.error
      console.error = () => {}
      try {
        return f()
      } finally {
        console.error = e
      }
    }

    test('(a) keytool made the store: trustStore and sessionCacheSize flags', () => {
      set({ FACTORY_CA: 'PEM' })
      process.env.FACTORY_KEYTOOL = fake('kt', 0, true)
      const rc = bazelrc()
      expect(rc).toContain(`-Djavax.net.ssl.trustStore=${join(dir, 'egress.jks')}`)
      expect(rc).toContain('--host_jvm_args=-Djavax.net.ssl.sessionCacheSize=1')
    })

    test('(b) keytool failed: no JVM flag, tls_certificate stays', () => {
      set({ FACTORY_CA: 'PEM' })
      process.env.FACTORY_KEYTOOL = fake('kt', 1, true)
      const rc = quiet(bazelrc)
      expect(rc).not.toContain('javax.net.ssl')
      expect(rc).toContain(`common --tls_certificate=${join(dir, 'egress-ca.crt')}`)
    })

    test('(c) keytool exit 0 but no store file: no JVM flag', () => {
      set({ FACTORY_CA: 'PEM' })
      process.env.FACTORY_KEYTOOL = fake('kt', 0, false)
      expect(quiet(bazelrc)).not.toContain('javax.net.ssl')
    })

    test('keytool on PATH runs when FACTORY_KEYTOOL is unset', () => {
      set({ FACTORY_CA: 'PEM' })
      fake('keytool', 0, true)
      process.env.PATH = `${dir}:${process.env.PATH}`
      expect(bazelrc()).toContain('javax.net.ssl.trustStore=')
      expect(readFileSync(join(dir, 'ran'), 'utf8').trim()).toBe('keytool')
    })

    test('FACTORY_KEYTOOL wins over keytool on PATH', () => {
      set({ FACTORY_CA: 'PEM' })
      fake('keytool', 0, true)
      process.env.FACTORY_KEYTOOL = fake('other', 0, true)
      process.env.PATH = `${dir}:${process.env.PATH}`
      bazelrc()
      expect(readFileSync(join(dir, 'ran'), 'utf8').trim()).toBe('other')
    })
  })
})

// lastTurn's live-stream fallback (claude-factory-xq3): the project transcript
// (~/.claude/projects/.../<session>.jsonl) is empty or missing for a turn's whole length when the session is
// learned only at the end (see ax.test.ts's mid-turn test) -- own()/claude.jsonl, which turn() streams to as
// the turn runs, is what poll must fall back to so it has something to read meanwhile.
describe('lastTurn', () => {
  const ENV_VARS = [
    'FACTORY_WORKER_DIR',
    'FACTORY_WORKER_REPO',
    'CLAUDE_CONFIG_DIR',
    'FACTORY_HARNESS',
  ] as const
  const saved: Record<string, string | undefined> = {}
  let dir: string

  afterEach(() => {
    for (const v of ENV_VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
      delete saved[v]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function set() {
    for (const v of ENV_VARS) saved[v] = process.env[v]
    dir = mkdtempSync(join(tmpdir(), 'lastturn-'))
    const own = join(dir, 'own')
    const repo = join(dir, 'repo')
    mkdirSync(own, { recursive: true })
    mkdirSync(repo, { recursive: true })
    for (const v of ENV_VARS) delete process.env[v]
    Object.assign(process.env, {
      FACTORY_WORKER_DIR: own,
      FACTORY_WORKER_REPO: repo,
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
    })
    return { own, repo }
  }

  test('falls back to the live stream copy when the project transcript does not exist yet', () => {
    const { own } = set()
    writeFileSync(
      join(own, 'claude.jsonl'),
      '{"type":"system","subtype":"init","session_id":"s1"}\n{"type":"assistant","message":{"content":[]}}\n',
    )
    expect(lastTurn('s1')).toBe('{"type":"assistant","message":{"content":[]}}')
  })

  test('falls back to the live stream copy when there is no session yet', () => {
    const { own } = set()
    writeFileSync(join(own, 'claude.jsonl'), '{"type":"assistant","message":{"content":[]}}\n')
    expect(lastTurn(undefined)).toBe('{"type":"assistant","message":{"content":[]}}')
  })

  test('the project transcript wins over the live stream copy once it exists', () => {
    const { own, repo } = set()
    writeFileSync(
      join(own, 'claude.jsonl'),
      '{"type":"assistant","message":{"content":[{"text":"stream"}]}}\n',
    )
    const projectDir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 's1.jsonl'),
      '{"type":"assistant","message":{"content":[{"text":"project"}]}}\n',
    )
    expect(lastTurn('s1')).toBe('{"type":"assistant","message":{"content":[{"text":"project"}]}}')
  })

  test('returns undefined for a non-claude harness, even with a live stream file', () => {
    const { own } = set()
    process.env.FACTORY_HARNESS = 'codex'
    writeFileSync(join(own, 'claude.jsonl'), '{"type":"assistant"}\n')
    expect(lastTurn('s1')).toBeUndefined()
  })
})

// This fixture copies devenv 2.2.2's DEVENV_TASK_FILE shape (tasks.json). A real `devenv print-dev-env` run
// against a services.postgres devenv.nix produced it (claude-factory-5sn verify#1). Oneshots (devenv:enterShell,
// devenv:files) have a command, or null. The service appears as type 'process' under 'devenv:processes:<name>'.
const TASKS_FIXTURE = [
  {
    name: 'devenv:enterShell',
    type: 'oneshot',
    command: '/nix/store/x-devenv-enterShell',
    cwd: null,
    process: { start: { enable: true }, ready: null },
  },
  {
    name: 'devenv:files',
    type: 'oneshot',
    command: null,
    cwd: null,
    process: { start: { enable: true }, ready: null },
  },
  {
    name: 'devenv:processes:postgres',
    type: 'process',
    command: '/nix/store/x-devenv-processes-postgres',
    cwd: null,
    process: {
      start: { enable: true },
      ready: {
        exec: 'pg_isready -d template1 && psql -c "SELECT 1" template1 > /dev/null 2>&1\n',
        http: { get: null },
      },
    },
  },
  {
    name: 'devenv:processes:disabled-worker',
    type: 'process',
    command: '/nix/store/x-devenv-processes-disabled-worker',
    cwd: '/workspace/w/repo/worker',
    process: { start: { enable: false }, ready: null },
  },
]

describe('devenvProcesses', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function fixture(tasks: unknown) {
    dir = mkdtempSync(join(tmpdir(), 'devenv-tasks-'))
    const file = join(dir, 'tasks.json')
    writeFileSync(file, JSON.stringify(tasks))
    return file
  }

  test('returns only the enabled process entries, named without the devenv:processes: prefix', () => {
    const procs = devenvProcesses(fixture(TASKS_FIXTURE))
    expect(procs).toHaveLength(1)
    expect(procs[0]).toMatchObject({
      name: 'postgres',
      command: '/nix/store/x-devenv-processes-postgres',
    })
  })

  test('carries the ready.exec probe', () => {
    const procs = devenvProcesses(fixture(TASKS_FIXTURE))
    expect(procs[0]!.readyExec).toContain('pg_isready')
  })

  // devenv 2.2.2's real shape (claude-factory-5sn.5 review): ready.http.get is an object, not a URL string.
  // after and env sit on the task itself (claude-factory-5sn.6, .7), not inside process.*.
  test('carries the ready.http.get object, the after list, and the env map, from a real devenv shape', () => {
    const procs = devenvProcesses(
      fixture([
        {
          name: 'devenv:processes:web',
          type: 'process',
          command: '/nix/store/x-devenv-processes-web',
          cwd: null,
          after: ['devenv:processes:postgres'],
          env: { FOO: 'bar', BAZ: 'qux' },
          process: {
            start: { enable: true },
            ready: {
              exec: null,
              http: { get: { host: '127.0.0.1', path: '/', port: 18080, scheme: 'http' } },
            },
          },
        },
      ]),
    )
    expect(procs).toHaveLength(1)
    expect(procs[0]!.readyHttp).toEqual({ host: '127.0.0.1', path: '/', port: 18080, scheme: 'http' })
    expect(procs[0]!.readyExec).toBeUndefined()
    expect(procs[0]!.after).toEqual(['devenv:processes:postgres'])
    expect(procs[0]!.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  test('defaults after and env to empty when the task has neither', () => {
    const procs = devenvProcesses(fixture(TASKS_FIXTURE))
    expect(procs[0]!.after).toEqual([])
    expect(procs[0]!.env).toEqual({})
  })

  test('skips a process whose start.enable is false', () => {
    const procs = devenvProcesses(fixture(TASKS_FIXTURE))
    expect(procs.find(p => p.name === 'disabled-worker')).toBeUndefined()
  })

  test('skips oneshot entries (devenv:enterShell, devenv:files)', () => {
    const procs = devenvProcesses(fixture(TASKS_FIXTURE))
    expect(procs.some(p => p.name.includes('enterShell') || p.name.includes('files'))).toBe(false)
  })

  test('returns an empty array for a missing file', () => {
    expect(devenvProcesses(join(tmpdir(), 'no-such-tasks.json'))).toEqual([])
  })

  test('returns an empty array for an unparsable file', () => {
    dir = mkdtempSync(join(tmpdir(), 'devenv-tasks-'))
    const file = join(dir, 'tasks.json')
    writeFileSync(file, 'not json')
    expect(devenvProcesses(file)).toEqual([])
  })
})

// orderByAfter (claude-factory-5sn.6 review): tasks.json lists processes by name, not by dependency. A
// dependent process names its dependency in its own 'after' list; this function must put the dependency first.
describe('orderByAfter', () => {
  const proc = (name: string, after: string[] = []) => ({
    name,
    command: `echo ${name}`,
    after,
    env: {},
  })

  test('puts a dependency before the process that names it in after, even in reverse input order', () => {
    const ordered = orderByAfter([proc('after-web', ['devenv:processes:web']), proc('web')])
    expect(ordered.map(p => p.name)).toEqual(['web', 'after-web'])
  })

  test('strips the devenv:processes: prefix and an @suffix to match a dependency', () => {
    const ordered = orderByAfter([proc('after-web', ['devenv:processes:web@ready']), proc('web')])
    expect(ordered.map(p => p.name)).toEqual(['web', 'after-web'])
  })

  test('leaves independent processes in their input order', () => {
    const ordered = orderByAfter([proc('b'), proc('a')])
    expect(ordered.map(p => p.name)).toEqual(['b', 'a'])
  })

  test('ignores an after entry naming a task outside the list (a oneshot, say)', () => {
    const ordered = orderByAfter([proc('web', ['devenv:enterShell'])])
    expect(ordered.map(p => p.name)).toEqual(['web'])
  })

  test('does not loop forever on a cycle', () => {
    const ordered = orderByAfter([proc('a', ['devenv:processes:b']), proc('b', ['devenv:processes:a'])])
    expect(ordered.map(p => p.name).sort()).toEqual(['a', 'b'])
  })
})

// servicesWaitMs (claude-factory-5sn.8 review): Number('abc') is NaN, and `elapsed >= NaN` is never true, so a
// bad FACTORY_SERVICES_WAIT_MS must fall back to the 120000ms default, not block the first turn forever.
describe('servicesWaitMs', () => {
  const saved = { v: process.env.FACTORY_SERVICES_WAIT_MS }
  afterEach(() => {
    if (saved.v === undefined) delete process.env.FACTORY_SERVICES_WAIT_MS
    else process.env.FACTORY_SERVICES_WAIT_MS = saved.v
  })

  test('defaults to 120000 when unset', () => {
    delete process.env.FACTORY_SERVICES_WAIT_MS
    expect(servicesWaitMs()).toBe(120_000)
  })

  test('uses a given positive, finite value', () => {
    process.env.FACTORY_SERVICES_WAIT_MS = '5000'
    expect(servicesWaitMs()).toBe(5000)
  })

  test('falls back to 120000 for a non-numeric value', () => {
    process.env.FACTORY_SERVICES_WAIT_MS = 'abc'
    expect(servicesWaitMs()).toBe(120_000)
  })

  test('falls back to 120000 for a zero or negative value', () => {
    process.env.FACTORY_SERVICES_WAIT_MS = '0'
    expect(servicesWaitMs()).toBe(120_000)
    process.env.FACTORY_SERVICES_WAIT_MS = '-5'
    expect(servicesWaitMs()).toBe(120_000)
  })
})

// databaseUrl's shape (A2): a TCP PGHOST wins as host:port, a socket-dir PGHOST (starts with '/') is
// url-encoded into ?host=, and a devenv.nix that already sets DATABASE_URL always wins over both.
describe('databaseUrl', () => {
  test('builds postgresql://host:port/postgres for a TCP PGHOST', () => {
    expect(databaseUrl({ PGHOST: '127.0.0.1', PGPORT: '5432' })).toBe('postgresql://127.0.0.1:5432/postgres')
  })

  test('builds a host-query URL for a socket-dir PGHOST', () => {
    const url = databaseUrl({ PGHOST: '/tmp/devenv-abc/postgres', PGPORT: '5432' })
    expect(url).toBe('postgresql:///postgres?host=%2Ftmp%2Fdevenv-abc%2Fpostgres&port=5432')
  })

  test('an existing DATABASE_URL wins over PGHOST/PGPORT', () => {
    expect(databaseUrl({ DATABASE_URL: 'postgresql://x/already', PGHOST: '127.0.0.1', PGPORT: '5432' })).toBe(
      'postgresql://x/already',
    )
  })

  test('returns undefined with no PGHOST and no PGPORT', () => {
    expect(databaseUrl({})).toBeUndefined()
  })
})

// startServices (claude-factory-5sn.2): runs a devenv process's own command directly, never `devenv up` or
// `devenv shell`, so an enterShell oneshot in the same tasks.json must never run (A4). Each spawned command
// echoes a unique tag so afterEach can pkill it, instead of leaking a background `sleep`.
describe('startServices', () => {
  const TAG = 'worker-test-5sn-tag'
  const ENV_VARS = [
    'FACTORY_WORKER_DIR',
    'FACTORY_WORKER_REPO',
    'DEVENV_TASK_FILE',
    'FACTORY_SERVICES',
    'FACTORY_SERVICES_WAIT_MS',
    'PGHOST',
    'PGPORT',
    'DATABASE_URL',
  ] as const
  const saved: Record<string, string | undefined> = {}
  let dir: string

  afterEach(() => {
    Bun.spawnSync(['pkill', '-f', TAG])
    for (const v of ENV_VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
      delete saved[v]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function set(vars: Partial<Record<(typeof ENV_VARS)[number], string>> = {}) {
    for (const v of ENV_VARS) saved[v] = process.env[v]
    for (const v of ENV_VARS) delete process.env[v]
    dir = mkdtempSync(join(tmpdir(), 'start-services-'))
    const own = join(dir, 'own')
    const repo = join(dir, 'repo')
    mkdirSync(own, { recursive: true })
    mkdirSync(repo, { recursive: true })
    Object.assign(process.env, { FACTORY_WORKER_DIR: own, FACTORY_WORKER_REPO: repo })
    Object.assign(process.env, vars)
    return { own }
  }

  function tasksFile(tasks: unknown) {
    const file = join(dir, 'tasks.json')
    writeFileSync(file, JSON.stringify(tasks))
    return file
  }

  test('starts an enabled process, waits for its ready probe, logs it, and sets DATABASE_URL', async () => {
    const { own } = set({ PGHOST: '127.0.0.1', PGPORT: '55432' })
    const marker = join(dir, 'ready-marker')
    const entershellMarker = join(dir, 'entershell-marker')
    process.env.DEVENV_TASK_FILE = tasksFile([
      {
        name: 'devenv:enterShell',
        type: 'oneshot',
        command: `touch ${entershellMarker}`,
        cwd: null,
        process: { start: { enable: true }, ready: null },
      },
      {
        name: 'devenv:processes:postgres',
        type: 'process',
        command: `echo ${TAG}; touch ${marker}; exec sleep 5`,
        cwd: null,
        process: { start: { enable: true }, ready: { exec: `test -f ${marker}` } },
      },
    ])
    const results = await startServices()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      name: 'postgres',
      ok: true,
      log: join(own, 'services', 'postgres.log'),
    })
    expect(results[0]!.detail).toMatch(/^ready in \ds$/)
    expect(existsSync(join(own, 'services', 'postgres.log'))).toBe(true)
    // the oneshot never ran: only the process's own command does (A4)
    expect(existsSync(entershellMarker)).toBe(false)
    expect(readFileSync(join(own, 'serve.log'), 'utf8')).toContain('services: postgres ready in')
    expect(process.env.DATABASE_URL).toBe('postgresql://127.0.0.1:55432/postgres')
  })

  test('a process that exits leaves a failed result naming the exit code', async () => {
    const { own } = set()
    process.env.DEVENV_TASK_FILE = tasksFile([
      {
        name: 'devenv:processes:broken',
        type: 'process',
        command: `echo ${TAG}; exit 7`,
        cwd: null,
        process: { start: { enable: true }, ready: { exec: 'exit 1' } },
      },
    ])
    const results = await startServices()
    expect(results).toEqual([
      { name: 'broken', ok: false, log: join(own, 'services', 'broken.log'), detail: 'exit 7' },
    ])
    expect(readFileSync(join(own, 'serve.log'), 'utf8')).toContain('services: broken failed: exit 7')
  }, 10_000)

  test('a process whose ready probe never passes times out at FACTORY_SERVICES_WAIT_MS', async () => {
    const { own } = set({ FACTORY_SERVICES_WAIT_MS: '1500' })
    process.env.DEVENV_TASK_FILE = tasksFile([
      {
        name: 'devenv:processes:slow',
        type: 'process',
        command: `echo ${TAG}; exec sleep 5`,
        cwd: null,
        process: { start: { enable: true }, ready: { exec: 'exit 1' } },
      },
    ])
    const results = await startServices()
    expect(results[0]).toMatchObject({ name: 'slow', ok: false })
    expect(results[0]!.detail).toMatch(/^not ready after \ds$/)
    expect(readFileSync(join(own, 'serve.log'), 'utf8')).toContain('services: slow failed: not ready after')
  }, 10_000)

  test('FACTORY_SERVICES=0 spawns nothing and leaves DATABASE_URL unset', async () => {
    const { own } = set({ FACTORY_SERVICES: '0', PGHOST: '127.0.0.1', PGPORT: '5432' })
    process.env.DEVENV_TASK_FILE = tasksFile([
      {
        name: 'devenv:processes:postgres',
        type: 'process',
        command: `echo ${TAG}; exit 1`,
        cwd: null,
        process: { start: { enable: true }, ready: null },
      },
    ])
    const results = await startServices()
    expect(results).toEqual([])
    expect(existsSync(join(own, 'services'))).toBe(false)
    expect(process.env.DATABASE_URL).toBeUndefined()
  })

  test('no DEVENV_TASK_FILE spawns nothing', async () => {
    const { own } = set()
    const results = await startServices()
    expect(results).toEqual([])
    expect(existsSync(join(own, 'services'))).toBe(false)
  })

  test('a devenv with only oneshots spawns nothing', async () => {
    set()
    process.env.DEVENV_TASK_FILE = tasksFile([
      {
        name: 'devenv:enterShell',
        type: 'oneshot',
        command: `echo ${TAG}; touch ${join(dir, 'marker')}`,
        cwd: null,
        process: { start: { enable: true }, ready: null },
      },
    ])
    const results = await startServices()
    expect(results).toEqual([])
  })

  // claude-factory-5sn.5 review: devenv's ready.http.get is an object ({host,port,path,scheme}), not a URL
  // string. A real Bun.serve server stands in for the probed process; fetch() must build its URL, not throw.
  test('an http ready probe builds the URL from the devenv {host,port,path,scheme} object', async () => {
    set()
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    try {
      process.env.DEVENV_TASK_FILE = tasksFile([
        {
          name: 'devenv:processes:web',
          type: 'process',
          command: `echo ${TAG}; exec sleep 5`,
          cwd: null,
          process: {
            start: { enable: true },
            ready: {
              exec: null,
              http: { get: { host: '127.0.0.1', path: '/', port: server.port, scheme: 'http' } },
            },
          },
        },
      ])
      const results = await startServices()
      expect(results[0]).toMatchObject({ name: 'web', ok: true })
    } finally {
      server.stop(true)
    }
  })

  // claude-factory-iap review: a Bun.serve handler that never answers must not block waitReady past its own
  // 4s fetch timeout. The test sets idleTimeout: 0, because Bun.serve's default 10s idle timeout would
  // otherwise close the socket first and return at about 10s for the wrong reason.
  test('an http ready probe that never answers times out at its own 4s budget, not FACTORY_SERVICES_WAIT_MS', async () => {
    set({ FACTORY_SERVICES_WAIT_MS: '1500' })
    const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) })
    try {
      process.env.DEVENV_TASK_FILE = tasksFile([
        {
          name: 'devenv:processes:web',
          type: 'process',
          command: `echo ${TAG}; exec sleep 10`,
          cwd: null,
          process: {
            start: { enable: true },
            ready: {
              exec: null,
              http: { get: { host: '127.0.0.1', path: '/', port: server.port, scheme: 'http' } },
            },
          },
        },
      ])
      const t0 = Date.now()
      const results = await startServices()
      expect(Date.now() - t0).toBeLessThan(7000)
      expect(results[0]).toMatchObject({ name: 'web', ok: false })
      expect(results[0]!.detail).toMatch(/^not ready after \ds$/)
    } finally {
      server.stop(true)
    }
  }, 20_000)

  // claude-factory-5sn.7 review: processes.<name>.env lands in the task's own 'env' field, which the command
  // script never holds. Both the spawn and the ready probe must see it merged over the serve process's env.
  test("merges the task's own env over the serve env, for both the spawn and the ready probe", async () => {
    set()
    const marker = join(dir, 'env-marker')
    process.env.DEVENV_TASK_FILE = tasksFile([
      {
        name: 'devenv:processes:web',
        type: 'process',
        command: `echo ${TAG}; echo "$FOO" > ${marker}; exec sleep 5`,
        cwd: null,
        env: { FOO: 'bar' },
        process: { start: { enable: true }, ready: { exec: 'test "$FOO" = bar' } },
      },
    ])
    const results = await startServices()
    expect(results[0]).toMatchObject({ name: 'web', ok: true })
    // the ready probe can pass before the spawned shell writes the marker: wait for it
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 50))
    // ponytail: the file can exist before the echo writes; a short wait lets the write land
    await new Promise(r => setTimeout(r, 50))
    expect(readFileSync(marker, 'utf8').trim()).toBe('bar')
  })

  // claude-factory-5sn.6 review: tasks.json lists devenv:processes:after-web before devenv:processes:web
  // (alphabetical), but after-web's own 'after' names web. startServices must start web first.
  test('starts a dependency before the process that names it in after, even in reverse tasks.json order', async () => {
    set()
    const orderLog = join(dir, 'order.log')
    process.env.DEVENV_TASK_FILE = tasksFile([
      {
        name: 'devenv:processes:after-web',
        type: 'process',
        command: `echo ${TAG}; echo after-web >> ${orderLog}; exec sleep 5`,
        cwd: null,
        after: ['devenv:processes:web'],
        process: { start: { enable: true }, ready: { exec: 'exit 0' } },
      },
      {
        name: 'devenv:processes:web',
        type: 'process',
        command: `echo ${TAG}; echo web >> ${orderLog}; exec sleep 5`,
        cwd: null,
        process: { start: { enable: true }, ready: { exec: 'exit 0' } },
      },
    ])
    const results = await startServices()
    expect(results.map(r => r.name)).toEqual(['web', 'after-web'])
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['web', 'after-web'])
  })
})

describe('servicesNote', () => {
  test('names ready and failed processes and says DATABASE_URL is set', () => {
    const note = servicesNote(
      [
        { name: 'postgres', ok: true, log: '/x/postgres.log', detail: 'ready in 4s' },
        { name: 'redis', ok: false, log: '/x/redis.log', detail: 'not ready after 120s' },
      ],
      { DATABASE_URL: 'postgresql://x/postgres' },
    )
    expect(note).toContain('ready: postgres')
    expect(note).toContain('failed: redis (not ready after 120s, see /x/redis.log)')
    expect(note).toContain('DATABASE_URL is set.')
  })

  test('is empty with no results', () => {
    expect(servicesNote([], {})).toBe('')
  })

  test('omits the DATABASE_URL line when it is not set', () => {
    const note = servicesNote([{ name: 'redis', ok: true, log: '/x/redis.log', detail: 'ready in 1s' }], {})
    expect(note).not.toContain('DATABASE_URL')
  })
})

// claude-factory-9wu.1: a worker's scratch dir (.scratch/ in the worktree) must stay untracked without a commit,
// in every rig repo, not only claude-factory -- so it goes in the shared info/exclude, not a committed .gitignore.
describe('excludeScratch', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('adds .scratch/ to the common info/exclude once, keeps other lines, and git then ignores it in a worktree', () => {
    dir = mkdtempSync(join(tmpdir(), 'excludescratch-'))
    const main = join(dir, 'main')
    mkdirSync(main, { recursive: true })
    sh(['git', 'init', '-q'], main)
    sh(['git', 'config', 'user.email', 'a@b.c'], main)
    sh(['git', 'config', 'user.name', 'a'], main)
    writeFileSync(join(main, 'f'), 'x')
    sh(['git', 'add', 'f'], main)
    sh(['git', 'commit', '-q', '-m', 'init'], main)
    const common = sh(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], main)
    mkdirSync(join(common, 'info'), { recursive: true })
    writeFileSync(join(common, 'info', 'exclude'), '*.log\n')

    const wt = join(dir, 'wt')
    sh(['git', 'worktree', 'add', '-q', '-b', 'feature', wt], main)

    excludeScratch(wt)
    excludeScratch(wt) // a second call must add no second line

    const exclude = readFileSync(join(common, 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter(l => l === '.scratch/').length).toBe(1)
    expect(exclude).toContain('*.log') // an existing line stays

    mkdirSync(join(wt, '.scratch', 'a'), { recursive: true })
    writeFileSync(join(wt, '.scratch', 'a', 'b'), 'scratch')
    expect(sh(['git', 'status', '--porcelain'], wt)).toBe('')
    expect(Bun.spawnSync(['git', 'check-ignore', '.scratch/a/b'], { cwd: wt }).exitCode).toBe(0)
  })
})
