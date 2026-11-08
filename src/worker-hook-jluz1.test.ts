// claude-factory-jluz.1: a worker must not publish text that matches the private patterns
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { denyReason, privateHitLines } from './worker-hook'

let base: string
let repo: string
let bare: string
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jluz1-')))
  repo = join(base, 'repo')
  bare = join(base, 'bare')
  for (const d of [repo, bare]) {
    mkdirSync(d)
    Bun.spawnSync(['git', 'init', '-q', d])
  }
  mkdirSync(join(repo, '.git', 'info'), { recursive: true })
  writeFileSync(join(repo, '.git', 'info', 'private-patterns'), '# note\n\nsecretcorp\n')
  writeFileSync(join(repo, 'bad.md'), 'ok\nsee SecretCorp here\n')
  writeFileSync(join(repo, 'good.md'), 'all placeholders\n')
})
afterAll(() => rmSync(base, { recursive: true }))

const ask = (cmd: string, cwd = repo) =>
  denyReason(cmd, undefined, undefined, {
    cwd,
    privateHits: t => privateHitLines(t, cwd),
    readFile: p => {
      try {
        return readFileSync(join(cwd, p), 'utf8')
      } catch {
        return undefined
      }
    },
  })

test('privateHitLines: line numbers, no file, no repo', () => {
  expect(privateHitLines('a\nSECRETCORP\nb\nsecretcorp', repo)).toEqual([2, 4])
  expect(privateHitLines('clean', repo)).toEqual([])
  expect(privateHitLines('secretcorp', bare)).toBeUndefined()
  expect(privateHitLines('secretcorp', base)).toBeUndefined()
})

test('a publishing call whose command text matches is denied, with line numbers and no pattern', () => {
  for (const c of [
    'gh pr create --title "fix secretcorp"',
    'gh pr edit 5 --body "secretcorp"',
    'gh pr comment 5 -b "secretcorp"',
    'gh pr review 5 --comment --body "secretcorp"',
    'gh issue create --title x --body "secretcorp"',
    'gh issue comment 5 --body "secretcorp"',
    'gh issue edit 5 --body "secretcorp"',
    'gh api repos/o/r/issues/5/comments -f body="secretcorp"',
    'gh api -X PATCH repos/o/r/pulls/5 -f body="secretcorp"',
    'gh api repos/o/r/pulls/5/reviews -f body="secretcorp" -f event=COMMENT',
  ]) {
    const r = ask(c)
    expect(r).toContain('would publish private names')
    expect(r).toContain('line 1')
    expect(r).not.toContain('secretcorp')
  }
})

test('a body file that matches is denied; a clean one is allowed', () => {
  expect(ask('gh pr create --title t --body-file bad.md')).toContain('bad.md (line 2)')
  expect(ask('gh pr comment 5 -F bad.md')).toContain('bad.md (line 2)')
  expect(ask('gh api repos/o/r/issues/5/comments -F body=@bad.md')).toContain('bad.md (line 2)')
  expect(ask('gh pr create --title t --body-file good.md')).toBeUndefined()
  expect(ask('gh api repos/o/r/issues/5/comments -F body=@good.md')).toBeUndefined()
})

test('a body file that cannot be read fails closed', () => {
  expect(ask('gh pr create --title t --body-file missing.md')).toContain('cannot be read')
  expect(ask('gh pr create --title t --body-file -')).toContain('cannot be read')
})

test('other calls are allowed', () => {
  expect(ask('gh pr view 5 --json title # secretcorp')).toBeUndefined()
  expect(ask('gh api repos/o/r/issues/5/comments')).toBeUndefined()
  expect(ask('gh pr create --title "plain title"')).toBeUndefined()
  expect(ask('echo secretcorp')).toBeUndefined()
})

test('no patterns file: allow', () => {
  expect(ask('gh pr create --title secretcorp', bare)).toBeUndefined()
})
