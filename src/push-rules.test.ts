// claude-factory-jluz.2: a rig's pushRules reach the brief of every station, in order, with {base_branch} filled
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateRig } from './cli'

// cli.ts reads its home at import, so the brief runs in a child process with its own FACTORY_HOME
const SCRIPT = `
import { brief } from ${JSON.stringify(join(import.meta.dir, 'cli'))}
import lifecycle from ${JSON.stringify(join(import.meta.dir, '..', 'factories', 'lifecycle'))}
const c = { seq: 1, attempt: 1, pane: null, session: null, resumes: 0, startedAt: 0, nudgedAt: 0, nudges: 0, retryAt: 0, budget: 10, wakeAt: 0, error: null, mail: {}, seen: {}, log: [] }
const run = { id: 'r1', factory: 'lifecycle', repo: process.env.REPO, goal: 'g', ws: 'ws', worktree: '/nonexistent/wt', branch: 'b' }
console.log(JSON.stringify(['implement', 'verify', 'review'].map(n => brief(run, lifecycle, n, c, []))))
`

test('pushRules render as "Before each push" in every station, numbered, with {base_branch} filled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jluz2-'))
  try {
    const repo = '/nonexistent/acme-blocks'
    const rules = ['First: run git fetch origin {base_branch}.', 'Second: compare with origin/{base_branch}.']
    writeFileSync(
      join(dir, 'rigs.json'),
      JSON.stringify([
        {
          name: 'acme-blocks',
          repo,
          factory: 'lifecycle',
          pushRules: rules,
          params: { base_branch: 'trunk' },
        },
      ]),
    )
    const { FACTORY_OUTBOX, FACTORY_FROM, ...env } = process.env
    const p = Bun.spawnSync([process.execPath, '-e', SCRIPT], {
      env: { ...env, FACTORY_HOME: dir, FACTORY_SELF_UPDATE: '0', REPO: repo },
    })
    expect(p.exitCode, p.stderr.toString()).toBe(0)
    for (const text of JSON.parse(p.stdout.toString()) as string[]) {
      const at = text.indexOf('## Before each push')
      expect(at).toBeGreaterThan(-1)
      const one = text.indexOf('1. First: run git fetch origin trunk.', at)
      const two = text.indexOf('2. Second: compare with origin/trunk.', at)
      expect(one).toBeGreaterThan(at)
      expect(two).toBeGreaterThan(one)
      expect(text).not.toContain('origin/{base_branch}.')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateRig accepts a list of strings and refuses anything else', () => {
  const rig = { name: 'a', repo: '/r', factory: 'lifecycle' }
  expect(() => validateRig({ ...rig, pushRules: ['ok'] })).not.toThrow()
  expect(() => validateRig({ ...rig, pushRules: [] })).not.toThrow()
  expect(() => validateRig({ ...rig, pushRules: 'x' as never })).toThrow('pushRules')
  expect(() => validateRig({ ...rig, pushRules: [' '] })).toThrow('pushRules')
})
