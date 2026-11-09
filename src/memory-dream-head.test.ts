// The dream must not trust a HEAD that its agent pass can move (claude-factory-muq1). A pass in the memory
// can write memory/.git/refs and memory/.git/HEAD. dream() records the branch ref and sha before the pass,
// puts a rewind back after it and commits nothing.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `memory-dream-head-${process.pid}`)
const home = join(dir, 'home')
const memory = join(home, 'memory')
const marks = join(dir, 'marks')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_DREAM_CODEX, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, 'dream'], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env },
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
const MOVED = 'dream: HEAD moved in the pass, nothing committed'

/** a fake `claude -p` that runs `body` in the memory, after it marks that it ran */
function fake(body: string[]) {
  const file = join(dir, 'fake-claude.sh')
  writeFileSync(
    file,
    ['#!/bin/sh', `printf x > "${marks}/ran"`, 'cat > /dev/null', ...body, 'echo done', ''].join('\n'),
  )
  chmodSync(file, 0o755)
  return file
}

/** a memory repo with a seed commit and a second note, so the dream makes its own notes commit first */
function seed(opts: { homeRepo?: boolean } = {}) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(memory, 'inbox'), { recursive: true })
  mkdirSync(marks, { recursive: true })
  writeFileSync(
    join(memory, 'inbox', 'x.md'),
    '---\nsummary: a fixture note waiting to be filed\n---\nbody text\n',
  )
  writeFileSync(
    join(memory, '.usage.jsonl'),
    `${JSON.stringify({ path: 'inbox/x.md', shown: 1, at: Date.now() - 1000 })}\n`,
  )
  expect(Bun.spawnSync(['git', '-C', memory, 'init', '-q']).exitCode).toBe(0)
  gitMemory('add', '-A')
  gitMemory('commit', '-qm', 'seed')
  writeFileSync(join(memory, 'inbox', 'y.md'), '---\nsummary: a second fixture note\n---\nmore text\n')
  if (opts.homeRepo) {
    sh(home, 'init', '-q')
    writeFileSync(join(home, 'f'), 'x')
    sh(home, 'add', 'f')
    sh(home, 'commit', '-qm', 'home')
  }
}
const REWIND = [
  'b=$(git symbolic-ref --short HEAD)',
  'printf "%s\\n" "$(git rev-parse HEAD~1)" > ".git/refs/heads/$b"',
]

test('AC4 a pass that rewinds the branch ref is put back and commits nothing', () => {
  seed()
  const claude = fake(REWIND)
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(gitMemory('rev-list', '--count', 'HEAD')).toBe('2')
  expect(dreamCommits()).toBe('')
  expect(dreamLog()).toContain(MOVED)
})

test('AC4 a pass that moves HEAD to another branch is put back', () => {
  seed()
  const claude = fake([
    'printf "%s\\n" "$(git rev-parse HEAD)" > .git/refs/heads/other',
    'printf "ref: refs/heads/other\\n" > .git/HEAD',
  ])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(gitMemory('symbolic-ref', 'HEAD')).not.toBe('refs/heads/other')
  expect(gitMemory('rev-list', '--count', 'HEAD')).toBe('2')
  expect(dreamCommits()).toBe('')
  expect(dreamLog()).toContain(MOVED)
})

test('AC4 a commit made during the pass stays and the dream commits nothing', () => {
  seed()
  const claude = fake([
    'echo later > later.md',
    'git add later.md',
    'git -c user.name=m -c user.email=m@acme.example commit -qm later',
  ])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(gitMemory('log', '-1', '--format=%s')).toBe('later')
  expect(dreamCommits()).toBe('')
  expect(dreamLog()).toContain(MOVED)
})

test('AC4 when the restore fails, only the restore failed line is written', () => {
  seed()
  const claude = fake(REWIND)
  const shim = join(dir, 'shim')
  mkdirSync(shim, { recursive: true })
  writeFileSync(
    join(shim, 'git'),
    `#!/bin/sh\ncase "$*" in *update-ref*) exit 1;; esac\nexec '${Bun.which('git')}' "$@"\n`,
  )
  chmodSync(join(shim, 'git'), 0o755)
  expect(run({ FACTORY_CLAUDE: claude, PATH: `${shim}:${process.env.PATH}` }).code).toBe(0)
  expect(dreamLog()).toContain('dream: HEAD moved in the pass, restore failed, nothing committed')
  expect(dreamLog()).not.toContain(MOVED)
  expect(dreamCommits()).toBe('')
})

test('AC4 a detached HEAD refuses the dream before the pass runs', () => {
  seed()
  gitMemory('checkout', '-q', '--detach')
  const claude = fake([])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(dreamLog()).toContain('dream: no branch head, dream refused')
  expect(existsSync(join(marks, 'ran'))).toBe(false)
})

test('AC4 a garbage .git/HEAD fails the restore and never touches a repo in a parent', () => {
  seed({ homeRepo: true })
  const before = sh(home, 'rev-parse', 'HEAD')
  const claude = fake(['printf "garbage\\n" > .git/HEAD'])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(dreamLog()).toContain('dream: HEAD moved in the pass, restore failed, nothing committed')
  expect(dreamLog()).not.toContain(MOVED)
  expect(sh(home, 'rev-parse', 'HEAD')).toBe(before)
})

test('AC4 proposals over the cap are dropped when the dream is refused', () => {
  seed()
  const claude = fake([
    ...REWIND,
    'mkdir -p .proposals',
    'for n in 1 2 3 4; do printf -- "---\\nrung: core\\ntarget: CORE.md\\nstatus: pending\\n---\\nline $n\\n" > .proposals/p$n.md; done',
  ])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(dreamLog()).toContain(MOVED)
  expect(dreamLog()).toContain('dropped proposals over the cap: p4')
  expect(existsSync(join(memory, '.proposals', 'p3.md'))).toBe(true)
  expect(existsSync(join(memory, '.proposals', 'p4.md'))).toBe(false)
})

test('AC7d 96ks a dream whose agent pass writes the memory repo config commits nothing', () => {
  seed()
  const marker = join(dir, 'filter-marker')
  const claude = fake([
    `git rev-parse HEAD > "${dir}/before"`,
    'echo new > inbox/z.md',
    "echo '* filter=zq' > .gitattributes",
    `printf '[filter "zq"]\\n\\tclean = sh -c "echo f >> ${marker}; cat"\\n' >> .git/config`,
  ])
  expect(run({ FACTORY_CLAUDE: claude }).code).toBe(0)
  expect(gitMemory('rev-parse', 'HEAD')).toBe(readFileSync(join(dir, 'before'), 'utf8').trim())
  expect(dreamLog()).toContain('memory: repo config not allowed, nothing committed')
  expect(dreamCommits()).toBe('')
  expect(existsSync(marker)).toBe(false)
})
