import { describe, expect, test, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bazelrc, lastTurn } from './worker'

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
