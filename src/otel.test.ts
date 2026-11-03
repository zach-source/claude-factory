import { expect, test } from 'bun:test'
import { otelEnvOf, otelOf } from './otel'

const tags = { run: 'r-1', station: 'implement', rig: 'acme', attempt: '2', harness: 'claude', model: 'opus' }

test.each([
  undefined,
  '',
  '  ',
  'ftp://h:4318',
  'http://u:p@h:4318',
  'http://h:4318/v1/logs',
  'http://h:4318?x=1',
  'not a url',
])('otelOf gives nothing for %p', e => {
  expect(otelOf(e, tags)).toBeUndefined()
})

test('otelOf on: env, toml and egress', () => {
  const o = otelOf('http://otel.example.svc:4318/', tags)!
  expect(o.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel.example.svc:4318')
  expect(o.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
    'factory.run=r-1,factory.station=implement,factory.rig=acme,factory.attempt=2,factory.harness=claude,factory.model=opus',
  )
  expect(o.env.OTEL_LOG_TOOL_DETAILS).toBe('1')
  expect(o.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
  expect(o.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json')
  // claude-factory-gclk: Prometheus OTLP refuses delta sums with HTTP 500
  expect(o.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe('cumulative')
  expect(o.codexEnv).toEqual({ OTEL_RESOURCE_ATTRIBUTES: o.env.OTEL_RESOURCE_ATTRIBUTES! })
  for (const p of ['/v1/logs', '/v1/traces', '/v1/metrics'])
    expect(o.toml).toContain(`endpoint = "http://otel.example.svc:4318${p}", protocol = "json"`)
  expect(o.egress).toEqual({ hosts: ['otel.example.svc'], port: 4318, http: true })
  expect(otelOf('https://otel.example.svc', tags)!.egress).toEqual({
    hosts: ['otel.example.svc'],
    port: 443,
    http: false,
  })
})

test('otelOf encodes tag values', () => {
  const o = otelOf('http://h.example.svc:4318', { ...tags, model: 'claude-opus-5-5[1m]', rig: 'a,b c' })!
  const a = o.env.OTEL_RESOURCE_ATTRIBUTES!
  expect(a.split(',').length).toBe(6)
  expect(a).not.toContain(' ')
  expect(a).toContain('factory.model=claude-opus-5-5%5B1m%5D')
  expect(a).toContain('factory.rig=a%2Cb%20c')
})

test('otelOf content off drops tool details and the codex log exporter, never sends prompts', () => {
  const on = otelOf('http://h.example.svc:4318', tags)!
  const off = otelOf('http://h.example.svc:4318', tags, false)!
  expect(off.env.OTEL_LOG_TOOL_DETAILS).toBeUndefined()
  expect(off.toml).not.toMatch(/^exporter =/m)
  expect(off.toml).toMatch(/^trace_exporter =/m)
  expect(off.toml).toMatch(/^metrics_exporter =/m)
  expect(on.toml).toMatch(/^exporter =/m)
  for (const o of [on, off]) {
    expect(JSON.stringify(o.env)).not.toContain('OTEL_LOG_USER_PROMPTS')
    expect(o.toml).toContain('log_user_prompt = false')
  }
})

test('otelEnvOf accepts only a JSON object of allowed OTel names with string values, else refuses the whole pack', () => {
  const pack = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://o:4318', CLAUDE_CODE_ENABLE_TELEMETRY: '1' }
  expect(otelEnvOf(JSON.stringify(pack))).toEqual(pack)
  expect(otelEnvOf(JSON.stringify({ CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' }))).toEqual({
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  })
  const bad = [
    undefined,
    '',
    '{not json',
    '[]',
    'null',
    '1',
    JSON.stringify({ OTEL_X: 1 }),
    JSON.stringify({ ...pack, PATH: '/x' }),
    JSON.stringify({ ...pack, FACTORY_HOME: '/x' }),
    JSON.stringify({ ...pack, otel_x: 'a' }),
  ]
  for (const raw of bad) expect(otelEnvOf(raw)).toEqual({})
})
