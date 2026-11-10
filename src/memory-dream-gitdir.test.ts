// An agent pass in the memory must not make the factory run a command through .git/config, hooks or a nested
// repo (claude-factory-f1zc). dream() records the control area of memory/.git before the pass, puts it back
// after, removes any nested .git and commits nothing; when the restore fails it fences the memory.
import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-dream-gitdir-${process.pid}`)
const home = join(dir, 'home')
const memory = join(home, 'memory')
const marks = join(dir, 'marks')
const MARKER = join(dir, 'MARKER')
const SCRIPT = join(dir, 'mark.sh')
const gitLog = join(dir, 'git.log')
const CHANGED = 'dream: .git changed in the pass, nothing committed'
const FAILED = 'dream: .git changed in the pass, restore failed, git fenced, nothing committed'

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (env: Record<string, string> = {}, args: string[] = ['dream']) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_DREAM_CODEX, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', FACTORY_NO_KICK: '1', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}
const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(['git', '-C', cwd, '-c', 'user.name=p', '-c', 'user.email=p@acme.example', ...args])
    .stdout.toString()
    .trim()
const gitMemory = (...args: string[]) => sh(memory, ...args)
const dreamLog = () =>
  existsSync(join(home, 'dream.log')) ? readFileSync(join(home, 'dream.log'), 'utf8') : ''
const dreamCommits = () => gitMemory('log', '--all', '--grep=^dream:', '--format=%H')
const cfg = () => readFileSync(join(memory, '.git', 'config'), 'utf8')

function fake(body: string[], name = 'fake-claude.sh') {
  const file = join(dir, name)
  writeFileSync(
    file,
    ['#!/bin/sh', `printf x > "${marks}/ran"`, 'cat > /dev/null', ...body, 'echo done', ''].join('\n'),
  )
  chmodSync(file, 0o755)
  return file
}

function seed(extra: () => void = () => {}) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(memory, 'inbox'), { recursive: true })
  mkdirSync(marks, { recursive: true })
  writeFileSync(SCRIPT, `#!/bin/sh\ntouch '${MARKER}'\n`)
  chmodSync(SCRIPT, 0o755)
  writeFileSync(
    join(memory, 'inbox', 'x.md'),
    '---\nsummary: a fixture note waiting to be filed\n---\nbody text\n',
  )
  writeFileSync(
    join(memory, '.usage.jsonl'),
    `${JSON.stringify({ path: 'inbox/x.md', shown: 1, at: Date.now() - 1000 })}\n`,
  )
  expect(Bun.spawnSync(['git', '-C', memory, 'init', '-q']).exitCode).toBe(0)
  extra()
  gitMemory('add', '-A')
  gitMemory('commit', '-qm', 'seed')
  writeFileSync(join(memory, 'inbox', 'y.md'), '---\nsummary: a second fixture note\n---\nmore text\n')
}

const FSMON = `printf '[core]\\n\\tfsmonitor = ${SCRIPT}\\n' >> .git/config`
/** the pass of claude-factory-f1zc P2: a nested repo made of text files only */
const nested = (at = 'sub', fileName = '.git') => [
  `mkdir -p ${at}/g/objects/info ${at}/g/refs/heads`,
  `printf 'gitdir: ./g\\n' > ${at}/${fileName}`,
  `printf '%s\\n' "${memory}/.git/objects" > ${at}/g/objects/info/alternates`,
  `git rev-parse HEAD > ${at}/g/HEAD`,
  `printf '[core]\\n\\trepositoryformatversion = 0\\n\\tfsmonitor = ${SCRIPT}\\n' > ${at}/g/config`,
  `echo hi > ${at}/f.md`,
]

/** run a dream whose pass is `body`; the shared checks of a guarded pass */
function guarded(body: string[], codex = false) {
  seed()
  const before = cfg()
  const env: Record<string, string> = codex
    ? {
        FACTORY_DREAM_CODEX: 'acme-model',
        FACTORY_CODEX: fake(body, 'fake-codex.sh'),
        CODEX_HOME: join(dir, 'ch'),
      }
    : {}
  const r = run({ FACTORY_CLAUDE: fake(body), ...env })
  expect(r.code, r.err + r.out).toBe(0)
  expect(existsSync(MARKER)).toBe(false)
  expect(cfg()).toBe(before)
  expect(dreamCommits()).toBe('')
  expect(dreamLog()).toContain(CHANGED)
  expect(existsSync(join(home, 'memory.fenced'))).toBe(false)
}

test('AC1 a pass that sets core.fsmonitor in .git/config is undone and commits nothing', () => {
  guarded([FSMON])
})

test('AC1a core.hooksPath to a hook that runs a command', () => {
  guarded([
    `mkdir -p "${dir}/hp"`,
    `printf '#!/bin/sh\\ntouch "${MARKER}"\\n' > "${dir}/hp/post-commit"`,
    `chmod 755 "${dir}/hp/post-commit"`,
    `printf '[core]\\n\\thooksPath = ${dir}/hp\\n' >> .git/config`,
  ])
})

test('AC1b new hooks in .git/hooks are removed', () => {
  seed()
  const hooks = () => readdirSync(join(memory, '.git', 'hooks')).sort()
  const before = hooks()
  const hook = `printf '#!/bin/sh\\ntouch "${MARKER}"\\n' > .git/hooks/NAME; chmod 755 .git/hooks/NAME`
  const claude = fake([hook.replaceAll('NAME', 'pre-commit'), hook.replaceAll('NAME', 'post-commit')])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(hooks()).toEqual(before)
  expect(existsSync(MARKER)).toBe(false)
  expect(dreamCommits()).toBe('')
  expect(dreamLog()).toContain(CHANGED)
})

test('AC1c a textconv driver and an attributes file are undone', () => {
  seed()
  const attrs = join(memory, '.git', 'info', 'attributes')
  const before = existsSync(attrs) ? readFileSync(attrs, 'utf8') : undefined
  const cfgBefore = cfg()
  const claude = fake([
    `printf '[diff "x"]\\n\\ttextconv = ${SCRIPT}\\n' >> .git/config`,
    `mkdir -p .git/info; printf '*.md diff=x\\n' >> .git/info/attributes`,
  ])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(cfg()).toBe(cfgBefore)
  expect(existsSync(attrs) ? readFileSync(attrs, 'utf8') : undefined).toBe(before)
  expect(existsSync(MARKER)).toBe(false)
  expect(dreamLog()).toContain(CHANGED)
})

test('AC1d an include path in .git/config is undone', () => {
  guarded([
    `printf '[core]\\n\\tfsmonitor = ${SCRIPT}\\n' > inbox/evil.cfg`,
    `printf '[include]\\n\\tpath = ../inbox/evil.cfg\\n' >> .git/config`,
  ])
})

test('AC1e a rewound branch ref and a config write give both journal lines', () => {
  guarded([
    'b=$(git symbolic-ref --short HEAD)',
    'printf "%s\\n" "$(git rev-parse HEAD~1)" > ".git/refs/heads/$b"',
    FSMON,
  ])
  expect(dreamLog()).toContain('dream: HEAD moved in the pass, nothing committed')
  expect(gitMemory('rev-list', '--count', 'HEAD')).toBe('2')
})

const noGitlink = () => expect(gitMemory('ls-files', '-s', 'sub')).not.toContain('160000')

test('AC2 a nested repo made of text files is removed and never runs', () => {
  guarded(nested())
  expect(existsSync(join(memory, 'sub', '.git'))).toBe(false)
  noGitlink()
})

test('AC2a an upper case .GIT gitdir file is removed too', () => {
  guarded(nested('sub', '.GIT'))
  expect(existsSync(join(memory, 'sub', '.GIT'))).toBe(false)
  noGitlink()
})

test('AC2b a .git symlink to a repo outside the memory is removed, the target stays', () => {
  const out = join(dir, 'outside')
  seed()
  const claude = fake([
    `mkdir -p "${out}/g/objects/info" "${out}/g/refs/heads"`,
    `printf '%s\\n' "${memory}/.git/objects" > "${out}/g/objects/info/alternates"`,
    `git rev-parse HEAD > "${out}/g/HEAD"`,
    `printf '[core]\\n\\trepositoryformatversion = 0\\n\\tfsmonitor = ${SCRIPT}\\n' > "${out}/g/config"`,
    `mkdir sub; ln -s "${out}/g" sub/.git`,
  ])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(existsSync(join(memory, 'sub', '.git'))).toBe(false)
  expect(existsSync(join(out, 'g', 'config'))).toBe(true)
  expect(existsSync(MARKER)).toBe(false)
  expect(dreamLog()).toContain(CHANGED)
})

test('AC2c the codex pass is guarded too', () => {
  guarded(nested(), true)
  expect(existsSync(join(memory, 'sub', '.git'))).toBe(false)
})

test('AC2d a nested repo in an unreadable tree is removed and the sweep goes on', () => {
  guarded([...nested('a/sub'), 'mkdir -m 000 b', 'chmod 0555 a'])
  chmodSync(join(memory, 'a'), 0o755)
  expect(existsSync(join(memory, 'a', 'sub', '.git'))).toBe(false)
})

test('AC2e a nested repo from before the pass refuses the dream and stays', () => {
  seed()
  expect(Bun.spawnSync(['git', 'init', '-q', join(memory, 'sub')]).exitCode).toBe(0)
  writeFileSync(join(memory, 'sub', '.git', 'config'), `[core]\n\tfsmonitor = ${SCRIPT}\n`)
  run({ FACTORY_CLAUDE: fake([]) })
  expect(dreamLog()).toContain('dream: a nested .git is in the memory, dream refused')
  expect(existsSync(join(marks, 'ran'))).toBe(false)
  expect(existsSync(join(memory, 'sub', '.git'))).toBe(true)
  expect(existsSync(MARKER)).toBe(false)
})

test('AC3 a .git that becomes a file fences the memory and no git runs again', () => {
  seed(() => {
    mkdirSync(join(memory, 'topics'))
    writeFileSync(join(memory, 'topics', 'old.md'), '---\nsummary: an old note\n---\nold\n')
  })
  const shim = join(dir, 'shim')
  mkdirSync(shim, { recursive: true })
  writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$*" >> '${gitLog}'\nexec '${Bun.which('git')}' "$@"\n`)
  chmodSync(join(shim, 'git'), 0o755)
  const env = { PATH: `${shim}:${process.env.PATH}` }
  const claude = fake([
    'mv .git .g',
    `printf 'gitdir: .g\\n' > .git`,
    `printf '[core]\\n\\tfsmonitor = ${SCRIPT}\\n' >> .g/config`,
    `echo PASS-END >> '${gitLog}'`,
  ])
  expect(run({ FACTORY_CLAUDE: claude, ...env }).code).toBe(0)
  expect(dreamLog()).toContain(FAILED)
  expect(dreamLog()).not.toContain(CHANGED + '\n')
  expect(existsSync(join(home, 'memory.fenced'))).toBe(true)
  const lines = readFileSync(gitLog, 'utf8').split('\n')
  expect(lines.slice(lines.indexOf('PASS-END') + 1).filter(l => l.includes(memory))).toEqual([])
  expect(gitMemory('log', '--all', '--grep=^dream:', '--format=%H')).toBe('')
  const n = readFileSync(gitLog, 'utf8').length
  run({ FACTORY_CLAUDE: claude, ...env })
  run(env, ['memory', 'compact'])
  expect(readFileSync(gitLog, 'utf8').slice(n)).not.toContain(memory)
  expect(existsSync(MARKER)).toBe(false)
})

test('AC4a ordinary git work in the pass is allowed', () => {
  seed()
  const claude = fake([
    'echo more >> inbox/y.md',
    'git rm --cached -q inbox/x.md',
    'git hash-object -w inbox/y.md > /dev/null',
    'touch .git/acme.lock .git/objects/acme.lock .git/gc.log',
  ])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(dreamLog()).not.toContain('.git changed')
  expect(dreamCommits()).not.toBe('')
})

test('AC4b names that only look like .git are not nested repos', () => {
  seed(() => {
    for (const f of ['git', '.gitx', 'x.git']) writeFileSync(join(memory, f), 'x')
    mkdirSync(join(memory, '.github'))
  })
  expect(run({ FACTORY_CLAUDE: fake([]) }).code).toBe(0)
  expect(dreamLog()).not.toContain('.git changed')
  expect(dreamLog()).not.toContain('refused')
  expect(dreamCommits()).not.toBe('')
  for (const f of ['git', '.gitx', 'x.git', '.github', '.gitignore'])
    expect(existsSync(join(memory, f))).toBe(true)
})

test('AC4 a special file in .git refuses the pass', () => {
  seed()
  Bun.spawnSync(['mkfifo', join(memory, '.git', 'info', 'x')])
  run({ FACTORY_CLAUDE: fake([]) })
  expect(dreamLog()).toContain('dream: .git holds a special file, dream refused')
  expect(existsSync(join(marks, 'ran'))).toBe(false)
})

test('AC4 a symlink in .git is restored like any control entry', () => {
  seed()
  symlinkSync('config', join(memory, '.git', 'cfglink'))
  const claude = fake([`rm .git/cfglink`])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(dreamLog()).toContain(CHANGED)
})
