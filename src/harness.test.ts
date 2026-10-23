import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeCommand,
  command,
  cutOffCall,
  cutOffNote,
  harnessOf,
  LAUNCH_LINE,
  readMcp,
  writeLaunch,
} from './harness'

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
  expect(command('codex --full-auto', '/p.md', { mcp })).toBe(
    `codex --full-auto -c 'mcp_servers.fx={"command"="fx-mcp","args"=["--x"]}' "$(cat '/p.md')"`,
  )
  expect(command('codex --full-auto', '/p.md', { session: 'u-1' })).toBe(
    `codex resume --full-auto 'u-1' "$(cat '/p.md')"`,
  )
})

test('codex takes its extra flags and an env prefix, fresh and on resume', () => {
  const o = { extra: ' --enable hooks', env: { CODEX_HOME: "/h/it's" } }
  expect(command('codex -m o3', '/p.md', o)).toBe(
    `CODEX_HOME='/h/it'\\''s' codex -m o3 --enable hooks "$(cat '/p.md')"`,
  )
  expect(command('codex -m o3', '/p.md', { ...o, session: 'u-1', mcp })).toBe(
    `CODEX_HOME='/h/it'\\''s' codex resume -m o3 --enable hooks -c 'mcp_servers.fx={"command"="fx-mcp","args"=["--x"]}' 'u-1' "$(cat '/p.md')"`,
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

test('LAUNCH_LINE is the only text ever typed into a pane: fixed, one line, no run-specific text', () => {
  expect(LAUNCH_LINE).not.toInclude('jk')
  expect(LAUNCH_LINE).not.toInclude('\n')
  expect(LAUNCH_LINE).toBe('. "$FACTORY_HOME/launch/$HERDR_PANE_ID.sh"')
})

test('writeLaunch writes the pane a 0600 script holding the command, and a second write overwrites it', () => {
  const dir = join(tmpdir(), `launch-${process.pid}-${Date.now()}`)
  const pane = 'wX:p1'
  expect(writeLaunch(dir, pane, 'echo hi')).toBe(LAUNCH_LINE)
  const file = join(dir, 'launch', `${pane}.sh`)
  expect(readFileSync(file, 'utf8')).toBe('echo hi\n')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(writeLaunch(dir, pane, 'echo bye')).toBe(LAUNCH_LINE)
  expect(readFileSync(file, 'utf8')).toBe('echo bye\n')
  // a script written before this launch may carry a looser mode (an old factory version, a person's umask):
  // writeLaunch must reset it, not just rely on the create-time mode which a pre-existing file skips
  chmodSync(file, 0o644)
  writeLaunch(dir, pane, 'echo third')
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('sourcing LAUNCH_LINE in the pane shell runs the written command byte-for-byte, even for a hostile prompt', () => {
  const zsh = Bun.which('zsh')
  const sh = Bun.which('sh') ?? '/bin/sh'
  const dir = join(tmpdir(), `pane-${process.pid}-${Date.now()}`)
  const promptDir = join(dir, 'runs', 'lifecycle-mv8khojkz6', 'prompts', 'x-jk-y')
  mkdirSync(promptDir, { recursive: true })
  const promptPath = join(promptDir, 'triage.md')
  const promptText = 'hostile jk \' " $(touch pwned) `touch pwned2`\nline two'
  writeFileSync(promptPath, promptText)
  const fakeDir = join(tmpdir(), `fake-${process.pid}-${Date.now()}`)
  mkdirSync(fakeDir, { recursive: true })
  const fake = join(fakeDir, 'argv.ts')
  writeFileSync(fake, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const cmd = command(`bun ${fake}`, promptPath)
  const pane = 'wX:p1'
  writeLaunch(dir, pane, cmd)
  for (const shell of zsh ? [zsh, sh] : [sh]) {
    const p = Bun.spawnSync([shell, '-c', LAUNCH_LINE], {
      env: { ...process.env, FACTORY_HOME: dir, HERDR_PANE_ID: pane },
    })
    expect(p.exitCode, p.stderr.toString()).toBe(0)
    expect(JSON.parse(p.stdout.toString())).toEqual([promptText])
  }
})

// claude-factory-p0yt: the resume note names the call a crash cut off
const line = (type: string, content: object[]) => JSON.stringify({ type, message: { content } })
const use = (id: string, name: string, input: object) =>
  line('assistant', [{ type: 'tool_use', id, name, input }])
const result = (id: string) => line('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }])

test('cutOffCall finds the last call with no result, past a cut first line', () => {
  const tail = [
    '{"type":"assis', // the tail starts mid-line
    use('a', 'Read', { file_path: '/r/x.ts' }),
    result('a'),
    use('b', 'Bash', { command: 'git push origin HEAD' }),
  ].join('\n')
  expect(cutOffCall(tail)).toEqual({ name: 'Bash', input: { command: 'git push origin HEAD' } })
  expect(cutOffCall([use('a', 'Read', {}), result('a')].join('\n'))).toBeUndefined()
  expect(cutOffCall('')).toBeUndefined()
})

test('cutOffNote says a read is safe to repeat and any other call may have taken effect', () => {
  expect(cutOffNote(undefined)).toBe('')
  expect(cutOffNote({ name: 'Grep', input: { pattern: 'x' } })).toContain('safe to repeat')
  const bash = cutOffNote({ name: 'Bash', input: { command: 'git push origin HEAD' } })
  expect(bash).toContain('`git push origin HEAD`')
  expect(bash).toContain('may have taken effect')
  expect(cutOffNote({ name: 'Edit', input: { file_path: '/r/x.ts' } })).toContain('Edit on /r/x.ts')
  expect(cutOffNote({ name: 'Bash', input: { command: 'x'.repeat(1000) } }).length).toBeLessThan(500)
})

test('a claude launch line carries the env prefix, like codex', () => {
  expect(command('claude', '/p.md', { env: { FACTORY_DEADLINE: '123' } })).toStartWith(
    "FACTORY_DEADLINE='123' claude ",
  )
})
