// claude-factory-ag2.2 and ag2.3 through bin/factory: `factory review facts|set`, the verdict in the
// listings and the tick, and the refusal of every install and reject verb under FACTORY_PATROL.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const dir = join(tmpdir(), `review-cli-${process.pid}`)
const home = join(dir, 'home')
const mem = join(home, 'memory')
const reviews = join(home, 'reviews.json')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, FACTORY_RUN, FACTORY_PATROL, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }
}
const skillMd = '---\ndescription: does a thing\n---\nrun `factory x`\n'
const answer = (o: unknown) => {
  const f = join(dir, 'answer.txt')
  writeFileSync(f, `Thoughts.\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n`)
  return f
}
const keyOf = (kind: string) => {
  const t = JSON.parse(run(['tick']).out) as { reviews: { key: string; kind: string }[] }
  return t.reviews.find(r => r.kind === kind)!.key
}

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(mem, '.proposals'), { recursive: true })
  mkdirSync(join(mem, '.manager', 'skills', 'sk'), { recursive: true })
  writeFileSync(join(mem, '.manager', 'skills', 'sk', 'SKILL.md'), skillMd)
  writeFileSync(
    join(mem, '.proposals', 'pr.md'),
    '---\nrung: core\ntarget: CORE.md\nstatus: pending\n---\nRun prettier.\n',
  )
  Bun.spawnSync(['git', 'init', '-q', mem])
  writeFileSync(join(mem, 'CORE.md'), '- an old line\n')
})

test('tick lists the items with no verdict, without their text', () => {
  const t = JSON.parse(run(['tick']).out)
  expect(t.reviews.map((r: { kind: string; name: string }) => `${r.kind}:${r.name}`)).toEqual([
    'skill:sk',
    'proposal:pr',
  ])
  expect(JSON.stringify(t.reviews)).not.toContain('prettier')
})

test('review facts: the text, clipped; an unknown or stale key exits 1', () => {
  const key = keyOf('skill')
  const f = JSON.parse(run(['review', 'facts', key]).out)
  expect(f).toMatchObject({ key, kind: 'skill', name: 'sk', change: 'new' })
  expect(f.text).toContain('factory x')
  expect(run(['review', 'facts', 'skill:sk:000000000000']).code).toBe(1)
  writeFileSync(join(mem, '.manager', 'skills', 'sk', 'SKILL.md'), `${skillMd}more`)
  expect(run(['review', 'facts', key]).code).toBe(1)
})

test('review facts clips a long text to 16384 chars', () => {
  writeFileSync(join(mem, '.manager', 'skills', 'sk', 'SKILL.md'), `${skillMd}${'x'.repeat(30000)}`)
  const f = JSON.parse(run(['review', 'facts', keyOf('skill')]).out)
  expect(f.text.length).toBeLessThanOrEqual(16385)
})

test('review set: one verdict for a key; a second set, a stale or unknown key and a bad answer exit 1', () => {
  const key = keyOf('skill')
  const ok = answer({ recommendation: 'install', why: 'Safe.' })
  expect(run(['review', 'set', key, ok]).code).toBe(0)
  const first = readFileSync(reviews, 'utf8')
  expect(JSON.parse(first)[key]).toMatchObject({ recommendation: 'install', why: 'Safe.' })
  expect(run(['review', 'set', key, answer({ recommendation: 'reject', why: 'No.' })]).code).toBe(1)
  expect(readFileSync(reviews, 'utf8')).toBe(first)
  expect(run(['review', 'set', 'skill:sk:000000000000', ok]).code).toBe(1)
  const pk = keyOf('proposal')
  expect(run(['review', 'set', pk, answer({ recommendation: 'maybe', why: 'x' })]).code).toBe(1)
  writeFileSync(join(mem, '.proposals', 'pr.md'), '---\nrung: core\nstatus: pending\n---\nOther.\n')
  expect(run(['review', 'set', pk, ok]).code).toBe(1)
  expect(JSON.parse(readFileSync(reviews, 'utf8'))[pk]).toBeUndefined()
})

test('the listings and the tick carry the verdict', () => {
  const sk = keyOf('skill')
  const pk = keyOf('proposal')
  run(['review', 'set', sk, answer({ recommendation: 'reject', why: 'Unsafe command.' })])
  run(['review', 'set', pk, answer({ recommendation: 'install', why: 'Matches 3 failures.' })])
  const rows = JSON.parse(run(['skills']).out)
  expect(rows[0]).toMatchObject({ name: 'sk', recommendation: 'reject', why: 'Unsafe command.' })
  expect(run(['proposals']).out).toContain('pr  core  CORE.md: Run prettier.')
  expect(run(['proposals']).out).toContain('reviewer: install, Matches 3 failures.')
  const t = JSON.parse(run(['tick']).out)
  expect(t.reviews).toEqual([])
  // the items that wait on the manager keep their verdict in the tick, for the patrol
  expect(t.reviewed).toEqual([
    {
      key: sk,
      kind: 'skill',
      name: 'sk',
      change: 'new',
      recommendation: 'reject',
      why: 'Unsafe command.',
    },
    {
      key: pk,
      kind: 'proposal',
      name: 'pr',
      change: 'pending',
      recommendation: 'install',
      why: 'Matches 3 failures.',
    },
  ])
})

test('a skill with no verdict has none in the listing', () => {
  const rows = JSON.parse(run(['skills']).out)
  expect(rows[0].recommendation).toBeUndefined()
})

test('under FACTORY_PATROL every install, reject and review set verb refuses and changes nothing', () => {
  const key = keyOf('skill')
  const ok = answer({ recommendation: 'install', why: 'x' })
  for (const args of [
    ['skills', 'install', 'sk'],
    ['skills', 'reject', 'sk', 'why'],
    ['proposals', 'install', 'pr'],
    ['proposals', 'reject', 'pr', 'why'],
    ['review', 'set', key, ok],
  ]) {
    const r = run(args, { FACTORY_PATROL: '1' })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('patrol')
  }
  expect(existsSync(join(mem, '.manager', '.claude', 'skills', 'sk'))).toBe(false)
  expect(readFileSync(join(mem, 'CORE.md'), 'utf8')).toBe('- an old line\n')
  expect(readFileSync(join(mem, '.proposals', 'pr.md'), 'utf8')).toContain('status: pending')
  expect(existsSync(reviews)).toBe(false)
  // the list verbs still work for a patrol
  expect(run(['skills'], { FACTORY_PATROL: '1' }).code).toBe(0)
  expect(run(['proposals'], { FACTORY_PATROL: '1' }).code).toBe(0)
})

test('under FACTORY_FROM (a worker) install and reject refuse and change nothing', () => {
  for (const args of [
    ['skills', 'install', 'sk'],
    ['skills', 'reject', 'sk', 'why'],
    ['proposals', 'install', 'pr'],
    ['proposals', 'reject', 'pr', 'why'],
  ]) {
    const r = run(args, { FACTORY_FROM: 'implement' })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('worker')
  }
  expect(existsSync(join(mem, '.manager', '.claude', 'skills', 'sk'))).toBe(false)
  expect(readFileSync(join(mem, 'CORE.md'), 'utf8')).toBe('- an old line\n')
  expect(readFileSync(join(mem, '.proposals', 'pr.md'), 'utf8')).toContain('status: pending')
})

test('without FACTORY_PATROL install still works', () => {
  expect(run(['skills', 'install', 'sk']).code).toBe(0)
  expect(existsSync(join(mem, '.manager', '.claude', 'skills', 'sk', 'SKILL.md'))).toBe(true)
  expect(run(['proposals', 'install', 'pr']).code).toBe(0)
  expect(readFileSync(join(mem, 'CORE.md'), 'utf8')).toContain('Run prettier.')
})
