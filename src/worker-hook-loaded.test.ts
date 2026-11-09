import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { HOME_REASON, homeReason, LOADED_REASON } from './home-guard'
import { denyReason, loadedTexts } from './worker-hook'

// claude-factory-qn8a.37: the home guard reads the programs that git and config files load.
// Fixtures use only mkdir, writeFile, git init and git config: no git verb that runs a hook.
const bad = () => 'r' + 'm -rf "$' + 'HOME"\n'
const old = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM }
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(() => {
  for (const [k, v] of [
    ['GIT_CONFIG_GLOBAL', old.g],
    ['GIT_CONFIG_NOSYSTEM', old.s],
  ] as const)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
})

const git = (dir: string, ...a: string[]) => {
  const p = Bun.spawnSync(['git', '-C', dir, ...a])
  if (p.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${p.stderr.toString()}`)
}
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'loaded-'))
  git(dir, 'init', '-q')
  return dir
}
const put = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), text)
}
const readIn = (dir: string) => (p: string) => {
  try {
    return readFileSync(resolve(dir, p), 'utf8')
  } catch {
    return undefined
  }
}
const run = (cmd: string, dir: string, cwd = dir) =>
  denyReason(cmd, dir, undefined, { readFile: readIn(dir), loaded: c => loadedTexts(c, cwd) })

describe('loadedTexts and the home guard', () => {
  test('denies a git hook', () => {
    const d = repo()
    put(d, '.git/hooks/pre-commit', bad())
    expect(run('git commit -m x', d)).toBe(HOME_REASON)
  })

  test('denies a core.hooksPath hook, also from a subdir', () => {
    const d = repo()
    git(d, 'config', 'core.hooksPath', 'hk')
    put(d, 'hk/pre-commit', bad())
    mkdirSync(join(d, 'sub'))
    expect(run('git commit -m x', d)).toBe(HOME_REASON)
    expect(run('git commit -m x', d, join(d, 'sub'))).toBe(HOME_REASON)
  })

  test.each([
    'git -c core.hooksPath=hk commit -m x',
    'git -c core.hookspath=hk commit -m x',
    'git -c CORE.HOOKSPATH=hk add x',
  ])('denies a hooks dir that a command word sets: %s', cmd => {
    const d = repo()
    put(d, 'hk/pre-commit', bad())
    expect(run(cmd, d)).toBe(HOME_REASON)
  })

  test.each([
    'git --config-env=core.hooksPath=HP commit -m x',
    'git --config-env core.hooksPath=HP commit -m x',
    'git -c core.hooksPath commit -m x',
  ])('fails closed on a hooks dir with no path: %s', cmd => {
    const d = repo()
    expect(run(cmd, d)).toBe(LOADED_REASON)
  })

  test('allows -c core.hooksPath with a clean hooks dir', () => {
    const d = repo()
    put(d, 'hk/pre-commit', 'exit 0\n')
    expect(run('git -c core.hooksPath=hk commit -m x', d)).toBeUndefined()
  })

  test.each(['npx pretti""er --write .', 'bunx pret\\tier --write .'])('denies a split bin name: %s', cmd => {
    const d = repo()
    put(d, 'node_modules/.bin/prettier', bad())
    expect(run(cmd, d)).toBe(HOME_REASON)
  })

  test('denies a core.fsmonitor program, path against the top dir', () => {
    const d = repo()
    git(d, 'config', 'core.fsmonitor', './fsm.sh')
    put(d, 'fsm.sh', bad())
    mkdirSync(join(d, 'sub'))
    expect(run('git status', d, join(d, 'sub'))).toBe(HOME_REASON)
  })

  test('denies a filter clean program', () => {
    const d = repo()
    git(d, 'config', 'filter.acme.clean', 'sh ./clean.sh')
    put(d, 'clean.sh', bad())
    expect(run('git add x', d)).toBe(HOME_REASON)
  })

  test.each(['.prettierrc.cjs', 'prettier.config.js'])('denies prettier config %s', f => {
    const d = repo()
    put(d, f, bad())
    expect(run('bunx prettier --write x.ts', d)).toBe(HOME_REASON)
  })

  test('denies a prettier plugin that a parent config names', () => {
    const d = repo()
    put(d, '.prettierrc', '{"plugins":["./plug.cjs"]}')
    put(d, 'plug.cjs', bad())
    mkdirSync(join(d, 'sub'))
    expect(run('bunx prettier --write x.ts', d, join(d, 'sub'))).toBe(HOME_REASON)
  })

  test.each(['bunx prettier --write .', 'bunx prettier@3.9.9 --check .'])('denies a local bin: %s', cmd => {
    const d = repo()
    put(d, 'node_modules/.bin/prettier', bad())
    expect(run(cmd, d)).toBe(HOME_REASON)
  })

  test('denies a bunfig preload', () => {
    const d = repo()
    put(d, 'bunfig.toml', '[test]\npreload = ["./pre.ts"]')
    put(d, 'pre.ts', bad())
    expect(run('bun test', d)).toBe(HOME_REASON)
  })

  test('denies a package.json script', () => {
    const d = repo()
    put(d, 'package.json', JSON.stringify({ scripts: { clean: bad() } }))
    expect(run('bun run clean', d)).toBe(HOME_REASON)
  })

  test.each(['Makefile', 'makefile', 'GNUmakefile'])('denies %s', f => {
    const d = repo()
    put(d, f, 'clean:\n\t' + bad())
    expect(run('make', d)).toBe(HOME_REASON)
  })

  test.each(["sh -c 'bunx prettier --write .'", 'bun run fmt'])(
    'denies a bin that a command or script names: %s',
    cmd => {
      const d = repo()
      put(d, 'package.json', '{"scripts":{"fmt":"prettier --write ."}}')
      put(d, 'node_modules/.bin/prettier', bad())
      expect(run(cmd, d)).toBe(HOME_REASON)
    },
  )

  test('allows a fresh repo with a plain prettier config', () => {
    const d = repo()
    put(d, '.prettierrc', '{ "semi": false }')
    for (const cmd of ['git commit -m x', 'git status', 'bunx prettier --write .'])
      expect(run(cmd, d)).toBeUndefined()
  })

  test('skips a .sample hook', () => {
    const d = repo()
    put(d, '.git/hooks/pre-commit.sample', bad())
    expect(run('git commit -m x', d)).toBeUndefined()
  })

  test('reads only a bin that the command names', () => {
    const d = repo()
    put(d, 'node_modules/.bin/other', bad())
    expect(run('bunx prettier --write .', d)).toBeUndefined()
  })

  test('a read failure of the git config denies; a dir outside a work tree does not', () => {
    const gone = '/nonexistent-acme'
    expect(loadedTexts('ls', gone)).toBeUndefined()
    expect(denyReason('ls', gone, undefined, { loaded: c => loadedTexts(c, gone) })).toBe(LOADED_REASON)
    const e = mkdtempSync(join(tmpdir(), 'loaded-'))
    expect(Array.isArray(loadedTexts('ls', e))).toBe(true)
    expect(denyReason('ls', e, undefined, { loaded: c => loadedTexts(c, e) })).toBeUndefined()
  })
})

describe('the hook process', () => {
  const hook = (cwd: string) => {
    const fresh = () => mkdtempSync(join(tmpdir(), 'loaded-'))
    const p = Bun.spawnSync(['bun', join(import.meta.dir, 'worker-hook.ts')], {
      stdin: Buffer.from(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          cwd,
          tool_input: { command: 'git commit -m x' },
        }),
      ),
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: cwd,
        HOME: fresh(),
        FACTORY_HOME: fresh(),
        FACTORY_DEADLINE: '',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        FACTORY_RUN: undefined,
        FACTORY_OUTBOX: undefined,
        FACTORY_DENY_LOG: undefined,
        FACTORY_HARNESS: undefined,
      },
    })
    const out = p.stdout.toString().trim()
    return out ? JSON.parse(out).hookSpecificOutput : undefined
  }

  test('main wires the loader', () => {
    const d = repo()
    expect(hook(d)).toBeUndefined()
    put(d, '.git/hooks/pre-commit', bad())
    const out = hook(d)
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toBe(HOME_REASON)
  })
})

describe('this repo', () => {
  const root = join(import.meta.dir, '..')
  const rd = (p: string) => {
    try {
      return readFileSync(join(root, p), 'utf8')
    } catch {
      return undefined
    }
  }

  test('its own config and hooks give no false deny', () => {
    const L = ['.prettierrc', 'package.json', 'bunfig.toml', 'node_modules/.bin/prettier']
      .map(p => rd(p))
      .concat(
        (existsSync(join(root, '.beads-hooks')) ? readdirSync(join(root, '.beads-hooks')) : []).map(f =>
          rd(join('.beads-hooks', f)),
        ),
      )
      .filter((t): t is string => t !== undefined)
      .map(text => ({ text, dir: root }))
    expect(L.length).toBeGreaterThan(2)
    const read = (p: string) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    }
    expect(homeReason('git commit -m x', read, undefined, L)).toBeUndefined()
  })

  test('the loader is cheap', () => {
    const t = Date.now()
    const r = loadedTexts('git commit -m x', root)
    expect(Array.isArray(r)).toBe(true)
    expect(Date.now() - t).toBeLessThan(1000)
  })
})
