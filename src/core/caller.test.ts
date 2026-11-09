import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insideWorktree, managerSender } from './caller'

const root = mkdtempSync(join(tmpdir(), 'caller-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const wt = join(root, 'wt')
const other = join(root, 'wt-other')
const link = join(root, 'link')
const repo = join(root, 'repo')
for (const d of [join(wt, 'sub'), other, repo]) mkdirSync(d, { recursive: true })
symlinkSync(wt, link)
const run = { worktree: wt, repo }

describe('managerSender', () => {
  for (const env of [{ FACTORY_DEF_NAME: 'x' }, { BEADS_ACTOR: 'factory/x' }])
    test(`refuses ${JSON.stringify(env)}`, () => {
      expect(() => managerSender(env, other, run)).toThrow(
        /^a worker cannot send mail as the manager \(.*\); a worker mails as its own station$/,
      )
    })
  for (const env of [{}, { FACTORY_FROM: 'x' }, { FACTORY_RUN: 'x' }, { BEADS_ACTOR: 'person' }])
    test(`allows ${JSON.stringify(env)} outside the worktree`, () => {
      expect(managerSender(env, other, run)).toBe('manager')
    })
  for (const [name, cwd] of [
    ['the worktree', wt],
    ['a folder under the worktree', join(wt, 'sub')],
    ['a link to the worktree', link],
  ] as const)
    test(`refuses a cwd that is ${name}`, () => {
      expect(() => managerSender({}, cwd, run)).toThrow('the working directory is inside the run worktree')
    })
  test('allows a sibling that shares the prefix', () => {
    expect(managerSender({}, other, run)).toBe('manager')
  })
  test('allows a run whose worktree is its repo, and a run with no worktree', () => {
    expect(managerSender({}, repo, { worktree: repo, repo })).toBe('manager')
    expect(managerSender({}, wt, { repo })).toBe('manager')
  })
})

describe('insideWorktree', () => {
  test('is false for a cwd that does not resolve, and for an empty cwd', () => {
    expect(insideWorktree(run, join(root, 'missing'))).toBe(false)
    expect(insideWorktree(run, '')).toBe(false)
  })
})
