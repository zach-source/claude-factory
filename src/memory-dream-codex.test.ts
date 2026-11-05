// claude-factory-y3zo: `factory dream` can run on codex when FACTORY_DREAM_CODEX names a model.
// It spawns bin/factory like memory-dream-commit.test.ts, with a fake codex and a fake claude.
import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-dream-codex-${process.pid}`)
const home = join(dir, 'home')
const memory = join(home, 'memory')
const userCodex = join(dir, 'user-codex')
const marks = join(dir, 'marks')
const SLOW = 30_000

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_DREAM_CODEX, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, 'dream'], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      FACTORY_SELF_UPDATE: '0',
      CODEX_HOME: userCodex,
      FAKE_MARKS: marks,
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}

const gitMemory = (...args: string[]) =>
  Bun.spawnSync(['git', '-C', memory, ...args])
    .stdout.toString()
    .trim()
const mark = (name: string) => join(marks, name)
const read = (name: string) => readFileSync(mark(name), 'utf8')

const U = '019a3b2c-0000-7000-8000-000000000001'
const ROLLOUT = [
  { type: 'session_meta', payload: { id: U } },
  { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
  {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          output_tokens: 7,
          total_tokens: 107,
        },
        last_token_usage: { input_tokens: 100 },
      },
    },
  },
]
  .map(l => JSON.stringify(l))
  .join('\n')

function fake(name: string, body: string[]) {
  const file = join(dir, name)
  writeFileSync(file, ['#!/bin/sh', 'set -e', 'm="$FAKE_MARKS"', ...body, ''].join('\n'))
  chmodSync(file, 0o755)
  return file
}

/** the fake codex: records argv, cwd, CODEX_HOME and stdin, then files x.md with a plain mv */
function fakeCodex() {
  const roll = join(dir, 'rollout.jsonl')
  writeFileSync(roll, ROLLOUT + '\n')
  return fake('fake-codex.sh', [
    `printf '%s\\n' "$@" > "$m/codex.argv"`,
    `pwd > "$m/codex.pwd"`,
    `echo "$CODEX_HOME" > "$m/codex.home"`,
    `cat > "$m/codex.stdin"`,
    `if [ "$FAKE_BOOM" = 1 ]; then echo boom >&2; fi`,
    `d="$CODEX_HOME/sessions/2026/11/04"; mkdir -p "$d"`,
    `cp "${roll}" "$d/rollout-2026-11-04T00-00-00-${U}.jsonl"`,
    `if [ "$FAKE_EXTRAS" = 1 ]; then`,
    `  cp "${roll}" "$d/rollout-old-${U}.jsonl"; touch -t 202001010000 "$d/rollout-old-${U}.jsonl"`,
    `  ln -s "${roll}" "$d/rollout-link-${U}.jsonl"; cp "${roll}" "$d/notes.jsonl"`,
    `fi`,
    `if [ "$FAKE_LINK" = 1 ]; then`,
    `  ln -s "$FAKE_DIR/secret" inbox/y.md; mkdir -p topic/sub`,
    `  ln -s "$FAKE_DIR/secretdir" topic/linkdir; ln -s /nonexistent topic/sub/dangle.md`,
    `fi`,
    `if [ "$FAKE_BOOM" = 1 ]; then exit 3; fi`,
    `mkdir -p topic && mv inbox/x.md topic/x.md`,
    `echo "filed x.md under topic/x.md"`,
  ])
}

function fakeClaude() {
  return fake('fake-claude.sh', [
    `printf '%s\\n' "$@" > "$m/claude.argv"`,
    `cat > "$m/claude.stdin"`,
    `mkdir -p topic && git mv inbox/x.md topic/x.md`,
    `echo "claude filed x"`,
  ])
}

function seed() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(memory, 'inbox'), { recursive: true })
  mkdirSync(marks, { recursive: true })
  mkdirSync(userCodex, { recursive: true })
  writeFileSync(
    join(memory, 'inbox', 'x.md'),
    '---\nsummary: a fixture note waiting to be filed\n---\nbody text\n',
  )
  writeFileSync(
    join(memory, '.usage.jsonl'),
    `${JSON.stringify({ path: 'inbox/x.md', shown: 1, at: Date.now() - 1000 })}\n`,
  )
}

const bothFakes = (env: Record<string, string> = {}) => ({
  FACTORY_CLAUDE: fakeClaude(),
  FACTORY_CODEX: fakeCodex(),
  ...env,
})

const dreamRows = () =>
  existsSync(join(home, 'manager-usage.jsonl'))
    ? readFileSync(join(home, 'manager-usage.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []

for (const [label, env] of [
  ['unset', {}],
  ['empty', { FACTORY_DREAM_CODEX: '' }],
] as const) {
  test(
    `AC1: FACTORY_DREAM_CODEX ${label} runs claude, not codex`,
    () => {
      seed()
      expect(run(bothFakes(env)).code).toBe(0)
      expect(existsSync(mark('claude.argv'))).toBe(true)
      expect(existsSync(mark('codex.argv'))).toBe(false)
      expect(read('claude.stdin')).not.toContain('keeps .git read-only')
    },
    SLOW,
  )
}

test(
  'AC2/AC4/AC6/AC7/AC8: codex argv, private home, prompt suffix, plain mv, usage row',
  () => {
    seed()
    writeFileSync(join(userCodex, 'auth.json'), '{}')
    writeFileSync(join(userCodex, 'hooks.json'), '{}')
    writeFileSync(join(userCodex, 'config.toml'), '[mcp_servers.x]\n')
    const r = run(bothFakes({ FACTORY_DREAM_CODEX: 'gpt-6-astra', FAKE_EXTRAS: '1' }))
    expect(r.code).toBe(0)
    expect(existsSync(mark('claude.argv'))).toBe(false)
    const memReal = Bun.spawnSync(['realpath', memory]).stdout.toString().trim()
    expect(read('codex.argv').trimEnd().split('\n')).toEqual([
      'exec',
      '-s',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-C',
      memory,
      '-m',
      'gpt-6-astra',
      '-',
    ])
    expect(read('codex.pwd').trim()).toBe(memReal)

    // AC4
    const dh = join(home, 'codex-dream')
    expect(read('codex.home').trim()).toBe(dh)
    expect(lstatSync(dh).mode & 0o777).toBe(0o700)
    expect(readlinkSync(join(dh, 'auth.json'))).toBe(join(userCodex, 'auth.json'))
    expect(existsSync(join(dh, 'hooks.json'))).toBe(false)
    expect(readFileSync(join(dh, 'config.toml'), 'utf8')).toBe(
      `[projects.${JSON.stringify(memory)}]\ntrust_level = "trusted"\n`,
    )

    // AC6
    expect(
      read('codex.stdin').endsWith(
        'Your sandbox keeps .git read-only, so git mv and git rm fail. Use mkdir, mv, rm and rm -r (not rm -f). The factory stages your changes with git add -A.',
      ),
    ).toBe(true)

    // AC7
    expect(gitMemory('status', '--porcelain')).toBe('')
    expect(gitMemory('log', '-1', '--grep=^dream:', '--format=%s')).toBe('dream: filed x.md under topic/x.md')
    const dreamCommit = gitMemory('log', '-1', '--grep=^dream:', '--format=%H')
    expect(gitMemory('show', `${dreamCommit}:.usage.jsonl`)).toContain('"path":"topic/x.md"')
    expect(gitMemory('show', `${dreamCommit}:.renames.jsonl`)).toContain('"old":"inbox/x.md"')
    expect(gitMemory('show', `${dreamCommit}:.renames.jsonl`)).toContain('"new":"topic/x.md"')

    // AC8: one row; the old, symlinked and non-rollout files give none
    expect(dreamRows()).toEqual([
      {
        name: 'dream',
        at: expect.any(Number),
        model: 'gpt-6-astra',
        input: 40,
        cacheWrite: 0,
        cacheRead: 60,
        output: 7,
        turns: 1,
        peak: 100,
      },
    ])
  },
  SLOW,
)

test(
  'AC4: without a user auth.json the dream home has no link and the dream still runs',
  () => {
    seed()
    mkdirSync(join(home, 'codex-dream'), { mode: 0o755 }) // an older dream home with loose rights
    expect(run(bothFakes({ FACTORY_DREAM_CODEX: 'o3' })).code).toBe(0)
    expect(existsSync(mark('codex.argv'))).toBe(true)
    expect(() => lstatSync(join(home, 'codex-dream', 'auth.json'))).toThrow()
    expect(lstatSync(join(home, 'codex-dream')).mode & 0o777).toBe(0o700)
  },
  SLOW,
)

for (const bad of [
  '-m',
  '--dangerously-bypass-approvals-and-sandbox',
  'a b',
  'a;b',
  '$(x)',
  'a'.repeat(65),
]) {
  test(
    `AC3: model ${JSON.stringify(bad)} is refused before any spawn`,
    () => {
      seed()
      const r = run(bothFakes({ FACTORY_DREAM_CODEX: bad }))
      expect(r.out).toContain('FACTORY_DREAM_CODEX is not a model name')
      expect(readFileSync(join(home, 'dream.log'), 'utf8')).toContain(
        'refused\nFACTORY_DREAM_CODEX is not a model name',
      )
      expect(existsSync(mark('claude.argv'))).toBe(false)
      expect(existsSync(mark('codex.argv'))).toBe(false)
      expect(gitMemory('log', '--grep=^dream:', '--format=%H')).toBe('')
    },
    SLOW,
  )
}

test(
  'AC5: a .codex dir and an unwritable dream.log still stop the codex dream',
  () => {
    seed()
    mkdirSync(join(memory, '.codex'))
    mkdirSync(join(home, 'dream.log'))
    run(bothFakes({ FACTORY_DREAM_CODEX: 'gpt-6-astra' }))
    expect(existsSync(mark('codex.argv'))).toBe(false)
  },
  SLOW,
)

test(
  'AC3: an allowed model name reaches codex',
  () => {
    seed()
    expect(run(bothFakes({ FACTORY_DREAM_CODEX: 'gpt-5.1-codex:latest' })).code).toBe(0)
    expect(read('codex.argv')).toContain('-m\ngpt-5.1-codex:latest\n')
  },
  SLOW,
)

for (const kind of ['dir', 'file', 'symlink'] as const) {
  test(
    `AC5: a .codex ${kind} in the memory refuses the codex dream`,
    () => {
      seed()
      const p = join(memory, '.codex')
      if (kind === 'dir') mkdirSync(p)
      else if (kind === 'file') writeFileSync(p, 'x')
      else symlinkSync('/nonexistent-target', p)
      const r = run(bothFakes({ FACTORY_DREAM_CODEX: 'gpt-6-astra' }))
      expect(r.out).toContain('the memory holds .codex, which would add codex project config')
      expect(readFileSync(join(home, 'dream.log'), 'utf8')).toContain('refused\nthe memory holds .codex')
      expect(existsSync(mark('codex.argv'))).toBe(false)
      expect(gitMemory('log', '--grep=^dream:', '--format=%H')).toBe('')
    },
    SLOW,
  )
}

test(
  'AC9: a codex exit 3 logs the error, makes no dream commit and still stores usage',
  () => {
    seed()
    const r = run(bothFakes({ FACTORY_DREAM_CODEX: 'gpt-6-astra', FAKE_BOOM: '1' }))
    expect(r.out).toContain('the dream exited 3: boom')
    const log = readFileSync(join(home, 'dream.log'), 'utf8')
    expect(log).toMatch(/^\S+ exit 3$/m)
    expect(log).toContain('the dream exited 3: boom')
    expect(gitMemory('log', '--grep=^dream:', '--format=%H')).toBe('')
    expect(dreamRows()).toHaveLength(1)
  },
  SLOW,
)

for (const boom of ['', '1']) {
  test(
    `eqxi AC1/AC2: a link the codex dream makes is removed (exit ${boom ? 3 : 0}), logged, and never committed`,
    () => {
      seed()
      const secret = join(dir, 'secret')
      writeFileSync(secret, 'zqsecret-eqxi')
      mkdirSync(join(dir, 'secretdir'))
      writeFileSync(join(dir, 'secretdir', 'a.md'), 'zqsecret-eqxi')
      run(bothFakes({ FACTORY_DREAM_CODEX: 'gpt-6-astra', FAKE_LINK: '1', FAKE_BOOM: boom, FAKE_DIR: dir }))
      for (const p of ['inbox/y.md', 'topic/linkdir', 'topic/sub/dangle.md'])
        expect(() => lstatSync(join(memory, p))).toThrow()
      expect(readFileSync(secret, 'utf8')).toBe('zqsecret-eqxi')
      expect(readFileSync(join(dir, 'secretdir', 'a.md'), 'utf8')).toBe('zqsecret-eqxi')
      expect(gitMemory('log', '-p', '--raw', '--format=')).not.toContain('120000')
      expect(gitMemory('ls-files', '-s')).not.toContain('120000')
      const log = readFileSync(join(home, 'dream.log'), 'utf8')
      expect(log).toContain(`inbox/y.md -> ${secret}`)
      expect(log).toContain('removed symlinks: ')
      if (!boom) expect(existsSync(join(memory, 'topic', 'x.md'))).toBe(true)
    },
    SLOW,
  )
}

test(
  'eqxi AC1: a link already in the store goes before the first commit; no link means no log line',
  () => {
    seed()
    const secret = join(dir, 'secret')
    writeFileSync(secret, 'zqsecret-eqxi')
    symlinkSync(secret, join(memory, 'inbox', 'pre.md'))
    run(bothFakes({ FACTORY_DREAM_CODEX: 'gpt-6-astra' }))
    expect(gitMemory('log', '-p', '--raw', '--format=')).not.toContain('120000')
    expect(readFileSync(join(home, 'dream.log'), 'utf8')).toContain('inbox/pre.md')
    seed()
    run(bothFakes({ FACTORY_DREAM_CODEX: 'gpt-6-astra' }))
    expect(readFileSync(join(home, 'dream.log'), 'utf8')).not.toContain('removed symlinks')
  },
  SLOW,
)
