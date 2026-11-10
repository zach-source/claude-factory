import { describe, expect, test } from 'bun:test'
import { planSecurity, rigPaths, routeLine, SECURITY_REASON, securityRoute, sensitivePath } from './security-route'

describe('sensitivePath', () => {
  test.each([
    'factories/lifecycle.ts',
    '.factory/lifecycle.ts',
    '.github/workflows/ci.yml',
    'deploy/server.yaml',
    'Dockerfile.worker',
    'infra/main.tf',
    'bun.lock',
    'package.json',
    'go.sum',
    'src/worker-hook.ts',
    'src/worker-hook-qn8a25.test.ts',
    'src/claudeToken.ts',
    'src/claude-token.ts',
    'src/filing-guard.ts',
    'src/dispatch-signing.ts',
    'mod/hooks/register.tsx',
    'pkg/auth/x.go',
    'src/parser.ts',
    '.claude/settings.json',
    '.codex/config.toml',
    '.cursor/rules/x.mdc',
    '.agents/x.md',
    '.husky/pre-commit',
    '.cargo/config.toml',
    'CLAUDE.md',
    'AGENTS.md',
    'docs/CLAUDE.md',
    '.mcp.json',
    '.gitmodules',
    '.gitattributes',
    '.npmrc',
    '.yarnrc.yml',
    'bunfig.toml',
    '.pre-commit-config.yaml',
    '.envrc',
  ])('sensitive %s', p => expect(sensitivePath(p)).not.toBe(''))

  test('order and shapes', () => {
    expect(sensitivePath('factories/package.json')).toBe('file')
    expect(sensitivePath('factories/naïve.ts')).toBe('dir:factories')
    expect(sensitivePath('Charts/x.yaml')).toBe('dir:charts')
    expect(sensitivePath('src/HTTPAuth.ts')).toBe('word:auth')
  })

  test.each([
    'src/metrics.ts',
    'docs/claude-notes.md',
    'src/cli.ts',
    'README.md',
    'docs/console.md',
    'src/monkey.ts',
    'src/hotkeys.ts',
    'src/keyboard.ts',
    'src/signal.ts',
    'src/tokenizer-notes.md',
    'CHANGELOG.md',
    '',
  ])('not sensitive %p', p => expect(sensitivePath(p)).toBe(''))
})

describe('planSecurity', () => {
  test('explicit line', () => {
    expect(planSecurity('Security-sensitive: yes (auth)')).toBe('yes')
    expect(planSecurity('- Security-sensitive: yes')).toBe('yes')
    expect(planSecurity('Security-sensitive: no')).toBe('no')
    expect(planSecurity('Security-sensitive: yes\nSecurity-sensitive: no')).toBe('no')
  })
  test('fallback', () => {
    expect(planSecurity('Risk: security-sensitive: it parses input')).toBe('yes')
    expect(planSecurity('Risk: not security-sensitive')).toBeUndefined()
    expect(planSecurity('a non-security-sensitive change')).toBeUndefined()
    expect(planSecurity(undefined)).toBeUndefined()
    expect(planSecurity('')).toBeUndefined()
  })
})

describe('securityRoute', () => {
  test('required', () => {
    const a = securityRoute({ paths: null, labels: [] })
    expect(a.required).toBe(true)
    expect(a.why).toContain('paths unknown')
    const b = securityRoute({ paths: [], labels: null })
    expect(b.why).toContain('bead labels unknown')
    expect(securityRoute({ paths: [], labels: ['security'] }).required).toBe(true)
    expect(securityRoute({ paths: [], plan: 'Security-sensitive: yes', labels: [] }).required).toBe(true)
    expect(securityRoute({ paths: ['factories/x.ts'], labels: [] }).why).toEqual([
      'factories/x.ts (dir:factories)',
    ])
  })
  test('not required', () => {
    expect(
      securityRoute({ paths: ['src/metrics.ts'], plan: 'Security-sensitive: no', labels: [] }).required,
    ).toBe(false)
    expect(securityRoute({ paths: [], labels: [] }).required).toBe(false)
  })
  test('clips and cleans', () => {
    const paths = Array.from({ length: 7 }, (_, i) => `factories/f${i}.ts`)
    const r = securityRoute({ paths, labels: [] })
    expect(r.why).toHaveLength(6)
    expect(r.why[5]).toBe('+2 more')
    expect(securityRoute({ paths: ['factories/a\nb.ts'], labels: [] }).why[0]).toBe(
      'factories/a?b.ts (dir:factories)',
    )
  })
  test('routeLine', () => {
    expect(routeLine({ required: true, why: ['a', 'b'] })).toBe('required: a; b')
    expect(routeLine({ required: false, why: [] }).startsWith('not required: ')).toBe(true)
  })
})

test.each([
  ['Security-reason: src/cli.ts:13388 report refusal', true],
  ['Reviewed head: abc\n- Security-reason: a.ts:1 b', true],
  ['  * Security-reason: a.ts:1 b', true],
  ['summary text', false],
  ['Security-reason: src/cli.ts report', false],
  ['Security-reason: src/cli.ts: report', false],
  ['Security-reason: src/cli.ts:12\nReviewed head: abc', false],
  ['see Security-reason: a.ts:1 b', false],
  ['see\u2028Security-reason: a.ts:1 b', true],
])('SECURITY_REASON %j is %p', (input, ok) => {
  expect(SECURITY_REASON.test(input)).toBe(ok)
})

describe('rigPaths', () => {
  test('good values', () => {
    expect(rigPaths(undefined)).toEqual([])
    expect(rigPaths([])).toEqual([])
    expect(rigPaths(['src/cli.ts', 'mod/', 'a.b/c-d_e'])).toEqual(['src/cli.ts', 'mod/', 'a.b/c-d_e'])
    expect(rigPaths(['x'.repeat(200)])).toEqual(['x'.repeat(200)])
  })
  test.each([
    [null],
    ['x'],
    [{}],
    [[1]],
    [['']],
    [['*.ts']],
    [['src/*']],
    [['../x']],
    [['a/../b']],
    [['./a']],
    [['a/./b']],
    [['/abs']],
    [['a//b']],
    [['a b']],
    [['a\\b']],
    [['a\nb']],
    [['naïve.ts']],
    [['x'.repeat(201)]],
    [['ok', 7]],
  ])('bad value %j gives null', v => {
    expect(rigPaths(v)).toBeNull()
  })
})

describe('securityRoute rigPaths', () => {
  test.each([
    ['mod/', 'mod/.claude-plugin/plugin.json', true],
    ['mod', 'mod/.claude-plugin/plugin.json', true],
    ['src/cli.ts', 'src/cli.ts', true],
    ['src/cli', 'src/cli.ts', false],
    ['mod/', 'modx/a.ts', false],
    ['mod/', 'src/mod/a.ts', false],
    ['Src/cli.ts', 'src/cli.ts', false],
  ])('entry %s path %s', (e, p, want) => {
    expect(securityRoute({ paths: [p], labels: [], rigPaths: [e] }).required).toBe(want)
  })
  test('first match, reasons, fail closed', () => {
    expect(securityRoute({ paths: ['mod/a.ts'], labels: [], rigPaths: ['mod', 'mod/'] }).why).toEqual([
      'mod/a.ts (rig:mod)',
    ])
    expect(
      securityRoute({ paths: ['src/cli.ts'], labels: [], plan: 'Security-sensitive: no', rigPaths: ['src/cli.ts'] }),
    ).toEqual({ required: true, why: ['src/cli.ts (rig:src/cli.ts)'] })
    expect(securityRoute({ paths: ['factories/x.ts'], labels: [], rigPaths: ['factories/'] }).why).toEqual([
      'factories/x.ts (dir:factories)',
    ])
    expect(securityRoute({ paths: [], labels: [], rigPaths: null }).why).toEqual(['rig sensitivePaths malformed'])
    expect(securityRoute({ paths: ['src/metrics.ts'], labels: [], rigPaths: [] }).required).toBe(false)
    expect(securityRoute({ paths: ['src/metrics.ts'], labels: [] }).required).toBe(false)
  })
  test('clip', () => {
    const paths = [0, 1, 2, 3, 4, 5, 6].map(i => `src/f${i}.ts`)
    const why = securityRoute({ paths, labels: [], rigPaths: ['src/'] }).why
    expect(why).toHaveLength(6)
    expect(why.at(-1)).toBe('+2 more')
  })
})
