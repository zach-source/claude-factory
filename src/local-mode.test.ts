// Local mode stays as it is (spec 010 FR-017, user story 6): a laptop home with no FACTORY_SERVER_MODE.
// The CLI runs against the home and `factory ui` serves it, with no pod.
import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const dir = mkdtempSync(join(tmpdir(), 'local-mode-'))
const home = join(dir, 'home')
const repo = join(dir, 'repo')
mkdirSync(join(repo, '.beads'), { recursive: true })
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'rigs.json'), JSON.stringify([{ name: 'laptop', repo }]))
// no server mode and no AX mode: the laptop paths decide
const { FACTORY_SERVER_MODE, FACTORY_IN_AX, FACTORY_SERVER, ...rest } = process.env
void [FACTORY_SERVER_MODE, FACTORY_IN_AX, FACTORY_SERVER]
// ponytail: a stub bd that lists no issues; the CI runner has no bd, and ui needs one on PATH
const bin = join(dir, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'bd'), '#!/bin/sh\necho "[]"\n')
chmodSync(join(bin, 'bd'), 0o755)
const env = { ...rest, PATH: `${bin}:${rest.PATH}`, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0' }

test('gogxc.26: the CLI reads a laptop home with no server mode', () => {
  const r = Bun.spawnSync(['bun', join(root, 'src/cli.ts'), 'rig', 'show', 'laptop'], {
    cwd: root,
    env,
    timeout: 25_000,
  })
  expect(r.exitCode).toBe(0)
  expect(r.stdout.toString()).toContain('laptop')
})

test('gogxc.26: factory ui serves the laptop home', async () => {
  const p = Bun.spawn(['bun', join(root, 'src/cli.ts'), 'ui', '--port', '0', '--no-sync'], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  try {
    const line = await new Promise<string>(res => {
      let out = ''
      const rd = p.stdout.getReader()
      const pump = (): Promise<void> =>
        rd.read().then(({ done, value }) => {
          out += new TextDecoder().decode(value)
          if (done || out.includes('\n')) return void res(out)
          return pump()
        })
      void pump()
    })
    const port = line.match(/127\.0\.0\.1:(\d+)/)?.[1]
    expect(port).toBeDefined()
    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(page.status).toBe(200)
    const api = (await (await fetch(`http://127.0.0.1:${port}/api/rigs`)).json()) as {
      rigs: { name: string }[]
    }
    expect(api.rigs.map(r => r.name)).toEqual(['laptop'])
  } finally {
    p.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
