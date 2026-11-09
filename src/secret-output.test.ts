// SC-005: no command output holds a token or a secret value. Planted values are built by concatenation.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tokenCommand } from './claude-token'
import { hideParseText } from './secrets'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const SHAPED = 'ghp_' + 'zqsecret' + 'a'.repeat(28)
const KEYED = 'zqsecret' + '-keyed'
const USERINFO_URL = 'https://bot:' + 'zqsecret' + '@dolt.example.com/db'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tokenKeys = (tmp: string, read = `sh '${tmp}/read.sh' "$1"`) => ({
  'token.read': read,
  'token.write': `sh '${tmp}/write.sh' "$1"`,
  'token.live-field': 'live',
  'token.slot-field': 'account_%s_token',
  'token.active-field': 'active',
})

const setup = (settings?: (tmp: string) => Record<string, string>) => {
  const tmp = mkdtempSync(join(tmpdir(), 'secret-output-'))
  dirs.push(tmp)
  const home = join(tmp, 'home')
  mkdirSync(home)
  mkdirSync(join(tmp, 'store'))
  writeFileSync(join(tmp, 'read.sh'), `[ -f '${tmp}/store/'"$1" ] || exit 1\ncat '${tmp}/store/'"$1"\n`)
  writeFileSync(join(tmp, 'write.sh'), `cat > '${tmp}/store/'"$1"\n`)
  for (const [f, v] of Object.entries({
    account_1_token: 'zqsecret-1',
    account_2_token: 'zqsecret-2',
    live: 'old',
    active: '1',
  }))
    writeFileSync(join(tmp, 'store', f), v)
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify(settings ? settings(tmp) : { 'ax.image': SHAPED, ...tokenKeys(tmp) }),
  )
  writeFileSync(join(home, 'devenv.json'), JSON.stringify({ token: SHAPED }))
  const repo = join(tmp, 'repo')
  mkdirSync(join(repo, '.beads'), { recursive: true })
  Bun.spawnSync(['git', '-C', repo, 'init', '-q'])
  const rigsPath = join(home, 'rigs.json')
  writeFileSync(
    rigsPath,
    JSON.stringify([
      {
        name: 'x',
        repo,
        factory: 'lifecycle',
        agent: 'run ' + SHAPED,
        goal: 'goal ' + SHAPED,
        slo: 'slo ' + SHAPED,
        drift: 'drift ' + SHAPED,
        mcp: 'mcp ' + SHAPED,
        linear: { team: [SHAPED] },
        env: { API_TOKEN: KEYED, PLAIN: SHAPED },
        params: { db_password: KEYED },
        beadsRemote: { name: 'origin', url: USERINFO_URL, user: 'bot' },
      },
    ]),
  )
  const run = (args: string[], code: number, env: Record<string, string> = {}) => {
    const clean = { ...process.env } as Record<string, string | undefined>
    for (const k of Object.keys(clean))
      if (/^(FACTORY_(OUTBOX|FROM|RUN|DEF_NAME|PATROL|SERVER|AX_.*|KUBECTL|MAX_RUNS)|BEADS_ACTOR)$/.test(k))
        delete clean[k]
    const p = Bun.spawnSync([CLI, ...args], {
      env: {
        ...clean,
        FACTORY_HOME: home,
        FACTORY_SELF_UPDATE: '0',
        FACTORY_GC: '0',
        FACTORY_NO_KICK: '1',
        FACTORY_AX_VAULT: SHAPED,
        ...env,
      } as Record<string, string>,
    })
    const out = p.stdout.toString()
    const err = p.stderr.toString()
    expect(out + err, args.join(' ')).not.toContain('zqsecret')
    expect(p.exitCode, args.join(' ')).toBe(code)
    return { out, err }
  }
  return { tmp, home, repo, rigsPath, run, store: (f: string) => readFileSync(join(tmp, 'store', f), 'utf8') }
}

describe('no command prints a secret', () => {
  test('settings', () => {
    const { run } = setup()
    run(['help'], 0)
    run(['settings'], 0)
    expect(run(['settings', 'list'], 0).out).toContain('<hidden>')
    run(['settings', 'set', 'ax.vault', SHAPED], 1)
    expect(run(['settings', 'set', SHAPED, 'v'], 1).err).toContain('unknown setting <hidden>')
    run(['settings', 'set', 'devenv.token', SHAPED], 1)
    run(['settings', 'unset', 'ax.image'], 0)
  }, 60_000)

  test('rig', () => {
    const { run } = setup()
    run(['rig', 'list'], 0)
    expect(run(['rig', 'show', 'x'], 0).out).toContain('<hidden>')
    run(['rig', 'env', 'set', 'x', 'NEW_TOKEN=zqsecret-new'], 0)
    run(['rig', 'set', 'x', '--max', '2'], 0)
    run(['rig', 'env', 'unset', 'x', 'NEW_TOKEN'], 0)
    expect(run(['rig', 'history'], 0).out.trim().split('\n')).toHaveLength(3)
    run(['rig', 'undo'], 0)
    run(['rig', 'show', 'x'], 0)
  }, 60_000)

  test('token', () => {
    const { run } = setup()
    run(['token', 'use', '2'], 0)
    run(['token', 'use', '3'], 1)
  }, 60_000)

  test('token locked', () => {
    const { run } = setup(tmp => ({ 'ax.image': SHAPED, ...tokenKeys(tmp, 'exit 1') }))
    run(['token', 'list'], 1)
  }, 60_000)

  test('token unset', () => {
    const { run } = setup(() => ({ 'ax.image': SHAPED }))
    run(['token'], 1)
  }, 60_000)

  test('image', () => {
    const { tmp, run } = setup(t => ({
      'ax.image': SHAPED,
      ...tokenKeys(t),
      'image.registry': 'reg.example/acme',
      'image.builder': 'amd64',
    }))
    const bin = join(tmp, 'bin')
    mkdirSync(bin)
    const fake = join(bin, 'docker')
    writeFileSync(
      fake,
      `#!/bin/sh
echo "$@" > "$FAKE_DOCKER_MARKER"
echo noise
prev=
for a in "$@"; do
  if [ "$prev" = --metadata-file ]; then
    echo '{"containerimage.digest":"sha256:${'a'.repeat(64)}"}' > "$a"
  fi
  prev=$a
done
`,
    )
    chmodSync(fake, 0o755)
    const r = run(['image', 'build'], 0, {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DOCKER_MARKER: join(tmp, 'docker-argv'),
      FACTORY_AX_IMAGE: SHAPED,
    })
    expect(r.err).toContain('FACTORY_AX_IMAGE')
  }, 60_000)

  test('up', () => {
    const { tmp, run } = setup()
    const bin = join(tmp, 'pathbin')
    mkdirSync(bin)
    for (const n of ['sh', 'realpath', 'dirname', 'bun']) {
      const p = Bun.which(n)
      if (p) symlinkSync(p, join(bin, n))
    }
    expect(run(['up'], 1, { PATH: bin }).err).toContain('claude not on PATH')
  }, 60_000)
})

describe('a bad devenv.json and an agent refusal hide the secret', () => {
  test('devenv', () => {
    const { home, run } = setup()
    writeFileSync(join(home, 'devenv.json'), '{"token": ' + 'zqsecret' + 'bare}')
    const r = run(['devenv'], 1, { FACTORY_AX_IMAGE: 'img' })
    expect(r.out + r.err).toContain('not valid JSON')
  }, 60_000)

  test('agent', () => {
    const { repo, run } = setup()
    const args = ['rig', 'add', 'y', repo, 'lifecycle', '--runner', 'ax', '--agent', SHAPED]
    expect(run(args, 1).err).toContain('not "<hidden>"')
  }, 60_000)
})

describe('a bad rigs.json hides its text', () => {
  const bad = (repo: string) =>
    `[{"name":"x","repo":"${repo}","factory":"lifecycle","env":{"API_TOKEN": ` + 'zqsecret' + 'bare}}]'
  const good = (repo: string) => bad(repo).replace('zqsecretbare', '"v"')
  const row = (run: ReturnType<typeof setup>['run'], rigsPath: string, args: string[]) => {
    const before = readFileSync(rigsPath, 'utf8')
    const r = run(args, 1)
    expect(r.out + r.err, args.join(' ')).toContain('not valid JSON')
    expect(r.out + r.err, args.join(' ')).toContain('<hidden>')
    expect(readFileSync(rigsPath, 'utf8')).toBe(before)
  }

  test('bad current file', () => {
    const { home, repo, rigsPath, run } = setup()
    writeFileSync(rigsPath, bad(repo))
    mkdirSync(join(home, 'rigs-history'))
    writeFileSync(join(home, 'rigs-history', '20260101T000000000Z.json'), good(repo))
    for (const args of [
      ['rig', 'show', 'x'],
      ['rig', 'list'],
      ['rig', 'set', 'x', '--max', '2'],
      ['rig', 'env', 'set', 'x', 'A=b'],
      ['rig', 'undo'],
    ])
      row(run, rigsPath, args)
  }, 60_000)

  test('bad snapshot', () => {
    const { home, repo, rigsPath, run } = setup()
    writeFileSync(rigsPath, good(repo))
    mkdirSync(join(home, 'rigs-history'))
    writeFileSync(join(home, 'rigs-history', '99990101T000000000Z.json'), bad(repo))
    row(run, rigsPath, ['rig', 'undo'])
  }, 60_000)
})

describe('hideParseText', () => {
  test.each([
    [
      'JSON Parse error: Unexpected identifier "' + 'zqsecret' + '"',
      'JSON Parse error: Unexpected identifier <hidden>',
    ],
    ['JSON Parse error: "\\u' + 'zqse" is not a valid unicode escape', 'JSON Parse error: <hidden>'],
    ['a "b" c "d', 'a <hidden>'],
    ['a "b\nc"', 'a <hidden>'],
    ["JSON Parse error: Expected '}'", "JSON Parse error: Expected '}'"],
    ['', ''],
  ])('%s', (input, out) => {
    expect(hideParseText(input)).toBe(out)
  })
})

describe('token list and best', () => {
  const store = () => {
    const { tmp } = setup()
    return { tmp, stored: tokenKeys(tmp) as Record<string, string> }
  }
  const header = (init: unknown) => (init as { headers: Record<string, string> }).headers.authorization
  const okFetch = (seen: string[]) => async (_u: unknown, init: unknown) => {
    seen.push(header(init)!)
    return new Response(null, {
      headers: {
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.2',
      },
    })
  }
  const throwFetch = async (_u: unknown, init: unknown) => {
    throw new Error(header(init))
  }

  test('list probes each token and prints none', async () => {
    const { stored } = store()
    const seen: string[] = []
    const text = await tokenCommand(['list'], stored, okFetch(seen) as never)
    expect(text).not.toContain('zqsecret')
    expect(seen.sort()).toEqual(['Bearer zqsecret-1', 'Bearer zqsecret-2'])
  })

  test('best picks slot 1 on a tie and prints no token', async () => {
    const { tmp, stored } = store()
    const text = await tokenCommand(['best'], stored, okFetch([]) as never)
    expect(text).not.toContain('zqsecret')
    expect(readFileSync(join(tmp, 'store', 'live'), 'utf8')).toBe('zqsecret-1')
    expect(readFileSync(join(tmp, 'store', 'active'), 'utf8')).toBe('1')
  })

  test('a probe error hides the token', async () => {
    const { stored } = store()
    const text = await tokenCommand(['list'], stored, throwFetch as never)
    expect(text).not.toContain('zqsecret')
    expect(text).toContain('error')
    let msg = ''
    await tokenCommand(['best'], stored, throwFetch as never).catch(e => (msg = (e as Error).message))
    expect(msg).not.toBe('')
    expect(msg).not.toContain('zqsecret')
  })
})
