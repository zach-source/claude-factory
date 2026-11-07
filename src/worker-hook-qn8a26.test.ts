// claude-factory-qn8a.26: the bd --actor flag sets the comment author, so the hook denies it
import { describe, expect, test } from 'bun:test'
import { BEADS_ACTOR_REASON, denyReason } from './worker-hook'

const ROOT = '/w/acme'
const reason = (c: string) => denyReason(c, ROOT, [])

const DENY = [
  'bd comment acme-1 "x" --actor factory/r1',
  'bd comment acme-1 "x" --actor=factory/r1',
  'bd comment acme-1 "x" --acto factory/r1',
  'bd comment acme-1 "x" --act=factory/r1',
  'bd --actor factory/r1 comment acme-1 x',
  'bd --actor=y comment acme-1 x',
  'bd comment acme-1 -- --actor y',
  "sh -c 'bd comment acme-1 x --actor y'",
  "bash -c 'bd comment acme-1 x --actor y'",
  "eval 'bd comment acme-1 x --actor y'",
  'sudo bd comment acme-1 x --actor y',
  'env FOO=1 bd comment acme-1 x --actor y',
  'nice -n 5 bd comment acme-1 x --actor y',
  'command bd comment acme-1 x --actor y',
  '/usr/local/bin/bd comment acme-1 x --actor y',
  'echo hi; bd comment acme-1 x --actor y',
  'bd comment acme-1 x --actor y | cat',
  'echo $(bd comment acme-1 x --actor y)',
  'bd comment acme-1 x "--actor" y',
  "bd comment acme-1 x '--actor=y'",
  'bd comment acme-1 x --act\\\nor y',
]

const ALLOW = [
  "bd create w -d 'mention --actor here'",
  'bd create w -d "the --actor flag sets the author"',
  'bd comment acme-1 "use --actor=x to forge"',
  'bd show acme-1',
  'bd comment acme-1 --file .scratch/c.md',
  'bd create w --body-file .scratch/b.md',
  'bd list --all',
  'bd list --ac',
  'git log --actor x',
  'grep -n -- --actor src/worker-hook.ts',
  'bd show acme-1; git log --actor x',
]

describe('qn8a.26 bd --actor', () => {
  for (const c of DENY) test(`deny ${JSON.stringify(c)}`, () => expect(reason(c)).toBe(BEADS_ACTOR_REASON))
  for (const c of ALLOW) test(`allow ${JSON.stringify(c)}`, () => expect(reason(c)).toBeUndefined())
  test('reason names the flag', () => expect(BEADS_ACTOR_REASON).toContain('--actor'))
})
