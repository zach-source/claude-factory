import { describe, expect, test, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bazelrc, databaseUrl, devenvProcesses, lastTurn } from './worker'

// bazelrc()'s pkg-gate propagation (ei0.5, commit 3a6d54d): when launch() set registry env vars in the VM,
// rules_go/rules_python/rules_js must fetch through the gate too, via `common --repo_env=<VAR>=<value>` lines.
// Mutation-verified gap (ei0.7, verify#1): deleting that block left `bun test` all green, since nothing else
// exercised it -- this test is the regression guard.
describe('bazelrc', () => {
  const ENV_VARS = ['FACTORY_BAZELRC', 'FACTORY_CA', 'GOPROXY', 'PIP_INDEX_URL', 'NPM_CONFIG_REGISTRY'] as const
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
    set({ GOPROXY: 'http://pkg-gate:8080/go', PIP_INDEX_URL: 'http://pkg-gate:8080/pypi/simple', NPM_CONFIG_REGISTRY: 'http://pkg-gate:8080/npm' })
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
})

// lastTurn's live-stream fallback (claude-factory-xq3): the project transcript
// (~/.claude/projects/.../<session>.jsonl) is empty or missing for a turn's whole length when the session is
// learned only at the end (see ax.test.ts's mid-turn test) -- own()/claude.jsonl, which turn() streams to as
// the turn runs, is what poll must fall back to so it has something to read meanwhile.
describe('lastTurn', () => {
  const ENV_VARS = ['FACTORY_WORKER_DIR', 'FACTORY_WORKER_REPO', 'CLAUDE_CONFIG_DIR', 'FACTORY_HARNESS'] as const
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
    writeFileSync(join(own, 'claude.jsonl'), '{"type":"assistant","message":{"content":[{"text":"stream"}]}}\n')
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
