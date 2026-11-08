import { expect, spyOn, test } from 'bun:test'
import { validateRig, type Rig } from './cli'

const base: Rig = { name: 'acme', repo: '/r', factory: 'lifecycle' }
const bad = (over: Partial<Rig>, msg: string, env: NodeJS.ProcessEnv = {}) =>
  expect(() => validateRig({ ...base, ...over }, env)).toThrow(msg)
const ok = (over: Partial<Rig>, env: NodeJS.ProcessEnv = {}) => validateRig({ ...base, ...over }, env)
const eg = [{ hosts: ['api.openai.com'], key: 'OPENAI' }]

test('runner is an own key of runners', () => {
  for (const runner of [undefined, 'herdr', 'ax']) expect(ok({ runner })).toEqual([])
  bad({ runner: 'nope' }, '--runner is herdr, ax (not "nope")')
  for (const runner of ['constructor', 'toString', '']) bad({ runner }, '--runner is')
})

test('mcp only for a local non-pi worker', () => {
  bad({ runner: 'ax', mcp: '/m.json' }, '--mcp does not reach a ax worker')
  bad({ agent: 'pi', mcp: '/m.json' }, '--mcp does not reach a pi worker')
  ok({ mcp: '/m.json' })
  ok({ agent: 'claude', mcp: '/m.json' })
})

test('agent', () => {
  bad({ runner: 'ax', agent: 'my-script' }, 'claude, codex, cursor, grok or pi')
  bad({ runner: 'ax', agent: 'codex -m o3' }, 'FACTORY_AX_CODEX=1')
  bad({ agent: '   ' }, '--agent is the worker command')
  ok({ runner: 'ax', agent: 'codex -m o3' }, { FACTORY_AX_CODEX: '1' })
  ok({ runner: 'ax', agent: 'pi' })
  ok({ agent: 'my-script' })
})

test('egress needs a remote runner and warns on a registry host', () => {
  bad({ egress: eg }, 'add --runner ax')
  expect(ok({ runner: 'ax', egress: eg })).toEqual([])
  expect(ok({ egress: [] })).toEqual([])
  expect(ok({ egress: undefined })).toEqual([])
  const w = ok({ runner: 'ax', egress: [{ hosts: ['PyPI.org', 'api.openai.com'], key: 'K' }] })
  expect(w).toHaveLength(1)
  expect(w[0]).toContain('PyPI.org is a package registry host')
})

test('beadsRemote', () => {
  const r = { name: 'origin', url: 'https://beads-dolt.example:50051/db', user: 'acme' }
  ok({ beadsRemote: r })
  ok({ beadsRemote: undefined })
  for (const o of [
    { name: 'a b' },
    { name: "x');--" },
    { user: '' },
    { user: 'a,b' },
    { url: 'not a url' },
    { url: '' },
  ])
    bad({ beadsRemote: { ...r, ...o } }, 'beadsRemote')
})

test('max, slo, drift, sweeps', () => {
  for (const maxRuns of [0, -1, 1.5, NaN]) bad({ maxRuns }, '--max')
  bad({ slo: '  ' }, '--slo')
  bad({ drift: '' }, '--drift')
  bad({ sweeps: ['monitor'] }, 'monitor needs --slo')
  bad({ sweeps: ['drift'] }, 'drift needs --drift')
  ok({ maxRuns: 1 })
  ok({ sweeps: ['monitor'], slo: 'kubectl get pods' })
})

test('validateRig does no console output', () => {
  const w = spyOn(console, 'warn')
  const e = spyOn(console, 'error')
  ok({ runner: 'ax', egress: [{ hosts: ['pypi.org'], key: 'K' }] })
  expect(w).not.toHaveBeenCalled()
  expect(e).not.toHaveBeenCalled()
})
