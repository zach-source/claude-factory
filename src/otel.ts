import type { Egress } from './ax'

export type OtelTags = {
  run: string
  station: string
  rig: string
  attempt: string
  harness: string
  model: string
}

export type Otel = {
  /** Claude's env */
  env: Record<string, string>
  /** codex reads its exporters from config.toml; only the resource tags come by env */
  codexEnv: Record<string, string>
  /** the [otel] block to append to codex's config.toml */
  toml: string
  egress: Egress & { port: number }
}

/**
 * The OTel export settings for one worker launch (claude-factory-ozso), or undefined when `endpoint` is
 * unset or is not a plain http(s) URL with no userinfo, query or path: then a launch carries no OTel.
 * `content` false drops tool details (Claude) and the log exporter (codex).
 * ponytail: codex has no tool-detail switch, and its log events carry tool arguments and output, so content
 * off drops all codex logs; traces and metrics stay.
 */
export function otelOf(endpoint: string | undefined, tags: OtelTags, content = true): Otel | undefined {
  let u: URL
  try {
    u = new URL(endpoint?.trim() ?? '')
  } catch {
    return undefined
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    return undefined
  if (u.pathname !== '/') return undefined
  const base = `${u.protocol}//${u.host}`
  const attrs = Object.entries(tags)
    .map(([k, v]) => `factory.${k}=${encodeURIComponent(v)}`)
    .join(',')
  const exp = (p: string) =>
    `{ otlp-http = { endpoint = ${JSON.stringify(`${base}/v1/${p}`)}, protocol = "json" } }`
  return {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_TRACES_EXPORTER: 'otlp',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: base,
      OTEL_RESOURCE_ATTRIBUTES: attrs,
      ...(content && { OTEL_LOG_TOOL_DETAILS: '1' }),
    },
    codexEnv: { OTEL_RESOURCE_ATTRIBUTES: attrs },
    toml:
      `\n[otel]\nenvironment = "factory"\nlog_user_prompt = false\n` +
      (content ? `exporter = ${exp('logs')}\n` : '') +
      `trace_exporter = ${exp('traces')}\nmetrics_exporter = ${exp('metrics')}\n`,
    egress: {
      hosts: [u.hostname],
      port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443),
      http: u.protocol === 'http:',
    },
  }
}
