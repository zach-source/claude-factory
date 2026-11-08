import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { axCursorRefused, cursorEgress, cursorWorker, limitPagedFile, vmCursorHooks } from './cli'
import { command, harnessOf, skillsFor } from './harness'
import { cursorUsageOf } from './metrics'
import { tokenPathReason, tokenReason } from './token-guard'
import { cursorInput, cursorReply, fileWriteReason } from './worker-hook'
import { cursorLimit, sessionIn, turnArgv } from './worker'

const ROOT = join(import.meta.dir, '..')
const jl = (...e: object[]) => e.map(x => JSON.stringify(x)).join('\n')
const tmp = () => mkdtempSync(join(tmpdir(), 'cursor-'))

test('cursor-agent is the cursor harness, and gets no plugin skills', () => {
  expect(harnessOf('cursor-agent --force --trust')).toBe('cursor')
  expect(harnessOf('/usr/local/bin/cursor-agent')).toBe('cursor')
  expect(harnessOf('cursor')).toBeNull()
  expect(skillsFor('cursor', ['asd-ste100', 'egm'])).toEqual([])
})

test('a cursor launch starts on the rules and the prompt, resumes a session with the prompt, and refuses MCP', () => {
  expect(command('cursor-agent --force', '/p.md', { extra: ' --disable-auto-update' })).toBe(
    `cursor-agent --force --disable-auto-update "$(cat '/p.md')"`,
  )
  expect(command('cursor-agent', '/p.md', { rules: '/r.md', env: { A: 'b' } })).toBe(
    `A='b' cursor-agent "$(cat '/r.md' '/p.md')"`,
  )
  expect(command('cursor-agent', '/p.md', { rules: '/r.md', session: 's-1' })).toBe(
    `cursor-agent --resume 's-1' "$(cat '/p.md')"`,
  )
  const mcp = { file: '/m.json', servers: {} }
  expect(() => command('cursor-agent', '/p.md', { mcp })).toThrow('cursor worker cannot load')
})

test('a VM cursor turn is headless stream-json, reads the prompt from stdin and resumes by session id', () => {
  expect(turnArgv('cursor', { model: 'grok-4.7-low' })).toEqual([
    ...[
      'cursor-agent',
      '-p',
      '--output-format',
      'stream-json',
      '--force',
      '--trust',
      '--disable-auto-update',
    ],
    ...['--model', 'grok-4.7-low'],
  ])
  expect(turnArgv('cursor', { session: 'abc' }).slice(-2)).toEqual(['--resume', 'abc'])
  const out = jl(
    { type: 'system', subtype: 'init', session_id: 'sid-1' },
    { type: 'result', session_id: 'sid-1' },
  )
  expect(sessionIn('cursor', out)).toBe('sid-1')
})

test('cursorLimit reads a usage-limit error in the last result, and nothing else', () => {
  const err = (result: string) => jl({ type: 'result', subtype: 'error', is_error: true, result })
  expect(cursorLimit(err('You have hit your usage limit'), 5)).toEqual({ at: 5, kind: 'usage', resetsAt: 0 })
  expect(cursorLimit(err('resource_exhausted: quota'))?.kind).toBe('usage')
  expect(cursorLimit(err('upstream connect error or disconnect/reset before headers'))).toBeNull()
  expect(cursorLimit(jl({ type: 'result', is_error: false, result: 'usage limit docs' }))).toBeNull()
  expect(
    cursorLimit(err('usage limit') + '\n' + jl({ type: 'result', is_error: false, result: 'ok' })),
  ).toBeNull()
  expect(cursorLimit('usage limit"}\n' + jl({ type: 'assistant' }))).toBeNull()
  expect(cursorLimit('')).toBeNull()
})

test('cursorUsageOf sums the result usage of each turn, one row for each session', () => {
  const usage = (i: number) => ({
    inputTokens: i,
    outputTokens: 2,
    cacheReadTokens: 10,
    cacheWriteTokens: 1,
    reasoningTokens: 1,
  })
  const rows = cursorUsageOf([
    ...jl(
      { type: 'system', subtype: 'init', session_id: 's1', model: 'Grok 4.7' },
      { type: 'result', session_id: 's1', usage: usage(100) },
      { type: 'result', session_id: 's1', usage: usage(300) },
      { type: 'result', session_id: 's2', usage: usage(5) },
      { type: 'result', session_id: 's2', is_error: true },
    ).split('\n'),
    'not json',
  ])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toEqual({
    ...{ node: '?', seq: 0, session: 's1', model: 'Grok 4.7' },
    ...{ input: 400, cacheWrite: 2, cacheRead: 20, output: 4, turns: 2, peak: 311 },
  })
  expect(cursorUsageOf([])).toEqual([])
})

test('the cursor egress injects the vault key only on /auth/, and opens the other cursor hosts', () => {
  const [auth, rest] = cursorEgress([{ hosts: ['example.com'] }]).slice(1)
  expect(auth).toEqual({
    hosts: ['api2.cursor.sh'],
    pathPrefixes: ['/auth/'],
    key: 'CURSOR_API_KEY',
    header: 'Authorization',
    prefix: 'Bearer ',
  })
  expect(rest!.key).toBeUndefined()
  expect(rest!.hosts).toContain('api2.cursor.sh')
  const own = [{ hosts: ['api2.cursor.sh'], key: 'K' }]
  expect(cursorEgress(own)).toBe(own)
})

test('the ax runner runs cursor only with FACTORY_AX_CURSOR=1', () => {
  expect(() => axCursorRefused('cursor-agent', {})).toThrow('FACTORY_AX_CURSOR=1')
  expect(() => axCursorRefused('cursor-agent', { FACTORY_AX_CURSOR: '1' })).not.toThrow()
  expect(() => axCursorRefused('codex', {})).not.toThrow()
  const pool = { name: 'ax' }
  expect(limitPagedFile(pool, false, true)).toMatch(/limit-paged-ax-cursor\.json$/)
  expect(limitPagedFile(pool, true, true)).toMatch(/limit-paged-ax-codex\.json$/)
})

test('a VM cursor worker gets the deny hook as a fail-closed preToolUse command', () => {
  const file = JSON.parse(vmCursorHooks(['acme'], ['release'], 'acme/widget'))
  expect(file.version).toBe(1)
  const [hook] = file.hooks.preToolUse
  expect(hook).toMatchObject({ timeout: 10, failClosed: true })
  expect(hook.command).toContain(
    "'/usr/local/bin/bun' --no-env-file --config=/dev/null '/opt/factory/src/worker-hook.ts'",
  )
  expect(hook.command).toContain(
    "--harness cursor --person-only-contexts 'acme' --protected-branches 'release'",
  )
  expect(hook.command).toContain("--merge-authority 'acme/widget'")
})

function pane() {
  const t = tmp()
  const wt = join(t, 'wt')
  Bun.spawnSync(['git', 'init', '-q', wt])
  return { t, wt, home: join(t, 'home') }
}

test('a cursor pane worker has the hook in its worktree, hidden from git, and the rules in its home', () => {
  const { wt, home } = pane()
  mkdirSync(home)
  const w = cursorWorker({ worktree: wt }, { personOnlyContexts: ['acme'] }, home)
  const hooks = JSON.parse(readFileSync(join(wt, '.cursor', 'hooks.json'), 'utf8'))
  expect(hooks.hooks.preToolUse[0].command).toContain(join(ROOT, 'src', 'worker-hook.ts'))
  expect(Bun.spawnSync(['git', '-C', wt, 'status', '--porcelain']).stdout.toString()).toBe('')
  expect(w.extra).toBe(' --disable-auto-update')
  expect(w.env.CLAUDE_PROJECT_DIR).toBe(wt)
  const rules = readFileSync(w.rules, 'utf8')
  expect(rules).toContain('You run in Cursor')
  expect(rules).toContain('unattended software factory')
  cursorWorker({ worktree: wt }, undefined, home) // a second launch rewrites the same file
  expect(readFileSync(join(wt, '.git', 'info', 'exclude'), 'utf8').match(/hooks\.json/g)).toHaveLength(1)
})

test('a cursor pane launch is refused when the repo has its own .cursor/hooks.json', () => {
  const { wt, home } = pane()
  mkdirSync(home)
  mkdirSync(join(wt, '.cursor'))
  writeFileSync(join(wt, '.cursor', 'hooks.json'), '{"hooks":{}}')
  expect(() => cursorWorker({ worktree: wt }, undefined, home)).toThrow('would add hooks')
  expect(existsSync(join(home, 'worker-cursor.md'))).toBe(false)
})

test("Cursor's tool calls map to the guards, and the reply is Cursor's shape", () => {
  expect(cursorInput({ tool_name: 'Shell', tool_input: { command: 'ls' } })).toMatchObject({
    tool_name: 'Bash',
  })
  expect(cursorInput({ tool_name: 'Delete', tool_input: { file_path: '/a' } })).toMatchObject({
    tool_name: 'Write',
  })
  expect(cursorInput({ tool_name: 'Read' })).toEqual({ tool_name: 'Read' })
  expect(cursorReply([])).toEqual({ permission: 'allow' })
  const deny = JSON.stringify({
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' },
  })
  expect(cursorReply([deny])).toEqual({ permission: 'deny', user_message: 'no', agent_message: 'no' })
})

test('worker-hook --harness cursor denies rm -rf from a Shell call and allows ls', () => {
  const run = (tool_input: object, tool_name = 'Shell') =>
    JSON.parse(
      Bun.spawnSync(['bun', join(ROOT, 'src', 'worker-hook.ts'), '--harness', 'cursor'], {
        stdin: Buffer.from(JSON.stringify({ tool_name, tool_input, cwd: '' })),
        env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
      }).stdout.toString(),
    )
  expect(run({ command: 'rm -rf src' }).permission).toBe('deny')
  expect(run({ command: 'ls' })).toEqual({ permission: 'allow' })
  expect(run({ file_path: join(ROOT, '.cursor', 'hooks.json'), content: '{}' }, 'Write').permission).toBe(
    'deny',
  )
  expect(run({ file_path: join(ROOT, 'a.txt') }, 'Delete').permission).toBe('allow')
})

test('the token guard covers the cursor login: ~/.cursor, ~/.config/cursor and the keychain', () => {
  const env = { home: '/h', cursorConfigDir: '/c' }
  for (const p of ['/h/.cursor/cli-config.json', '/h/.config/cursor/cli-config.json', '/c/auth.json'])
    expect(tokenPathReason('Read', { file_path: p }, ROOT, ROOT, env)).toBeDefined()
  expect(tokenPathReason('Grep', { path: '/h/.config/cursor' }, ROOT, ROOT, env)).toBeDefined()
  expect(tokenPathReason('Grep', { path: '/c' }, ROOT, ROOT, env)).toBeDefined()
  expect(tokenPathReason('Read', { file_path: join(ROOT, 'src', 'cli.ts') }, ROOT, ROOT, env)).toBeUndefined()
  for (const c of [
    'cat ~/.cursor/cli-config.json',
    'cat ~/.config/cursor/cli-config.json',
    'ls $CURSOR_CONFIG_DIR',
  ])
    expect(tokenReason(c, ROOT, ROOT)).toBeDefined()
  expect(tokenReason('cat .cursor/hooks.json', ROOT, ROOT)).toBeUndefined()
})

test('the file-write guard protects the cursor hooks file and the .cursor dir', () => {
  for (const p of ['.cursor/hooks.json', '.cursor'])
    expect(fileWriteReason(join(ROOT, p), ROOT, { home: '/h' }, ROOT)).toContain('.cursor/hooks.json')
  expect(fileWriteReason(join(ROOT, '.cursor', 'rules', 'a.mdc'), ROOT, { home: '/h' }, ROOT)).toBeUndefined()
})
