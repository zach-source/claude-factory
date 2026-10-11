// The coding agents a station's worker can run as. herdr detects each in its pane (status, session),
// so the runner watches them all the same way; they differ only in how a launch, a resume and an
// MCP config are spelled on the command line.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export type Harness = 'claude' | 'codex' | 'pi'

/** a server as Claude's --mcp-config writes it: a command to run, or a url to reach */
export type McpServer = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
export type Mcp = { file: string; servers: Record<string, McpServer> }

const exeOf = (cmd: string) => basename(cmd.trim().split(/\s+/)[0] ?? '')

/**
 * the command that starts a fresh Claude Code session: FACTORY_CLAUDE swaps the wrapper (plain `claude`,
 * another wrapper) and its own flags. Read on each call, so a factory follows its environment.
 */
export const claudeCommand = () => process.env.FACTORY_CLAUDE?.trim() || 'claude-smart --new --no-channels'

/** the harness a worker command runs, from its first word; null for anything else (a script, a fake) */
export function harnessOf(agent: string): Harness | null {
  const exe = exeOf(agent)
  if (/^claude/.test(exe) || exe === exeOf(claudeCommand())) return 'claude' // claude, claude-smart, FACTORY_CLAUDE's
  return exe === 'codex' || exe === 'pi' ? exe : null
}

/** an MCP config file in Claude's shape ({ mcpServers }), checked once where a rig names it */
export function readMcp(file: string): Mcp {
  const servers = JSON.parse(readFileSync(file, 'utf8')).mcpServers
  if (!servers || typeof servers !== 'object') throw new Error(`${file} has no "mcpServers" object`)
  for (const [name, s] of Object.entries<McpServer>(servers)) {
    // codex addresses a server as the config key mcp_servers.<name>
    if (!/^[\w-]+$/.test(name)) throw new Error(`MCP server name "${name}": letters, digits, - and _ only`)
    if (!s.command === !s.url) throw new Error(`MCP server "${name}": give a command or a url, not both`)
  }
  return { file, servers }
}

export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// TOML basic strings take JSON's escapes, so JSON spells codex's inline tables
const toml = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(toml).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.entries(v)
          .map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`)
          .join(',')}}`
      : JSON.stringify(v)

/** codex reads MCP servers from config.toml: each one becomes a -c override of mcp_servers.<name> */
export const codexMcp = (servers: Record<string, McpServer>) =>
  Object.entries(servers)
    .map(([name, { command, args, env, url, headers }]) => {
      const t = url
        ? { url, ...(headers && { http_headers: headers }) }
        : { command, args: args ?? [], ...(env && { env }) }
      return ` -c ${sq(`mcp_servers.${name}=${toml(t)}`)}`
    })
    .join('')

/**
 * the shell line that starts a worker on the prompt file, or resumes its session with the prompt as
 * the next turn. `extra` is what only Claude takes (the --settings that leaves out herdr-fleet).
 */
export function command(
  agent: string,
  prompt: string,
  o: { session?: string; mcp?: Mcp; extra?: string } = {},
) {
  const text = `"$(cat ${sq(prompt)})"`
  const { session, mcp } = o
  switch (harnessOf(agent)) {
    case 'claude': {
      const base = session ? `${agent.replace(/\s--new\b/, '')} --resume ${sq(session)}` : agent
      return `${base}${mcp ? ` --mcp-config ${sq(mcp.file)}` : ''}${o.extra ?? ''} ${text}`
    }
    case 'codex': {
      const flags = mcp ? codexMcp(mcp.servers) : ''
      if (!session) return `${agent}${flags} ${text}`
      // codex resume [OPTIONS] [SESSION_ID] [PROMPT]: the subcommand goes right after the executable
      const [exe, ...rest] = agent.trim().split(/\s+/)
      return `${exe} resume${rest.length ? ` ${rest.join(' ')}` : ''}${flags} ${sq(session)} ${text}`
    }
    case 'pi': {
      // ponytail: pi has no MCP client of its own; say so in the pane rather than drop the config silently.
      // A pi MCP extension (e.g. pi-mcp-adapter) passed in the rig's --agent would cover it.
      const warn = mcp ? `echo ${sq(`factory: pi has no MCP client, so ${mcp.file} is not loaded`)}; ` : ''
      return `${warn}${agent}${session ? ` --session ${sq(session)}` : ''} ${text}`
    }
    default:
      return `${agent} ${text}`
  }
}
