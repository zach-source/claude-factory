import { expect, test } from 'bun:test'
import {
  cpSync,
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
import { axCodexRefused, codexAuth, codexEgress, codexWorker, limitPagedFile, vmCodexHome } from './cli'
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
  // a fake codex: prints the features table kept in features.txt
  const codexBin = join(tmp, 'codex')
  const features = join(tmp, 'features.txt')
  writeFileSync(
    features,
    'hooks stable true\n' +
      ['unified_exec', 'shell_snapshot', 'multi_agent', 'code_mode'].map(x => `${x} stable false\n`).join(''),
  )
  const fake = (body: string) => writeFileSync(codexBin, `#!/bin/sh\n${body}`, { mode: 0o755 })
  fake(
    `printf '%s\\n' "$@" > '${join(tmp, 'argv')}'\ncase "$*" in *x.guard=off*) printf 'hooks stable false\\n';; *) cat '${features}';; esac\n`,
  )
  const run = { id: 'r1', worktree: join(tmp, 'wt') }
  const make = (agent = 'codex --dangerously-bypass-approvals-and-sandbox', o = {}) =>
    codexWorker(
      run,
      { maxContextK },
      'implement',
      agent.replace(/^codex/, codexBin),
      { personOnlyContexts: ['acme'] },
      {
        hookFile: join(ROOT, 'src', 'worker-hook.ts'),
        userHome: user,
        dir,
        plugins: [],
        ...o,
      },
    )
  return { tmp, user, dir, mine, make, run, features, codexBin, fake }
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
  expect(pre).toHaveLength(3)
  expect(pre[0]).toEqual(f.mine)
  expect(pre[1].hooks[0].command).toContain("worker-hook.ts' --person-only-contexts 'acme'")
  expect(pre[2].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit')
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

// claude-factory-qo6i: a codex worker gets the skills a Claude worker gets from its plugins (constitution I);
// a resume copies them again over a read-only copy (a Nix store source)
test('a codex worker home holds the worker plugins skills, and a resume copies them again', () => {
  const f = fixture()
  const plugin = join(f.tmp, 'plugin')
  mkdirSync(join(plugin, 'skills', 'ste', 'scripts'), { recursive: true })
  writeFileSync(join(plugin, 'skills', 'ste', 'SKILL.md'), '---\nname: ste\n---\n', { mode: 0o444 })
  writeFileSync(join(plugin, 'skills', 'ste', 'scripts', 'look.py'), 'x', { mode: 0o444 })
  f.make(undefined, { plugins: [plugin] })
  f.make(undefined, { plugins: [plugin] })
  expect(readdirSync(join(f.dir, 'skills'))).toEqual(['ste'])
  expect(readFileSync(join(f.dir, 'skills', 'ste', 'SKILL.md'), 'utf8')).toContain('name: ste')
  expect(readdirSync(join(f.dir, 'skills', 'ste', 'scripts'))).toEqual(['look.py'])
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
    '--disable codex_hooks',
    '-c features.codex_hooks=false',
    '--config features.hooks=false',
    '-c features.unified_exec=true',
    '--config features.unified_exec=true',
    '--enable unified_exec',
    '--enable shell_snapshot',
    '--enable multi_agent',
    '--enable code_mode',
    '-c "features.hooks=false"',
    "'--ignore-user-config'",
    "--disable 'hooks'",
    '-cfeatures.hooks=false',
    "-c 'features={hooks=false}'",
    "-c 'features={ unified_exec = true }'",
    "-c 'features.hooks = false'",
  ])
    expect(() => f.make(`codex ${bad}`)).toThrow('keeps the deny hook on')
  for (const ok of ['-m o3', '--disable multi_agent', '-c model_reasoning_effort=high', '--enable hooks'])
    expect(() => f.make(`codex ${ok}`)).not.toThrow()
})

test('a codex launch refuses when the worktree holds a .codex entry', () => {
  const f = fixture()
  mkdirSync(join(f.run.worktree, '.codex'), { recursive: true })
  expect(() => f.make()).toThrow('.codex')
  rmSync(join(f.run.worktree, '.codex'), { recursive: true })
  mkdirSync(join(f.run.worktree, '.git'), { recursive: true })
  expect(() => f.make()).not.toThrow()
  // claude-factory-8cu6: the .codex that bd init writes is allowed
  cpSync(join(ROOT, 'src', 'fixtures', 'bd-codex'), join(f.run.worktree, '.codex'), { recursive: true })
  expect(() => f.make()).not.toThrow()
})

test('a codex launch refuses when codex reports a guard that is not in force', () => {
  const f = fixture()
  const set = (hooks: boolean, on = '') =>
    writeFileSync(
      f.features,
      `hooks stable ${hooks}\n` +
        ['unified_exec', 'shell_snapshot', 'multi_agent', 'code_mode']
          .map(x => `${x} stable ${x === on}\n`)
          .join(''),
    )
  set(false)
  expect(() => f.make()).toThrow('feature check')
  for (const on of ['shell_snapshot', 'multi_agent', 'code_mode']) {
    set(true, on)
    expect(() => f.make()).toThrow('feature check')
  }
  set(true, 'unified_exec')
  expect(() => f.make()).toThrow('/etc/codex/requirements.toml with [features] unified_exec = false')
  expect(() => f.make()).toThrow('claude-factory-fzm3')
  // no unified_exec line counts as not off
  writeFileSync(
    f.features,
    'hooks stable true\nshell_snapshot stable false\nmulti_agent stable false\ncode_mode stable false\n',
  )
  expect(() => f.make()).toThrow('unified_exec is not off')
  set(true) // hooks on, all four off
  f.make()
  writeFileSync(f.features, 'shell_snapshot stable false\n') // hooks line missing
  expect(() => f.make()).toThrow('feature check')
  f.fake('exit 3\n')
  expect(() => f.make()).toThrow('feature check')
})

test('a VM codex home runs the image deny hook, sets the limit and trusts the VM repo (claude-factory-72dq)', () => {
  const h = vmCodexHome({ maxContextK: 150 }, ['acme'], ['release'])
  expect(Object.keys(h).sort()).toEqual(['config.toml', 'hooks.json'])
  const hook = JSON.parse(h['hooks.json']).hooks.PreToolUse
  expect(hook).toHaveLength(2)
  expect(hook[0].matcher).toBe('Bash')
  expect(hook[1].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit')
  expect(hook[1].hooks).toEqual(hook[0].hooks)
  const cmd: string = hook[0].hooks[0].command
  expect(cmd).toContain("'/usr/local/bin/bun' '/opt/factory/src/worker-hook.ts'")
  expect(cmd).toContain("--person-only-contexts 'acme'")
  expect(cmd).toContain("--protected-branches 'release'")
  expect(h['config.toml']).toBe(
    'model_auto_compact_token_limit = 300000\nallow_login_shell = false\n\n[projects."/workspace/w/repo"]\ntrust_level = "trusted"\n',
  )
})

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString())

test('a ChatGPT-mode VM codex home holds a placeholder auth.json that codex accepts', () => {
  const h = vmCodexHome({ maxContextK: 150 }, [], [], undefined, 'chatgpt')
  expect(Object.keys(h).sort()).toEqual(['auth.json', 'config.toml', 'hooks.json'])
  const auth = JSON.parse(h['auth.json']!)
  expect(auth.auth_mode).toBe('chatgpt')
  expect(auth.OPENAI_API_KEY).toBeNull()
  expect(auth.tokens.refresh_token).toBe('placeholder')
  // codex 0.160.1 runs wham/accounts/check workspace routing only when tokens.account_id is set; the gateway adds the header
  expect('account_id' in auth.tokens).toBe(false)
  expect(Number.isNaN(Date.parse(auth.last_refresh))).toBe(false)
  const id = claims(auth.tokens.id_token)
  expect(id.email).toBe('codex@factory.invalid')
  expect(id['https://api.openai.com/auth']).toEqual({
    chatgpt_plan_type: 'pro',
    chatgpt_user_id: 'placeholder',
    chatgpt_account_id: 'placeholder',
  })
  expect(claims(auth.tokens.access_token).exp).toBe(4102444800)
  for (const t of [auth.tokens.id_token, auth.tokens.access_token]) expect(t.split('.')).toHaveLength(3)
  expect(h['config.toml']).toContain('forced_login_method = "chatgpt"')
  expect(h['config.toml']).toContain('cli_auth_credentials_store = "file"')
  // api-key mode: unchanged
  const k = vmCodexHome({ maxContextK: 150 })
  expect(k['auth.json']).toBeUndefined()
  expect(k['config.toml']).not.toContain('forced_login_method')
})

test('codex login status accepts the placeholder auth.json', () => {
  const codex = Bun.which('codex')
  if (!codex) return
  const home = mkdtempSync(join(tmpdir(), 'codex-login-'))
  try {
    for (const [n, t] of Object.entries(vmCodexHome({ maxContextK: 150 }, [], [], undefined, 'chatgpt')))
      writeFileSync(join(home, n), t)
    const p = Bun.spawnSync([codex, 'login', 'status'], { env: { ...process.env, CODEX_HOME: home } })
    expect(`${p.stdout}${p.stderr}`).toContain('Logged in using ChatGPT')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the ax runner takes codex only with FACTORY_AX_CODEX=1, and claude and pi always', () => {
  const keep = process.env.FACTORY_AX_CODEX
  try {
    delete process.env.FACTORY_AX_CODEX
    expect(() => axCodexRefused('codex -m o3')).toThrow('FACTORY_AX_CODEX=1')
    expect(() => axCodexRefused('claude')).not.toThrow()
    expect(() => axCodexRefused('pi')).not.toThrow()
    process.env.FACTORY_AX_CODEX = '1'
    expect(() => axCodexRefused('codex -m o3')).not.toThrow()
  } finally {
    if (keep === undefined) delete process.env.FACTORY_AX_CODEX
    else process.env.FACTORY_AX_CODEX = keep
  }
})

const CHATGPT_RULE = {
  hosts: ['chatgpt.com'],
  pathPrefixes: ['/backend-api/codex/'],
  headers: [
    { header: 'Authorization', prefix: 'Bearer ', key: 'CODEX_CHATGPT' },
    { header: 'ChatGPT-Account-ID', prefix: '', key: 'CODEX_CHATGPT_ACCOUNT' },
  ],
}

test('a VM codex worker uses ChatGPT mode, unless the rig names api.openai.com or chatgpt.com', () => {
  expect(codexEgress()).toEqual([CHATGPT_RULE])
  const pypi = { hosts: ['pypi.org'] }
  expect(codexEgress([pypi])).toEqual([pypi, CHATGPT_RULE])
  expect(codexAuth([pypi])).toBe('chatgpt')
  const own = [{ hosts: ['api.openai.com'], key: 'OPENAI_ZS' }]
  expect(codexEgress(own)).toBe(own)
  expect(codexAuth(own)).toBe('apikey')
  const mine = [{ hosts: ['chatgpt.com'], key: 'MINE' }]
  expect(codexEgress(mine)).toBe(mine)
  expect(codexAuth(mine)).toBe('chatgpt')
})

test('the ChatGPT rule leaves out the wham task and remote paths', () => {
  const rule = codexEgress().find(e => e.hosts.includes('chatgpt.com'))!
  for (const path of [
    '/backend-api/wham/accounts/check',
    '/backend-api/wham/accounts/',
    '/backend-api/wham/tasks',
    '/backend-api/wham/remote',
    '/backend-api/wham/usage',
    '/backend-api/me',
  ])
    expect(rule.pathPrefixes!.some(p => path.startsWith(p))).toBe(false)
  expect(rule.pathPrefixes!.some(p => '/backend-api/codex/responses'.startsWith(p))).toBe(true)
})

test('a codex limit and a Claude limit page through separate files', () => {
  const vm = { name: 'ax' }
  expect(limitPagedFile(vm, true)).not.toBe(limitPagedFile(vm, false))
  expect(limitPagedFile({ ...vm, local: true }, true)).toMatch(/limit-paged\.json$/)
})

test('the ChatGPT rule is path-limited and names no API-key host or key', () => {
  const rule = codexEgress().find(e => e.hosts.includes('chatgpt.com'))!
  expect(rule.pathPrefixes!.length).toBeGreaterThan(0)
  const all = JSON.stringify(codexEgress())
  for (const bad of ['auth.openai.com', 'api.openai.com', 'OPENAI"']) expect(all).not.toContain(bad)
})

test('the probe runs the agent own executable, not codex from PATH', () => {
  const f = fixture()
  const other = join(f.tmp, 'bin')
  mkdirSync(other)
  writeFileSync(join(other, 'codex'), `#!/bin/sh\ncat '${f.features}'\n`, { mode: 0o755 })
  f.fake(`printf 'hooks stable false\\n'\n`)
  const path = process.env.PATH
  process.env.PATH = `${other}:${path}`
  try {
    expect(() => f.make()).toThrow('feature check')
  } finally {
    process.env.PATH = path
  }
})

test('the probe passes the agent words, quotes kept, then the factory flags', () => {
  const f = fixture()
  const { extra } = f.make("codex -m o3 -c 'a b'")
  expect(readFileSync(join(f.tmp, 'argv'), 'utf8').trim().split('\n')).toEqual([
    '-m',
    'o3',
    '-c',
    'a b',
    ...extra.trim().split(' '),
    'features',
    'list',
  ])
})

test('an agent -c the guard check does not match is refused when codex reports hooks off', () => {
  const f = fixture()
  expect(() => f.make('codex -c x.guard=off')).toThrow('feature check')
  expect(() => f.make('codex -c x.guard=on')).not.toThrow()
})

test('a hung probe fails closed within the timeout', () => {
  const f = fixture()
  f.fake('exec sleep 30\n')
  const t = Date.now()
  expect(() => f.make(undefined, { timeoutMs: 500 })).toThrow('timed out')
  expect(Date.now() - t).toBeLessThan(5000)
})
