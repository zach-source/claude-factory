// claude-factory-3u1.3.2 (FR-019..021) through bin/factory: list, install and reject the dream's proposals.
// A rung above core files a bead (a fake bd here) and never touches factory code.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proposalMailText } from './memory'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `proposals-cli-${process.pid}`)
const home = join(dir, 'home')
const mem = join(home, 'memory')
const bin = join(dir, 'bin')
const bdLog = join(dir, 'bd.log')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (args: string[]) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', PATH: `${bin}:${laptop.PATH}` },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}
const proposal = (rung: string, change: string) =>
  `---\nrung: ${rung}\ntarget: ${rung === 'core' ? 'CORE.md' : 'station:verify'}\nstatus: pending\nevidence: ["r1","r2","r3"]\n---\n${change}\n`

test('factory proposals: list, install core, install a higher rung as a bead, reject with a reason', () => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(mem, '.proposals'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'repo'), { recursive: true })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'self', repo: join(dir, 'repo') }]))
  writeFileSync(join(bin, 'bd'), `#!/bin/sh\necho "$@" >> ${bdLog}\necho acme-x1\n`)
  chmodSync(join(bin, 'bd'), 0o755)
  Bun.spawnSync(['git', 'init', '-q', mem])
  writeFileSync(join(mem, 'CORE.md'), '- an old line\n')
  writeFileSync(join(mem, '.proposals', 'a.md'), proposal('core', 'Run prettier before a PR.'))
  writeFileSync(join(mem, '.proposals', 'b.md'), proposal('instruction', 'Lint before the tests.'))
  writeFileSync(join(mem, '.proposals', 'c.md'), proposal('core', 'Always push twice.'))

  const list = run(['proposals'])
  expect(list.code).toBe(0)
  expect(list.out).toContain('b  instruction  station:verify: Lint before the tests.')

  expect(run(['proposals', 'install', 'a']).code).toBe(0)
  expect(readFileSync(join(mem, 'CORE.md'), 'utf8')).toBe('- an old line\n- Run prettier before a PR.\n')
  expect(Bun.spawnSync(['git', '-C', mem, 'log', '--format=%s']).stdout.toString()).toContain('proposal a')

  const noRig = run(['proposals', 'install', 'b'])
  expect(noRig.code).not.toBe(0)
  expect(noRig.err).toContain('--rig')
  const bead = run(['proposals', 'install', 'b', '--rig', 'self'])
  expect(bead.code).toBe(0)
  expect(bead.out).toContain('acme-x1')
  expect(readFileSync(bdLog, 'utf8')).toContain('create')
  expect(readFileSync(bdLog, 'utf8')).toContain('-l human')
  expect(readFileSync(join(mem, '.proposals', 'b.md'), 'utf8')).toContain('bead: acme-x1')
  expect(readdirSync(join(dir, 'repo'))).toEqual([]) // no factory or repo file changed

  expect(run(['proposals', 'reject', 'c']).code).not.toBe(0) // a reason is required
  expect(run(['proposals', 'reject', 'c', 'pushing', 'twice', 'does', 'nothing']).code).toBe(0)
  expect(readFileSync(join(mem, '.proposals', 'c.md'), 'utf8')).toContain('status: rejected')
  expect(existsSync(join(mem, 'inbox'))).toBe(true)
  expect(run(['proposals']).out).toBe('no pending proposals')
}, 60_000)

test('proposalMailText lists each pending proposal with the install and reject commands', () => {
  const text = proposalMailText(
    [
      {
        name: 'a',
        rung: 'core',
        target: 'CORE.md',
        status: 'pending',
        change: 'x',
        file: '/m/.proposals/a.md',
      },
    ],
    'factory',
  )
  expect(text).toContain('factory proposals install <name>')
  expect(text).toContain('factory proposals reject <name> <why>')
  expect(text).toContain('- a (rung core, CORE.md): x (/m/.proposals/a.md)')
})
