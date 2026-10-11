import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCommand, command, harnessOf, readMcp } from './harness'

const mcp = { file: '/f/mcp.json', servers: { fx: { command: 'fx-mcp', args: ['--x'] } } }

test('a worker command names its harness by its executable', () => {
  expect(harnessOf('claude-smart --new --model x')).toBe('claude')
  expect(harnessOf('/opt/homebrew/bin/codex --full-auto')).toBe('codex')
  expect(harnessOf('pi --model anthropic/claude-sonnet-5')).toBe('pi')
  expect(harnessOf('bun fake-worker.ts')).toBeNull()
})

test('FACTORY_CLAUDE swaps the Claude Code command, and its executable still runs as claude', () => {
  const was = process.env.FACTORY_CLAUDE
  try {
    delete process.env.FACTORY_CLAUDE
    expect(claudeCommand()).toBe('claude-smart --new --no-channels')
    expect(harnessOf('my-cc --model x')).toBeNull()
    process.env.FACTORY_CLAUDE = '/opt/bin/my-cc --profile w'
    expect(claudeCommand()).toBe('/opt/bin/my-cc --profile w')
    expect(harnessOf('my-cc --model x')).toBe('claude')
  } finally {
    if (was === undefined) delete process.env.FACTORY_CLAUDE
    else process.env.FACTORY_CLAUDE = was
  }
})

test('claude resumes with --resume, takes the MCP file as is and its settings', () => {
  expect(command('claude-smart --new', '/p.md', { mcp, extra: ' --settings {}' })).toBe(
    `claude-smart --new --mcp-config '/f/mcp.json' --settings {} "$(cat '/p.md')"`,
  )
  expect(command('claude-smart --new --model m', '/p.md', { session: 's1' })).toBe(
    `claude-smart --model m --resume 's1' "$(cat '/p.md')"`,
  )
})

test('codex gets each MCP server as a config override, and resumes with its subcommand', () => {
  expect(command('codex --full-auto', '/p.md', { mcp, extra: ' --settings {}' })).toBe(
    `codex --full-auto -c 'mcp_servers.fx={"command"="fx-mcp","args"=["--x"]}' "$(cat '/p.md')"`,
  )
  expect(command('codex --full-auto', '/p.md', { session: 'u-1' })).toBe(
    `codex resume --full-auto 'u-1' "$(cat '/p.md')"`,
  )
})

test('pi resumes by --session and says in the pane that it cannot load MCP', () => {
  expect(command('pi', '/p.md', { session: 'u-1' })).toBe(`pi --session 'u-1' "$(cat '/p.md')"`)
  expect(command('pi', '/p.md', { mcp })).toStartWith(`echo 'factory: pi has no MCP client`)
  expect(command('bun w.ts', "/it's.md")).toBe(`bun w.ts "$(cat '/it'\\''s.md')"`)
})

test('an MCP file must be Claude-shaped, with names codex can address', () => {
  const dir = join(tmpdir(), `mcp-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const at = (name: string, body: unknown) => (
    writeFileSync(join(dir, name), JSON.stringify(body)),
    join(dir, name)
  )
  expect(readMcp(at('ok.json', { mcpServers: { a: { url: 'https://x' } } })).servers.a!.url).toBe('https://x')
  expect(() => readMcp(at('none.json', { servers: {} }))).toThrow('mcpServers')
  expect(() => readMcp(at('bad.json', { mcpServers: { 'a.b': { command: 'x' } } }))).toThrow('letters')
  expect(() => readMcp(at('both.json', { mcpServers: { a: {} } }))).toThrow('command or a url')
})
