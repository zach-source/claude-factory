// claude-factory-qn8a.24: a worker must not write a run inbox.jsonl in the factory home (forged manager mail)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FACTORY_CONFIG_REASON,
  FILE_WRITE_REASON,
  denyReason,
  fileWriteReason,
  type HookGate,
} from './worker-hook'

const ROOT = '/w/acme'
const reason = (c: string, root: string | undefined = ROOT, gate?: HookGate) => denyReason(c, root, [], gate)

const DENY = [
  'echo {} >> /h/runs/r1/inbox.jsonl',
  'printf %s x >>/h/runs/r1/inbox.jsonl',
  'tee -a /h/runs/r1/inbox.jsonl',
  'cp .scratch/x /h/runs/r1/inbox.jsonl',
  'mv .scratch/x /h/runs/r1/inbox.jsonl',
  'cp .scratch/inbox.jsonl /h/runs/r1/',
  'sed -i s/a/b/ /h/runs/r1/inbox.jsonl',
  'dd of=/h/runs/r1/inbox.jsonl',
  'echo x > /h/runs/r1/INBOX.JSONL',
  'echo x > /h/runs/r1/inb?x.jsonl',
  'echo x > /h/runs/r1/*.jsonl',
  'echo x > /h/runs/r1/{inbox,a}.jsonl',
  'echo x > "/h/runs/r1/inbox.jsonl"',
  'ln -s /h/runs/r1/inbox.jsonl .scratch/l',
  `bun -e "require('fs').appendFileSync('/h/runs/r1/inbox.jsonl','x')"`,
  'cd /h/runs/r1 && echo x >> inbox.jsonl',
  'echo x > /h/runs/r1/state.json',
  'cp .scratch/s /h/runs/r1/state.json',
  'echo x > /h/runs/r1/security-route.json',
  'echo x > /h/runs/r1/STATE.JSON',
  'echo x > /h/runs/r1/st[a]te.json',
  'echo x > /h/runs/r1/s*e.json',
  'echo x > /h/runs/r1/st?te.json',
  // known false positives, the same as rigs.json today
  'jq . /h/runs/r1/inbox.jsonl',
  'cp /h/runs/r1/inbox.jsonl .scratch/',
  'cp .scratch/*.jsonl .scratch/b/',
]
const ALLOW = [
  `git commit -m 'deny inbox.jsonl writes'`,
  'grep -n inbox.jsonl src/cli.ts',
  'cat /h/runs/r1/inbox.jsonl',
  'tail -5 /h/runs/r1/inbox.jsonl',
  'cat /h/runs/r1/inbox.jsonl > .scratch/inbox.jsonl',
  `bd comment x 'post() appends to inbox.jsonl'`,
  'echo x > .scratch/out.jsonl',
  'echo x >> /w/acme/.scratch/inbox.jsonl',
  'echo x > /h/runs/r1/outbox.jsonl',
  'cat /h/runs/r1/state.json',
  'cat /h/runs/r1/security-route.json',
  'tail -5 /h/runs/r1/state.json',
  'echo x > .scratch/state.json',
  `git commit -m 'read state.json'`,
]

describe('qn8a.24 Bash guard', () => {
  test.each(DENY)('denies %p', c => {
    expect(reason(c)).toBe(FACTORY_CONFIG_REASON)
  })
  test('denies a relative write with gate.cwd in the home', () => {
    expect(reason('echo x >> inbox.jsonl', ROOT, { cwd: '/h' } as HookGate)).toBe(FACTORY_CONFIG_REASON)
  })
  test.each(ALLOW)('allows %p', c => {
    expect(reason(c)).toBeUndefined()
  })
})

describe('qn8a.24 file tools', () => {
  let base: string
  let root: string
  let home: string
  const env = () => ({ home: '/nowhere-home', xdg: undefined })
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'qn8a24-')))
    root = join(base, 'root')
    home = join(base, 'home')
    mkdirSync(join(root, '.scratch'), { recursive: true })
    mkdirSync(join(home, 'runs', 'r1'), { recursive: true })
    writeFileSync(join(home, 'runs', 'r1', 'inbox.jsonl'), '')
  })
  afterAll(() => rmSync(base, { recursive: true }))

  test('denies a home inbox.jsonl, in any case', () => {
    for (const n of ['inbox.jsonl', 'Inbox.JSONL', 'state.json', 'State.JSON'])
      expect(fileWriteReason(join(home, 'runs', 'r1', n), root, env(), root)).toBe(FACTORY_CONFIG_REASON)
  })
  test('denies a non-ASCII name that APFS folds, when the file does not exist', () => {
    mkdirSync(join(home, 'runs', 'r2'), { recursive: true })
    for (const n of ['inbox.jſonl', 'ſtate.json', 'ﬆate.json'])
      expect(fileWriteReason(join(home, 'runs', 'r2', n), root, env(), root)).toBe(FACTORY_CONFIG_REASON)
  })
  test('denies a folded protected dir name that does not exist', () => {
    for (const n of ['.gitconﬁg', 'ſhell-snapshots'])
      expect(fileWriteReason(join(home, 'runs', 'r2', n), root, env(), root)).toBe(FILE_WRITE_REASON)
  })
  test('denies a symlink in root that points to a home inbox.jsonl', () => {
    symlinkSync(join(home, 'runs', 'r1', 'inbox.jsonl'), join(root, 'link.txt'))
    expect(fileWriteReason(join(root, 'link.txt'), root, env(), root)).toBe(FACTORY_CONFIG_REASON)
  })
  test('allows inbox.jsonl in root and outbox.jsonl in the home', () => {
    expect(fileWriteReason(join(root, '.scratch', 'inbox.jsonl'), root, env(), root)).toBeUndefined()
    expect(fileWriteReason(join(root, '.scratch', 'state.json'), root, env(), root)).toBeUndefined()
    expect(fileWriteReason(join(home, 'runs', 'r1', 'outbox.jsonl'), root, env(), root)).toBeUndefined()
  })
})

describe('qn8a.24 main()', () => {
  let home: string
  let cwd: string
  const HOOK = join(import.meta.dir, 'worker-hook.ts')
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'qn8a24-home-'))
    cwd = mkdtempSync(join(tmpdir(), 'qn8a24-cwd-'))
    mkdirSync(join(home, 'runs', 'r1'), { recursive: true })
  })
  afterAll(() => {
    rmSync(home, { recursive: true })
    rmSync(cwd, { recursive: true })
  })
  test('a Write to the run inbox.jsonl is denied', () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      FACTORY_HOME: home,
      FACTORY_RUN: 'r1',
      FACTORY_FROM: 'implement',
      FACTORY_OUTBOX: undefined,
      FACTORY_DENY_LOG: undefined,
      FACTORY_HARNESS: undefined,
    }
    const input = {
      tool_name: 'Write',
      cwd,
      tool_input: { file_path: join(home, 'runs', 'r1', 'inbox.jsonl') },
    }
    const out = JSON.parse(
      Bun.spawnSync(['bun', HOOK, '--harness', 'claude'], {
        stdin: Buffer.from(JSON.stringify(input)),
        env,
      }).stdout.toString(),
    ).hookSpecificOutput
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toBe(FACTORY_CONFIG_REASON)
  })
})
