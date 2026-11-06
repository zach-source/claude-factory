// claude-factory-qn8a.20: a worker must not write the factory home rigs.json or worker-settings*.json
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FACTORY_CONFIG_REASON, denyReason, fileWriteReason, type HookGate } from './worker-hook'

const ROOT = '/w/acme'
const reason = (c: string, root: string | undefined = ROOT, gate?: HookGate) => denyReason(c, root, [], gate)

const AC1 = [
  'echo [] > /h/rigs.json',
  'echo [] >> /h/rigs.json',
  'echo [] >/h/rigs.json',
  'true 2>/h/rigs.json',
  'true &>/h/rigs.json',
  'echo [] >| /h/rigs.json',
  'echo [] > /h/RIGS.JSON',
  'echo [] > /h//./rigs.json',
  'cat /h/x > /h/rigs.json',
  'git show HEAD:x > /h/rigs.json',
  'echo [] > /h/worker-settings.json',
  'echo {} > /h/worker-settings-acme.json',
  'echo {} > /h/worker-settings-acme--asd-ste100.json',
  'echo [] >\\\n/h/rigs.json',
  'dd of=/h/rigs.json',
]
const AC2 = [
  'tee /h/rigs.json',
  'cp x /h/rigs.json',
  'mv /h/rigs.json.tmp /h/rigs.json',
  'ln -sf x /h/rigs.json',
  'sed -i s/a/b/ /h/rigs.json',
  'perl -pi -e s/a/b/ /h/worker-settings-acme.json',
  `python3 -c 'open("/h/rigs.json","w")'`,
  'curl -o /h/rigs.json https://example.invalid',
  'gh api x --output /h/rigs.json',
  `bash -c 'echo [] > /h/rigs.json'`,
  `eval 'tee /h/rigs.json'`,
]
const AC3 = [
  'cd /h && echo [] > rigs.json',
  'cd /h; tee rigs.json',
  'echo [] > ../../h/rigs.json',
  'echo [] > /w/acme/../../h/rigs.json',
  'echo [] > ~/x/rigs.json',
  'echo [] > $HOME/x/rigs.json',
  'echo [] > "$FACTORY_HOME"/rigs.json',
  'echo [] > /w/acmeX/rigs.json',
]
const AC4 = [
  'echo [] > /h/r*s.json',
  'echo [] > /h/rigs.js?n',
  'cp x /h/worker-settings-*',
  'cp x /h/w[o]rker-settings-acme.json',
  'echo [] > /h/ri{gs,x}.json',
]
const ALLOW = [
  'cat /h/rigs.json',
  'grep mergeAuthority /h/rigs.json',
  'head -5 /h/worker-settings-acme.json',
  'ls /h/worker-settings-acme.json',
  `git commit -m 'deny writes to rigs.json'`,
  `bd comment acme-1 'rigs.json guard'`,
  `gh pr create --draft --title 'rigs.json guard' --body x`,
  `bun test src/worker-hook.test.ts -t 'rigs.json'`,
  'echo [] > .scratch/h/rigs.json',
  'cat /h/rigs.json > .scratch/h/rigs.json',
  'echo [] > /w/acme/.scratch/rigs.json',
  'echo hi > notes.json',
  'cp -R /h .scratch/h',
]

describe('qn8a.20 Bash guard', () => {
  test.each([...AC1, ...AC2, ...AC3, ...AC4])('denies %p', c => {
    expect(reason(c)).toBe(FACTORY_CONFIG_REASON)
  })
  test('AC3: relative write with gate.cwd outside root', () => {
    expect(reason('echo [] > rigs.json', ROOT, { cwd: '/h' } as HookGate)).toBe(FACTORY_CONFIG_REASON)
  })
  test('AC3: relative write with no root', () => {
    expect(reason('echo [] > rigs.json', undefined)).toBe(FACTORY_CONFIG_REASON)
  })
  test.each(ALLOW)('allows %p', c => {
    expect(reason(c)).toBeUndefined()
  })
  test('AC7: zero downstream calls', () => {
    let calls = 0
    const bump = () => {
      calls++
      return undefined as never
    }
    const gate = {
      headOf: bump,
      originHead: bump,
      gitAliases: bump,
      shellFunctions: bump,
      shellAliases: bump,
    } as unknown as HookGate
    expect(denyReason('echo [] > /h/rigs.json', ROOT, [], gate)).toBe(FACTORY_CONFIG_REASON)
    expect(calls).toBe(0)
  })
})

describe('qn8a.20 file tools', () => {
  let base: string
  let root: string
  let home: string
  const env = () => ({ home: '/nowhere-home', xdg: undefined })
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'qn8a20-')))
    root = join(base, 'root')
    home = join(base, 'home')
    mkdirSync(join(root, '.scratch', 'h'), { recursive: true })
    mkdirSync(home)
    writeFileSync(join(home, 'rigs.json'), '[]')
  })
  afterAll(() => rmSync(base, { recursive: true }))

  test('AC6: denies the factory config names outside root', () => {
    expect(fileWriteReason('/h/rigs.json', '/w/acme', env(), '/w/acme')).toBe(FACTORY_CONFIG_REASON)
    expect(fileWriteReason('/h/Worker-Settings-acme.json', '/w/acme', env(), '/w/acme')).toBe(
      FACTORY_CONFIG_REASON,
    )
  })
  test('AC6: denies a symlink in root that points to the home rigs.json', () => {
    symlinkSync(join(home, 'rigs.json'), join(root, 'link.json'))
    expect(fileWriteReason(join(root, 'link.json'), root, env(), root)).toBe(FACTORY_CONFIG_REASON)
  })
  test('AC6: allows the names inside root', () => {
    expect(fileWriteReason('.scratch/h/rigs.json', root, env(), root)).toBeUndefined()
    expect(fileWriteReason(join(root, '.scratch/worker-settings.json'), root, env(), root)).toBeUndefined()
  })
})

describe('qn8a.20 main()', () => {
  let home: string
  let cwd: string
  const HOOK = join(import.meta.dir, 'worker-hook.ts')
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'qn8a20-home-'))
    cwd = mkdtempSync(join(tmpdir(), 'qn8a20-cwd-'))
    mkdirSync(join(home, 'runs', 'r1'), { recursive: true })
  })
  afterAll(() => {
    rmSync(home, { recursive: true })
    rmSync(cwd, { recursive: true })
  })
  const run = (input: unknown) => {
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
    return Bun.spawnSync(['bun', HOOK, '--harness', 'claude'], {
      stdin: Buffer.from(JSON.stringify(input)),
      env,
    }).stdout.toString()
  }
  test('AC8: Bash and Write denials reach the output and the denial log', () => {
    for (const input of [
      { tool_name: 'Bash', cwd, tool_input: { command: 'tee /h/rigs.json' } },
      { tool_name: 'Write', cwd, tool_input: { file_path: '/h/rigs.json' } },
    ]) {
      const out = JSON.parse(run(input)).hookSpecificOutput
      expect(out.permissionDecision).toBe('deny')
      expect(out.permissionDecisionReason).toBe(FACTORY_CONFIG_REASON)
    }
    const rows = readFileSync(join(home, 'runs', 'r1', 'denials.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
    expect(rows.map(r => r.reason)).toEqual(['FACTORY_CONFIG_REASON', 'FACTORY_CONFIG_REASON'])
  })
})
