import { expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { axCodexRefused, codexWorker } from './cli'
import { command } from './harness'

// claude-factory-x0b9: a codex worker gets the guard, the rules and a context limit in its own CODEX_HOME
const ROOT = join(import.meta.dir, '..')

function fixture(maxContextK = 200) {
  const tmp = mkdtempSync(join(tmpdir(), 'codex-worker-'))
  const user = join(tmp, 'person')
  mkdirSync(join(user, 'skills', 'x'), { recursive: true })
  writeFileSync(join(user, 'config.toml'), '[mcp_servers.leak]\ncommand = "leak"\n')
  writeFileSync(join(user, 'AGENTS.md'), 'person rules')
  writeFileSync(join(user, 'auth.json'), '{"e2e":"fake"}')
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'person-hook' }] }
  writeFileSync(join(user, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [mine] } }))
  const dir = join(tmp, 'run', 'codex', 'implement')
  const run = { id: 'r1', worktree: join(tmp, 'wt') }
  const make = (agent = 'codex --dangerously-bypass-approvals-and-sandbox', o = {}) =>
    codexWorker(
      run,
      { maxContextK },
      'implement',
      agent,
      { personOnlyContexts: ['acme'] },
      {
        hookFile: join(ROOT, 'src', 'worker-hook.ts'),
        userHome: user,
        dir,
        ...o,
      },
    )
  return { tmp, user, dir, mine, make, run }
}

test('a codex worker home holds four files, the guard last, and the launch line names it', () => {
  const f = fixture()
  const { env, extra } = f.make()
  expect(readdirSync(f.dir).sort()).toEqual(['AGENTS.md', 'auth.json', 'config.toml', 'hooks.json'])
  expect(lstatSync(f.dir).mode & 0o777).toBe(0o700)
  expect(lstatSync(join(f.dir, 'auth.json')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(f.dir, 'auth.json'))).toBe(join(f.user, 'auth.json'))
  const toml = readFileSync(join(f.dir, 'config.toml'), 'utf8')
  expect(toml).toContain('model_auto_compact_token_limit = 400000')
  expect(toml).toContain(`[projects.${JSON.stringify(f.run.worktree)}]\ntrust_level = "trusted"`)
  expect(toml).not.toContain('leak')
  const pre = JSON.parse(readFileSync(join(f.dir, 'hooks.json'), 'utf8')).hooks.PreToolUse
  expect(pre).toHaveLength(2)
  expect(pre[0]).toEqual(f.mine)
  expect(pre[1].hooks[0].command).toContain("worker-hook.ts' --person-only-contexts 'acme'")
  const agents = readFileSync(join(f.dir, 'AGENTS.md'), 'utf8')
  expect(agents).toStartWith(readFileSync(join(ROOT, 'src', 'worker-system.md'), 'utf8'))
  expect(agents).toContain(readFileSync(join(ROOT, 'src', 'worker-codex.md'), 'utf8'))
  expect(agents).not.toContain('person rules')
  expect(env.CODEX_HOME).toBe(f.dir)
  expect(env.CLAUDE_PROJECT_DIR).toBe(f.run.worktree)
  const line = command('codex -m o3', '/p.md', { env, extra })
  expect(line).toStartWith(`CODEX_HOME='${f.dir}' `)
  expect(line).not.toContain('/.codex')
  const after = line.slice(line.indexOf('codex -m o3') + 11)
  for (const flag of [
    '--enable hooks',
    '--dangerously-bypass-hook-trust',
    ...['unified_exec', 'shell_snapshot', 'multi_agent', 'apps', 'memories', 'code_mode'].map(
      x => `--disable ${x}`,
    ),
  ])
    expect(after).toContain(flag)
  expect(f.make().extra).toBe(extra) // a resume writes the same home again
})

test('with no person auth file there is no auth.json, and the context limit has a floor', () => {
  const f = fixture(30)
  rmSync(join(f.user, 'auth.json'))
  f.make()
  expect(readdirSync(f.dir).sort()).toEqual(['AGENTS.md', 'config.toml', 'hooks.json'])
  expect(readFileSync(join(f.dir, 'config.toml'), 'utf8')).toContain('= 100000\n')
  expect(fixture(150).make().env).toBeTruthy()
})

test('worker-codex.md stays under 2000 characters', () => {
  expect(readFileSync(join(ROOT, 'src', 'worker-codex.md'), 'utf8').length).toBeLessThan(2000)
})

test('the hooks.json command denies rm -rf, a person-only kubectl change and a push to main', () => {
  const f = fixture()
  f.make()
  const pre = JSON.parse(readFileSync(join(f.dir, 'hooks.json'), 'utf8')).hooks.PreToolUse
  const cmd: string = pre.at(-1).hooks[0].command
  const run = (text: string) =>
    Bun.spawnSync(['sh', '-c', cmd], {
      cwd: f.tmp,
      env: {
        ...process.env,
        FACTORY_OUTBOX: '',
        FACTORY_FROM: '',
        FACTORY_SELF_UPDATE: '0',
        CLAUDE_PROJECT_DIR: f.run.worktree,
      },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: 's',
          turn_id: 't',
          hook_event_name: 'PreToolUse',
          model: 'gpt',
          permission_mode: 'bypassPermissions',
          tool_use_id: 'u',
          cwd: f.run.worktree,
          tool_name: 'Bash',
          tool_input: { command: text },
        }),
      ),
    }).stdout.toString()
  for (const bad of ['rm -rf /x', 'kubectl --context acme apply -f x.yaml', 'git push origin HEAD:main'])
    expect(JSON.parse(run(bad)).hookSpecificOutput.permissionDecision).toBe('deny')
  expect(run('ls')).toBe('')
})

test('a codex launch refuses without the hook file and when the agent command turns the guard off', () => {
  const f = fixture()
  expect(() => f.make(undefined, { hookFile: join(f.tmp, 'missing.ts') })).toThrow('deny hook')
  for (const bad of [
    '--ignore-user-config',
    '--disable hooks',
    '--disable=hooks',
    '-c features.hooks=false',
    '--config features.hooks=false',
    '-c features.unified_exec=true',
    '--config features.unified_exec=true',
    '--enable unified_exec',
    '--enable shell_snapshot',
    '--enable multi_agent',
    '--enable code_mode',
  ])
    expect(() => f.make(`codex ${bad}`)).toThrow('keeps the deny hook on')
  for (const ok of ['-m o3', '--disable multi_agent', '-c model_reasoning_effort=high', '--enable hooks'])
    expect(() => f.make(`codex ${ok}`)).not.toThrow()
})

test('the ax runner refuses codex and still takes claude and pi', () => {
  expect(() => axCodexRefused('codex -m o3')).toThrow('claude-factory-72dq')
  expect(() => axCodexRefused('claude')).not.toThrow()
  expect(() => axCodexRefused('pi')).not.toThrow()
})
