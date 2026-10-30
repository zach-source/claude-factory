// The coding agents a station's worker can run as. herdr detects each in its pane (status, session),
// so the runner watches them all the same way; they differ only in how a launch, a resume and an
// MCP config are spelled on the command line.
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

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

/** the plugins in the worker image (Dockerfile.worker), by skill name: the one registry of known skills (constitution I) */
export const VM_PLUGINS: Record<string, string> = { 'asd-ste100': '/opt/plugins/asd-ste100' }

/** the skill dirs (<plugin>/skills/<name>) of these plugin dirs; a plugin with no skills adds none */
export const skillDirs = (plugins: string[]) =>
  plugins.flatMap(p => {
    try {
      return readdirSync(join(p, 'skills'), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => join(p, 'skills', d.name))
    } catch {
      return []
    }
  })

/**
 * puts the plugins' skills in a codex home's skills dir, where codex finds them at start (constitution I). It
 * copies, not links: a link out of the home lets codex write into the person's plugin. The rm first clears a
 * read-only copy (a Nix store source) that a resume would not overwrite.
 */
export function codexSkills(home: string, plugins: string[]) {
  const to = join(home, 'skills')
  rmSync(to, { recursive: true, force: true })
  for (const s of skillDirs(plugins)) cpSync(s, join(to, basename(s)), { recursive: true })
}

// the events `bd init`'s codex hooks use; none of them can run or block a tool call
const BEADS_CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact']

/**
 * true when a repo's .codex dir is the one `bd init` writes and nothing else: config.toml turns on only
 * `features.hooks`, and hooks.json runs only `bd codex-hook <event>` at the events above. That dir adds no tool
 * and turns no guard part off, so a codex worker may run with it (claude-factory-8cu6). Any other file, key,
 * event or command, or a file that does not parse, is not vetted, and the guard still refuses the dir.
 */
export function beadsOnlyCodexDir(dir: string) {
  type Hook = Record<string, unknown>
  try {
    if (readdirSync(dir).sort().join() !== 'config.toml,hooks.json') return false
    const config = Bun.TOML.parse(readFileSync(join(dir, 'config.toml'), 'utf8'))
    if (JSON.stringify(config) !== '{"features":{"hooks":true}}') return false
    const file = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Hook[]>
    }
    if (Object.keys(file).join() !== 'hooks') return false
    const only = (o: Hook, keys: string[]) => Object.keys(o).every(k => keys.includes(k))
    return Object.entries(file.hooks).every(
      ([event, groups]) =>
        BEADS_CODEX_EVENTS.includes(event) &&
        groups.every(
          g =>
            only(g, ['hooks', 'matcher']) &&
            (g.hooks as Hook[]).every(
              h =>
                only(h, ['type', 'command', 'statusMessage', 'timeout']) &&
                h.type === 'command' &&
                h.command === `bd codex-hook ${event}`,
            ),
        ),
    )
  } catch {
    return false
  }
}

/** pi's flags for the worker rules (a system prompt file) and the plugins' skills (constitution I) */
export const piFlags = (rules: string, plugins: string[]) => [
  ...['--append-system-prompt', rules],
  ...skillDirs(plugins).flatMap(s => ['--skill', s]),
]

/** the harness a worker command runs, from its first word; null for anything else (a script, a fake) */
export function harnessOf(agent: string): Harness | null {
  const exe = exeOf(agent)
  if (/^claude/.test(exe) || exe === exeOf(claudeCommand())) return 'claude' // claude, claude-smart, FACTORY_CLAUDE's
  return exe === 'codex' || exe === 'pi' ? exe : null
}

// The guard must turn off these codex features. Each one lets a command run without the PreToolUse hook (claude-factory-x0b9).
export const CODEX_UNGUARDED = ['unified_exec', 'shell_snapshot', 'multi_agent', 'code_mode']
// codex ignores --disable unified_exec: only a managed pin turns it off, and write_stdin skips the hook (claude-factory-fzm3)
export const CODEX_PIN = '/etc/codex/requirements.toml'
/** the codex flags a worker runs with: the hooks on, every unguarded feature off. A pane and a VM use the same ones */
export const CODEX_GUARD_FLAGS = [
  ...['--enable', 'hooks', '--dangerously-bypass-hook-trust'],
  ...CODEX_UNGUARDED.flatMap(f => ['--disable', f]),
  ...['--disable', 'apps', '--disable', 'memories'],
]
/** what in `codex features list` output says the guard is not in force, or undefined when it is */
export function codexFeaturesBad(out: string) {
  const on = new Map<string, string>()
  for (const l of out.split('\n')) {
    const c = l.trim().split(/\s+/)
    if (c.length >= 2) on.set(c[0]!, c[c.length - 1]!)
  }
  if (on.get('hooks') !== 'true') return 'hooks is not on'
  const f = CODEX_UNGUARDED.find(f => on.get(f) !== 'false')
  return f === 'unified_exec'
    ? `unified_exec is not off: pin it in ${CODEX_PIN} with [features] unified_exec = false, claude-factory-fzm3`
    : f
}

// tools that only read: a call cut off mid-way is safe to run again
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite']

/**
 * The last tool call in a Claude transcript tail (the session file, or `claude -p` stream-json) that has no
 * result: the call a crash cut off. Undefined when every call got its result (claude-factory-p0yt).
 */
export function cutOffCall(tail: string) {
  const open = new Map<string, { name: string; input: Record<string, unknown> }>()
  for (const line of tail.split('\n')) {
    let e: { type?: string; message?: { content?: unknown } }
    try {
      e = JSON.parse(line)
    } catch {
      continue // the tail's first line is cut, or a line is not JSON
    }
    const content = Array.isArray(e?.message?.content) ? (e.message.content as Record<string, unknown>[]) : []
    for (const b of content) {
      if (e.type === 'assistant' && b.type === 'tool_use')
        open.set(String(b.id), { name: String(b.name), input: (b.input as Record<string, unknown>) ?? {} })
      if (e.type === 'user' && b.type === 'tool_result') open.delete(String(b.tool_use_id))
    }
  }
  return [...open.values()].at(-1)
}

/** the resume note's sentence on a cut-off call: a read is safe to repeat, any other call may have taken effect */
export function cutOffNote(call: { name: string; input: Record<string, unknown> } | undefined) {
  if (!call) return ''
  if (READ_TOOLS.includes(call.name))
    return ` Your last tool call (${call.name}) was cut off before it finished. It only read, so it is safe to repeat.`
  const what =
    typeof call.input.command === 'string'
      ? `the ${call.name} command \`${call.input.command.slice(0, 300)}\``
      : typeof call.input.file_path === 'string'
        ? `${call.name} on ${call.input.file_path}`
        : call.name
  return ` Your last tool call was cut off before it finished: ${what}. It may have taken effect: check its result (git status, the files it touches) before you repeat it.`
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
 * the next turn. `extra` is flags put after the agent's own (Claude's --settings, codex's guard flags, pi's rules and skills).
 * `env` is a VAR=value prefix (FACTORY_DEADLINE; CODEX_HOME; the commit identity).
 */
export function command(
  agent: string,
  prompt: string,
  o: { session?: string; mcp?: Mcp; extra?: string; env?: Record<string, string> } = {},
) {
  const text = `"$(cat ${sq(prompt)})"`
  const { session, mcp } = o
  const env = Object.entries(o.env ?? {})
    .map(([k, v]) => `${k}=${sq(v)} `)
    .join('')
  switch (harnessOf(agent)) {
    case 'claude': {
      const base = session ? `${agent.replace(/\s--new\b/, '')} --resume ${sq(session)}` : agent
      return `${env}${base}${mcp ? ` --mcp-config ${sq(mcp.file)}` : ''}${o.extra ?? ''} ${text}`
    }
    case 'codex': {
      const flags = `${o.extra ?? ''}${mcp ? codexMcp(mcp.servers) : ''}`
      if (!session) return `${env}${agent}${flags} ${text}`
      // codex resume [OPTIONS] [SESSION_ID] [PROMPT]: the subcommand goes right after the executable
      const [exe, ...rest] = agent.trim().split(/\s+/)
      return `${env}${exe} resume${rest.length ? ` ${rest.join(' ')}` : ''}${flags} ${sq(session)} ${text}`
    }
    case 'pi': {
      // pi has no MCP client of its own, and a worker never runs without its rig's servers (constitution I).
      // A pi MCP extension (e.g. pi-mcp-adapter) passed in the rig's --agent would cover it.
      if (mcp)
        throw new Error(`pi has no MCP client, so a pi worker cannot load ${mcp.file}: use claude or codex`)
      return `${env}${agent}${o.extra ?? ''}${session ? ` --session ${sq(session)}` : ''} ${text}`
    }
    default:
      return `${agent} ${text}`
  }
}

/**
 * the one line ever typed into a worker's pane: it holds no run ID, path or prompt text, so nothing
 * in those can trip a shell key binding (zsh-vi-mode's 'jk' insert-mode escape cut a typed launch
 * line mid-command, claude-factory-r21). The pane's own shell expands both variables: HERDR_PANE_ID
 * is exported in every herdr pane, FACTORY_HOME by launchPane's `tab create --env`.
 */
export const LAUNCH_LINE = '. "$FACTORY_HOME/launch/$HERDR_PANE_ID.sh"'

/**
 * writes the real launch command to the file LAUNCH_LINE sources, mode 0600 (it can hold MCP env
 * or headers from codexMcp). Returns LAUNCH_LINE so a caller types that instead of `cmd`.
 */
export function writeLaunch(home: string, pane: string, cmd: string): string {
  const dir = join(home, 'launch')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${pane}.sh`)
  writeFileSync(file, `${cmd}\n`, { mode: 0o600 })
  chmodSync(file, 0o600) // writeFileSync's mode is masked by umask; an existing file keeps its old mode otherwise
  return LAUNCH_LINE
}
