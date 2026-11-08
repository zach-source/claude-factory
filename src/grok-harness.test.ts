import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { axGrokRefused, grokEgress, grokWorker, limitPagedFile, vmGrokHooks } from './cli'
import { command, harnessOf, skillsFor } from './harness'
import { grokUsageOf, validUsage } from './metrics'
import { tokenPathReason, tokenReason } from './token-guard'
import { fileWriteReason, grokInput } from './worker-hook'
import { grokLimit, sessionIn, turnArgv } from './worker'

const ROOT = join(import.meta.dir, '..')
const jl = (...e: object[]) => e.map(x => JSON.stringify(x)).join('\n')
const tmp = () => mkdtempSync(join(tmpdir(), 'grok-'))
const end = (sessionId: string, cost: number, input: number, model = 'grok-4.7') => ({
  type: 'end',
  sessionId,
  total_cost_usd: cost,
  usage: {
    input_tokens: input,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 1,
    output_tokens: 2,
  },
  modelUsage: { [model]: {} },
})

test('grok is the grok harness, and gets no plugin skills', () => {
  expect(harnessOf('grok --permission-mode bypassPermissions --trust')).toBe('grok')
  expect(harnessOf('/usr/local/bin/grok')).toBe('grok')
  expect(harnessOf('grokk')).toBeNull()
  expect(skillsFor('grok', ['asd-ste100', 'egm'])).toEqual([])
})

test('a grok launch appends the rules, resumes a session with the prompt, and refuses MCP', () => {
  expect(command('grok -m x', '/p.md', { extra: ' --no-auto-update' })).toBe(
    `grok -m x --no-auto-update "$(cat '/p.md')"`,
  )
  expect(command('grok', '/p.md', { rules: '/r.md', env: { A: 'b' } })).toBe(
    `A='b' grok --rules "$(cat '/r.md')" "$(cat '/p.md')"`,
  )
  expect(command('grok', '/p.md', { session: 's-1' })).toBe(`grok -r 's-1' "$(cat '/p.md')"`)
  const mcp = { file: '/m.json', servers: {} }
  expect(() => command('grok', '/p.md', { mcp })).toThrow('grok worker cannot load')
})

test('a VM grok turn is headless streaming-json, reads the prompt from stdin and resumes by session id', () => {
  const argv = turnArgv('grok', { model: 'grok-4.7' })
  expect(argv.slice(0, 9)).toEqual([
    ...['grok', '--prompt-file', '/dev/stdin', '--output-format', 'streaming-json'],
    ...['--permission-mode', 'bypassPermissions', '--trust', '--no-auto-update'],
  ])
  expect(argv[argv.indexOf('--rules') + 1]).toContain('You run in Grok')
  expect(argv.slice(-2)).toEqual(['-m', 'grok-4.7'])
  expect(turnArgv('grok', { session: 'abc' }).slice(-2)).toEqual(['-r', 'abc'])
  expect(sessionIn('grok', jl({ type: 'text', data: 'x' }, end('sid-1', 0.1, 5)))).toBe('sid-1')
  expect(sessionIn('grok', jl({ type: 'text', data: 'sessionId' }))).toBeUndefined()
})

test('grokLimit reads a quota or rate error as the last event, and nothing else', () => {
  const err = (message: string) => jl({ type: 'error', message })
  expect(grokLimit(err('HTTP 429: rate limit reached'), 5)).toEqual({ at: 5, kind: 'usage', resetsAt: 0 })
  expect(grokLimit(err('402 Payment Required: your credits are used up'))?.kind).toBe('usage')
  expect(grokLimit(err('Not signed in'))).toBeNull()
  expect(grokLimit(err('rate limit') + '\n' + jl(end('s', 0, 1)))).toBeNull() // a later success
  expect(grokLimit(jl({ type: 'text', data: 'rate limit' }))).toBeNull()
  expect(grokLimit('rate limit"}\n' + jl({ type: 'text' }))).toBeNull()
  expect(grokLimit('')).toBeNull()
})

test('grokUsageOf sums the end event of each turn, one row for each session, with the cost', () => {
  const rows = grokUsageOf([
    ...jl(end('s1', 0.05, 100), end('s1', 0.0255, 300, 'grok-4.7'), end('s2', 1, 5), { type: 'text' }).split(
      '\n',
    ),
    'not json',
  ])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toEqual({
    ...{ node: '?', seq: 0, session: 's1', model: 'grok-4.7' },
    ...{ input: 400, cacheWrite: 2, cacheRead: 20, output: 4, turns: 2, peak: 311, costMicro: 75_500 },
  })
  expect(grokUsageOf([])).toEqual([])
  expect(validUsage(rows, 'plan', 3)[0]).toMatchObject({ node: 'plan', seq: 3, costMicro: 75_500 })
  expect(validUsage([{ ...rows[0], costMicro: -1 }], 'plan', 3)[0]).not.toHaveProperty('costMicro')
})

test('the grok egress injects the vault key as a bearer token on api.x.ai, and keeps a rig rule of its own', () => {
  expect(grokEgress([{ hosts: ['example.com'] }]).slice(1)).toEqual([
    { hosts: ['api.x.ai'], key: 'XAI_API_KEY', header: 'Authorization', prefix: 'Bearer ' },
  ])
  const own = [{ hosts: ['api.x.ai'], key: 'K' }]
  expect(grokEgress(own)).toBe(own)
})

test('the ax runner runs grok only with FACTORY_AX_GROK=1', () => {
  expect(() => axGrokRefused('grok', {})).toThrow('FACTORY_AX_GROK=1')
  expect(() => axGrokRefused('grok', { FACTORY_AX_GROK: '1' })).not.toThrow()
  expect(() => axGrokRefused('codex', {})).not.toThrow()
  expect(limitPagedFile({ name: 'ax' }, false, false, true)).toMatch(/limit-paged-ax-grok\.json$/)
})

test('a VM grok worker gets the deny hook as a Claude-shaped PreToolUse entry', () => {
  const { PreToolUse } = JSON.parse(vmGrokHooks(['acme'], ['release'], 'acme/widget')).hooks
  expect(PreToolUse.map((g: { matcher: string }) => g.matcher)).toEqual([
    'Bash',
    'Write|Edit|MultiEdit|NotebookEdit|apply_patch',
    'Read|Grep',
  ])
  const [hook] = PreToolUse[0].hooks
  expect(hook.timeout).toBe(10)
  expect(hook.onFailure).toBeUndefined() // a Claude field: Grok reports it as a load error
  expect(hook.command).toContain(
    "'/usr/local/bin/bun' --no-env-file --config=/dev/null '/opt/factory/src/worker-hook.ts'",
  )
  expect(hook.command).toContain(
    "--harness grok --person-only-contexts 'acme' --protected-branches 'release'",
  )
  expect(hook.command).toContain("--merge-authority 'acme/widget'")
})

function pane() {
  const t = tmp()
  const wt = join(t, 'wt')
  Bun.spawnSync(['git', 'init', '-q', wt])
  return { wt, home: join(t, 'home') }
}

test('a grok pane worker has the hook in its worktree, hidden from git, and the rules in its home', () => {
  const { wt, home } = pane()
  mkdirSync(home)
  const w = grokWorker({ worktree: wt }, { personOnlyContexts: ['acme'] }, home)
  const hooks = JSON.parse(readFileSync(join(wt, '.grok', 'hooks', 'factory.json'), 'utf8'))
  expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain(join(ROOT, 'src', 'worker-hook.ts'))
  expect(Bun.spawnSync(['git', '-C', wt, 'status', '--porcelain']).stdout.toString()).toBe('')
  expect(w.extra).toBe(' --no-auto-update')
  expect(w.env.CLAUDE_PROJECT_DIR).toBe(wt)
  const rules = readFileSync(w.rules, 'utf8')
  expect(rules).toContain('You run in Grok')
  expect(rules).toContain('unattended software factory')
  grokWorker({ worktree: wt }, undefined, home) // a second launch rewrites the same file
  expect(readFileSync(join(wt, '.git', 'info', 'exclude'), 'utf8').match(/factory\.json/g)).toHaveLength(1)
})

test('a grok pane launch is refused when the repo has its own .grok/hooks files', () => {
  const { wt, home } = pane()
  mkdirSync(home)
  mkdirSync(join(wt, '.grok', 'hooks'), { recursive: true })
  writeFileSync(join(wt, '.grok', 'hooks', 'mine.json'), '{"hooks":{}}')
  expect(() => grokWorker({ worktree: wt }, undefined, home)).toThrow('hooks the factory did not write')
  expect(existsSync(join(home, 'worker-grok.md'))).toBe(false)
})

test("Grok's tool calls map to the guards", () => {
  const call = (tool_name: string, tool_input: object) => grokInput({ tool_name, tool_input, cwd: '/w' })
  expect(call('run_terminal_command', { command: 'ls' })).toMatchObject({ tool_name: 'Bash' })
  expect(call('search_replace', { file_path: '/a' })).toMatchObject({ tool_name: 'Write' })
  expect(call('read_file', { target_file: '/a' })).toMatchObject({
    tool_name: 'Read',
    tool_input: { file_path: '/a' },
  })
  expect(call('grep', { path: '/a' })).toMatchObject({ tool_name: 'Grep' })
  expect(call('list_dir', {})).toMatchObject({ tool_name: 'list_dir' })
})

test('worker-hook --harness grok denies rm -rf, a token read and a hook write, and allows ls', () => {
  const run = (tool_name: string, tool_input: object) =>
    Bun.spawnSync(['bun', join(ROOT, 'src', 'worker-hook.ts'), '--harness', 'grok'], {
      stdin: Buffer.from(JSON.stringify({ tool_name, tool_input, cwd: '' })),
      env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    }).stdout.toString()
  const denied = (out: string) => JSON.parse(out).hookSpecificOutput.permissionDecision
  expect(denied(run('run_terminal_command', { command: 'rm -rf src' }))).toBe('deny')
  expect(run('run_terminal_command', { command: 'ls' })).toBe('')
  expect(denied(run('read_file', { target_file: '/h/.grok/auth.json' }))).toBe('deny')
  expect(denied(run('search_replace', { file_path: join(ROOT, '.grok', 'hooks', 'factory.json') }))).toBe(
    'deny',
  )
  expect(run('search_replace', { file_path: join(ROOT, 'a.txt') })).toBe('')
})

test('the token guard covers the grok login, GROK_HOME and the XAI_API_KEY variable', () => {
  const env = { home: '/h', grokHome: '/g' }
  for (const p of ['/h/.grok/auth.json', '/g/auth.json'])
    expect(tokenPathReason('Read', { file_path: p }, ROOT, ROOT, env)).toBeDefined()
  expect(tokenPathReason('Grep', { path: '/h/.grok' }, ROOT, ROOT, env)).toBeDefined()
  expect(tokenPathReason('Read', { file_path: join(ROOT, 'src', 'cli.ts') }, ROOT, ROOT, env)).toBeUndefined()
  for (const c of ['cat ~/.grok/auth.json', 'ls $GROK_HOME', 'echo $XAI_API_KEY', 'printenv XAI_API_KEY'])
    expect(tokenReason(c, ROOT, ROOT)).toBeDefined()
  expect(tokenReason('cat .grok/hooks/factory.json', ROOT, ROOT)).toBeUndefined()
})

test('the file-write guard protects the .grok dir and its hooks', () => {
  for (const p of ['.grok', '.grok/config.toml', '.grok/hooks/factory.json'])
    expect(fileWriteReason(join(ROOT, p), ROOT, { home: '/h' }, ROOT)).toContain('.grok')
  expect(fileWriteReason(join(ROOT, 'docs', 'grok.md'), ROOT, { home: '/h' }, ROOT)).toBeUndefined()
})
