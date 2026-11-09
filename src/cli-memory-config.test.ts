// commitMemory must read the key names of memory/.git/config first and run no hook (claude-factory-96ks).
import { afterAll, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = join(tmpdir(), `cli-memory-config-${process.pid}`)
let n = 0
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** a home with a memory repo and one commit; `commitMemory` runs in a child process on it */
function fixture() {
  const root = join(dir, `t${++n}`)
  const home = join(root, 'home')
  const memory = join(home, 'memory')
  mkdirSync(memory, { recursive: true })
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-C', memory, '-c', 'user.name=p', '-c', 'user.email=p@acme.example', ...a])
      .stdout.toString()
      .trim()
  git('init', '-q')
  writeFileSync(join(memory, 'a.md'), 'a\n')
  git('add', '-A')
  git('commit', '-qm', 'seed')
  const script = join(root, 'drive.ts')
  writeFileSync(
    script,
    `import { commitMemory } from '${join(import.meta.dir, 'cli')}'\nprocess.exit(commitMemory('n') ? 0 : 1)\n`,
  )
  const commit = () => {
    writeFileSync(join(memory, `new${++n}.md`), 'new\n')
    const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
    return Bun.spawnSync(['bun', script, 'noop'], {
      env: {
        ...laptop,
        FACTORY_HOME: home,
        FACTORY_NO_KICK: '1',
        FACTORY_SELF_UPDATE: '0',
        GIT_AUTHOR_NAME: 'p',
        GIT_AUTHOR_EMAIL: 'p@acme.example',
        GIT_COMMITTER_NAME: 'p',
        GIT_COMMITTER_EMAIL: 'p@acme.example',
      },
      stderr: 'pipe',
    })
  }
  const count = () => Number(git('rev-list', '--count', 'HEAD'))
  const log = () => (existsSync(join(home, 'dream.log')) ? readFileSync(join(home, 'dream.log'), 'utf8') : '')
  return { root, memory, commit, count, log, marker: join(root, 'marker') }
}

const LINE = 'memory: repo config not allowed, nothing committed'

test('AC7a 96ks commitMemory commits nothing with a key outside the allow-list', () => {
  for (const row of ['url', 'hooks', 'include', 'filter']) {
    const f = fixture()
    const evil = join(f.root, 'evil.git')
    const inc = join(f.root, 'inc')
    writeFileSync(inc, '[user]\n\tname = zq\n')
    const rows: Record<string, string> = {
      url: `[url "${evil}"]\n\tinsteadOf = zq\n`,
      hooks: `[core]\n\thooksPath = ${f.root}\n`,
      include: `[include]\n\tpath = ${inc}\n`,
      filter: `[filter "zq"]\n\tclean = sh -c 'echo f >> ${f.marker}; cat'\n`,
    }
    appendFileSync(join(f.memory, '.git', 'config'), rows[row]!)
    writeFileSync(join(f.memory, '.gitattributes'), '* filter=zq\n')
    const base = f.count()
    expect([row, f.commit().exitCode]).toEqual([row, 1])
    expect([row, f.count()]).toEqual([row, base])
    expect(f.log()).toContain(LINE)
    expect(existsSync(f.marker)).toBe(false)
  }
})

test('AC7b 96ks commitMemory runs no hook', () => {
  const f = fixture()
  mkdirSync(join(f.memory, '.git', 'hooks'), { recursive: true })
  for (const h of ['pre-commit', 'post-commit']) {
    writeFileSync(join(f.memory, '.git', 'hooks', h), `#!/bin/sh\necho ${h} >> '${f.marker}'\n`)
    chmodSync(join(f.memory, '.git', 'hooks', h), 0o755)
  }
  const base = f.count()
  expect(f.commit().exitCode).toBe(0)
  expect(f.count()).toBe(base + 1)
  expect(existsSync(f.marker)).toBe(false)
})

test('AC7c 96ks commitMemory refuses an empty repo config', () => {
  const f = fixture()
  writeFileSync(join(f.memory, '.git', 'config'), '')
  const base = f.count()
  expect(f.commit().exitCode).toBe(1)
  expect(f.count()).toBe(base)
  expect(f.log()).toContain(LINE)
})
