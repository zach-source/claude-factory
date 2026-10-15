import { describe, expect, test, afterEach } from 'bun:test'
import { bazelrc } from './worker'

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
