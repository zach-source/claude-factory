import { describe, expect, test } from 'bun:test'
import { planSecurity, routeLine, securityRoute, sensitivePath } from './security-route'

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
