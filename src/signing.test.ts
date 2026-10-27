// signingProbe() signs an empty commit the way `git commit` would, to see if the signer is up.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signingProbe } from './signing'

let dir = ''
let repo = ''
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null' // the host's own commit.gpgsign must not leak in
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  dir = mkdtempSync(join(tmpdir(), 'signing-test-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  Bun.spawnSync(['git', '-C', repo, 'init', '-q'])
  Bun.spawnSync(['git', '-C', repo, 'config', 'user.name', 't'])
  Bun.spawnSync(['git', '-C', repo, 'config', 'user.email', 't@t'])
})
afterEach(() => {
  delete process.env.GIT_CONFIG_GLOBAL
  delete process.env.GIT_CONFIG_SYSTEM
  rmSync(dir, { recursive: true, force: true })
})

const cfg = (k: string, v: string) => Bun.spawnSync(['git', '-C', repo, 'config', k, v])
const objects = () => Bun.spawnSync(['git', '-C', repo, 'count-objects']).stdout.toString()
const probeDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith('factory-sign-'))
function key() {
  const k = join(dir, 'key')
  Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', k])
  return k
}
function program(body: string) {
  const p = join(dir, 'signer')
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
function signing(prog: string, gpgsign = 'true') {
  cfg('commit.gpgsign', gpgsign)
  cfg('gpg.format', 'ssh')
  cfg('user.signingkey', join(dir, 'key.pub'))
  cfg('gpg.ssh.program', prog)
}

test('a working signer gives ok', () => {
  key()
  signing('ssh-keygen')
  const before = probeDirs().length
  const objs = objects()
  expect(signingProbe(repo)).toEqual({ ok: true })
  expect(objects()).toBe(objs)
  expect(probeDirs()).toHaveLength(before)
})

test('a signer that refuses gives ok:false with its message', () => {
  key()
  signing(program('echo "agent refused" >&2; exit 1'))
  const r = signingProbe(repo)
  expect(r.ok).toBe(false)
  expect(!r.ok && r.error).toContain('agent refused')
})

test('a signer that hangs times out', () => {
  key()
  signing(program('sleep 30'))
  const t = Date.now()
  const r = signingProbe(repo, 500)
  expect(r.ok).toBe(false)
  expect(!r.ok && r.error).toContain('timed out')
  expect(Date.now() - t).toBeLessThan(5000)
})

test('no signer runs when commit.gpgsign is false or unset', () => {
  const marker = join(dir, 'marker')
  signing(program(`touch ${marker}; exit 1`), 'false')
  expect(signingProbe(repo)).toEqual({ ok: true })
  Bun.spawnSync(['git', '-C', repo, 'config', '--unset', 'commit.gpgsign'])
  expect(signingProbe(repo)).toEqual({ ok: true })
  expect(existsSync(marker)).toBe(false)
})
