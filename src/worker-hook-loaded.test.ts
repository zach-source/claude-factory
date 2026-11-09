import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { HOME_REASON, homeReason, LOADED_REASON, OVERRIDE_REASON } from './home-guard'
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

  // claude-factory-qn8a.37.4, .7, .8, .10, .11 and .12: an inline hooks or include override
  // gives OVERRIDE_REASON, whatever the quotes, the value, the dir or the git word.
  const D = String.fromCharCode(36)
  const T = String.fromCharCode(126)
  test.each([
    ['git -c core.hooksPath=hk commit -m x', false],
    ['git -c CORE.HOOKSPATH=hk add x', false],
    ['git -c core.hookspath=hk commit -m x', false],
    ['git -c core.hooksPath=hk commit -m x', true],
    [`git -c core.hooks${D}''Path=hk commit -m x`, false],
    ['git -c core.hook\\\nsPath=hk commit -m x', false],
    ['echo x | git -c core.hooksPath=hk commit -F -', false],
    ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=hk git commit -m x', false],
    ['git -c include.path=inc commit -m x', false],
    ['git -c includeIf.gitdir:/.path=inc commit -m x', false],
    ['git --config-env=core.hooksPath=HP commit -m x', false],
    ['git --config-env core.hooksPath=HP commit -m x', false],
    ['git -c core.hooksPath commit -m x', false],
    ['git -c core.hooksPath= commit -m x', false],
    ['git -c core.hooksPath=h""k commit -m x', false],
    ["git -c core.hooksPath=h''k commit -m x", false],
    ['git -c core.hooksPath=h\\k commit -m x', false],
    ['git -c core.hooks""Path=hk commit -m x', false],
    ['git -c core.hooks\\Path=hk commit -m x', false],
    ['git -c "core.hooksPath=h k" commit -m x', false],
    ['git -c core.hooksPath=hk -c core.hooksPath=h""k2 commit -m x', false],
    ['git --config-env=core.hooks""Path=HP commit -m x', false],
    [`git -c core.hooksPath=${T}/hk commit -m x`, false],
    ['git -c core.hooksPath=`echo hk` commit -m x', false],
    [`git -c core.hooksPath=${D}H commit -m x`, false],
    ['grep -c core.hooksPath README.md', false],
    ['grep -n core.hooksPath README.md', false],
  ] as [string, boolean][])('denies an inline hooks or include override: %s', (cmd, sub) => {
    const d = repo()
    put(d, 'hk/pre-commit', 'exit 0\n')
    mkdirSync(join(d, 'sub'))
    expect(run(cmd, d, sub ? join(d, 'sub') : d)).toBe(OVERRIDE_REASON)
  })

  test.each(['-c core.hooksPath=hk commit', '-c include.path=inc commit'])(
    'denies a git alias that holds an override: %s',
    value => {
      const d = repo()
      git(d, 'config', 'alias.ci', value)
      expect(run('git ci -m x', d)).toBe(OVERRIDE_REASON)
    },
  )

  test('allows a command with no override text', () => {
    const d = repo()
    expect(run('git commit -m x', d)).toBeUndefined()
    expect(run('git -c user.name=acme commit -m x', d)).toBeUndefined()
    expect(run("grep -n 'hooks path' README.md", d)).toBeUndefined()
  })

  test('allows a hooks dir key and an include key in the config (only alias values count)', () => {
    const d = repo()
    git(d, 'config', 'core.hooksPath', 'hk')
    git(d, 'config', 'include.path', 'inc')
    put(d, 'hk/pre-commit', 'exit 0\n')
    expect(run('git commit -m x', d)).toBeUndefined()
  })

  // claude-factory-qn8a.37.9: the joined config text is stripped like the command
  test.each([
    ['Makefile', 'fmt:\n\tnpx pretti""er --write .\n', 'make fmt'],
    ['package.json', '{"scripts":{"fmt":"pret\\\\tier --write ."}}', 'npm run fmt'],
  ])('denies a split bin name in %s', (f, text, cmd) => {
    const d = repo()
    put(d, f, text)
    put(d, 'node_modules/.bin/prettier', bad())
    expect(run(cmd, d)).toBe(HOME_REASON)
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

  // claude-factory-qn8a.37.17: every node_modules/.bin file is read, whatever the command text.
  const BS = '\\'
  test.each([
    ['npx pret' + BS + '\ntier --write .', undefined, undefined],
    ['bunx prettie' + BS + '\nr --write .', undefined, undefined],
    ['make fmt', 'Makefile', 'fmt:\n\tnpx pret' + BS + '\ntier --write .\n'],
    ['make fmt', 'Makefile', 'fmt:\n\tnpx pret' + BS + '\n\ttier --write .\n'],
    ['npm run fmt', 'package.json', '{"scripts":{"fmt":"npx pret' + BS + BS + BS + 'ntier --write ."}}'],
  ])('denies a bin whose name a line join hides: %s', (cmd, file, text) => {
    const d = repo()
    if (file && text) put(d, file, text)
    put(d, 'node_modules/.bin/prettier', bad())
    expect(run(cmd, d)).toBe(HOME_REASON)
  })

  test.each(['git status', 'ls', 'bunx prettier --write .'])('reads a bin that nothing names: %s', cmd => {
    const d = repo()
    put(d, 'node_modules/.bin/zz-acme', bad())
    expect(run(cmd, d)).toBe(HOME_REASON)
  })

  test('reads a bin in a parent dir', () => {
    const d = repo()
    put(d, 'node_modules/.bin/zz-acme', bad())
    mkdirSync(join(d, 'sub'))
    expect(run('git status', d, join(d, 'sub'))).toBe(HOME_REASON)
  })

  test.each(['bunx prettier --write .', 'git commit -m x', 'npm run fmt'])('allows a plain bin: %s', cmd => {
    const d = repo()
    put(d, 'package.json', '{"scripts":{"fmt":"prettier --write ."}}')
    put(d, 'node_modules/.bin/prettier', '#!/usr/bin/env node\nrequire("../prettier/bin.cjs")\n')
    expect(run(cmd, d)).toBeUndefined()
  })

  test('allows a repo with no node_modules', () => {
    expect(run('git status', repo())).toBeUndefined()
  })

  describe('the file and char caps', () => {
    const clean = () => {
      for (let p = tmpdir(); ; p = resolve(p, '..')) {
        expect(existsSync(join(p, 'node_modules', '.bin'))).toBe(false)
        expect(readdirSync(p).filter(n => /^(?:package\.json|bunfig\.toml|[Mm]akefile)$/.test(n))).toEqual([])
        if (resolve(p, '..') === p) break
      }
    }
    const fill = (d: string, rel: string, n: number, text = '', from = 0) => {
      mkdirSync(join(d, rel), { recursive: true })
      for (let i = from; i < from + n; i++) writeFileSync(join(d, rel, 'f' + i), text)
    }
    test('1025 files are over the cap, 1020 are not', () => {
      clean()
      const d = repo()
      fill(d, 'node_modules/.bin', 1025)
      expect(loadedTexts('ls', d)).toBeUndefined()
      expect(run('ls', d)).toBe(LOADED_REASON)
      const e = repo()
      fill(e, 'node_modules/.bin', 1020)
      expect(Array.isArray(loadedTexts('ls', e))).toBe(true)
      expect(run('ls', e)).toBeUndefined()
    })
    test('the count is a total over all dirs', () => {
      clean()
      const d = repo()
      mkdirSync(join(d, 'sub'))
      fill(d, 'sub/node_modules/.bin', 600)
      fill(d, 'node_modules/.bin', 425)
      expect(loadedTexts('ls', join(d, 'sub'))).toBeUndefined()
    })
    test('the hooks files count too', () => {
      clean()
      const d = repo()
      fill(d, 'node_modules/.bin', 1000)
      fill(d, '.git/hooks', 25, '', 0)
      expect(loadedTexts('ls', d)).toBeUndefined()
    })
    test('70 files of 64000 chars are over the char cap, 60 are not', () => {
      clean()
      const t = 'a'.repeat(64000)
      const d = repo()
      fill(d, 'node_modules/.bin', 70, t)
      expect(loadedTexts('ls', d)).toBeUndefined()
      const e = repo()
      fill(e, 'node_modules/.bin', 60, t)
      expect(Array.isArray(loadedTexts('ls', e))).toBe(true)
    })
    test('60 big files and 1000 small files load fast', () => {
      clean()
      const line =
        'const x = require("./lib/a.js"); process.env.HOMEDIRX; os.homedir(); fs.readSync(p) ./x/y.sh\n'
      const d = repo()
      fill(d, 'node_modules/.bin', 60, line.repeat(800).slice(0, 64000))
      let t = Date.now()
      expect(run('ls', d)).toBeUndefined()
      expect(Date.now() - t).toBeLessThan(5000)
      const e = repo()
      fill(e, 'node_modules/.bin', 1000, 'x'.repeat(2048))
      t = Date.now()
      expect(Array.isArray(loadedTexts('ls', e))).toBe(true)
      expect(Date.now() - t).toBeLessThan(1000)
    })
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
    const bins = existsSync(join(root, 'node_modules/.bin'))
      ? readdirSync(join(root, 'node_modules/.bin')).map(f => join('node_modules/.bin', f))
      : []
    const L = ['.prettierrc', 'package.json', 'bunfig.toml', ...bins]
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
