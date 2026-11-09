// claude-factory-aure.3: a rig's fast_check param reaches the brief as a "## Fast check" section
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// cli.ts reads its home at import, so the brief runs in a child process with its own FACTORY_HOME
const SCRIPT = `
import { brief } from ${JSON.stringify(join(import.meta.dir, 'cli'))}
import lifecycle from ${JSON.stringify(join(import.meta.dir, '..', 'factories', 'lifecycle'))}
const def = process.env.STRIP_FAST_CHECK ? { ...lifecycle, params: (({ fast_check, ...p }) => p)(lifecycle.params) } : lifecycle
const c = { seq: 1, attempt: 1, pane: null, session: null, resumes: 0, startedAt: 0, nudgedAt: 0, nudges: 0, retryAt: 0, budget: 10, wakeAt: 0, error: null, mail: {}, seen: {}, log: [] }
const run = { id: 'r1', factory: 'lifecycle', repo: process.env.REPO, goal: 'g', ws: 'ws', worktree: '/nonexistent/wt', branch: 'b' }
console.log(JSON.stringify(['implement', 'quick', 'verify', 'check'].map(n => brief(run, def, n, c, []))))
`
const REPO = '/nonexistent/acme-widget'
const count = (t: string) => t.split('\n').filter(l => l === '## Fast check').length

function briefs(rig: object, extra: Record<string, string> = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'fast-check-'))
  try {
    writeFileSync(
      join(dir, 'rigs.json'),
      JSON.stringify([{ name: 'acme-widget', repo: REPO, factory: 'lifecycle', ...rig }]),
    )
    const env: Record<string, string | undefined> = { ...process.env }
    for (const k of ['FACTORY_OUTBOX', 'FACTORY_FROM', 'FACTORY_FAST_CHECK']) delete env[k]
    const p = Bun.spawnSync([process.execPath, '-e', SCRIPT], {
      env: { ...env, FACTORY_HOME: dir, FACTORY_SELF_UPDATE: '0', REPO, ...extra },
    })
    expect(p.exitCode, p.stderr.toString()).toBe(0)
    return JSON.parse(p.stdout.toString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('(a) a rig value adds one fenced section after the task and before the push rules', () => {
  const out = briefs({ params: { fast_check: 'bunx prettier --check .' }, pushRules: ['Run git fetch.'] })
  expect(out).toHaveLength(4)
  for (const t of out) {
    expect(count(t)).toBe(1)
    expect(t).toContain(
      "## Fast check\nThe rig's fast check (format, lint, build-file lists). Run it at the worktree root. Exit 0 is green.\n~~~sh\nbunx prettier --check .\n~~~",
    )
    const at = t.indexOf('\n## Fast check\n')
    expect(at).toBeGreaterThan(t.indexOf('## Your task'))
    expect(at).toBeLessThan(t.indexOf('## Before each push'))
  }
})

test('(b) no value, (c) blank value, (d) rig empty beats env, (e) old definition: no section', () => {
  for (const out of [
    briefs({}),
    briefs({ params: { fast_check: '   ' } }),
    briefs({ params: { fast_check: '' } }, { FACTORY_FAST_CHECK: 'false' }),
    briefs({ params: { fast_check: 'x' } }, { STRIP_FAST_CHECK: '1' }),
  ])
    for (const t of out) expect(count(t)).toBe(0)
})

test('(f) the env value applies to a rig with no own value', () => {
  for (const t of briefs({}, { FACTORY_FAST_CHECK: 'make lint' })) {
    expect(count(t)).toBe(1)
    expect(t.split('\n')).toContain('make lint')
  }
})
