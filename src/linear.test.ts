// src/linear.ts's pure helpers: config shape, argv, env and output parsing, redaction. No process spawned
// here except the config's own command (a real `sh -c`, never bd), which the fakes below keep fast and
// deterministic. The end-to-end loop through a fake `bd` on PATH is in linear.test.ts's CLI tests.
import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLinearTeams, parseSync, readLinearConfig, redact, syncArgs, syncEnv } from './linear'

const dir = join(tmpdir(), `linear-unit-${process.pid}`)

test('parseLinearTeams accepts one or more UUIDs, and refuses anything else, naming it', () => {
  const id1 = '04114abf-ddb7-4a6f-bb47-814fd2c44373'
  const id2 = '11111111-2222-3333-4444-555555555555'
  expect(parseLinearTeams(id1)).toEqual([id1])
  expect(parseLinearTeams(`${id1},${id2}`)).toEqual([id1, id2])
  expect(() => parseLinearTeams('not-a-uuid')).toThrow('"not-a-uuid"')
  expect(() => parseLinearTeams(`${id1},nope`)).toThrow('"nope"')
})

test('syncArgs is pull-if-stale only, with --json, and never --push or the key', () => {
  const args = syncArgs(['04114abf-ddb7-4a6f-bb47-814fd2c44373'])
  expect(args).toEqual([
    'linear',
    'sync',
    '--pull-if-stale',
    '--threshold',
    '15m',
    '--team',
    '04114abf-ddb7-4a6f-bb47-814fd2c44373',
    '--json',
  ])
  expect(args).not.toContain('--push')
  expect(args.join(' ')).not.toMatch(/lin_/)
})

test('syncArgs joins several team ids with a comma', () => {
  expect(syncArgs(['a', 'b'])).toContain('a,b')
})

test('readLinearConfig refuses a missing file, naming the docs', () => {
  expect(() => readLinearConfig(join(dir, 'absent.json'))).toThrow('see docs/beads.md')
})

test('readLinearConfig reads an apiKey command, or a clientId/clientSecret pair', () => {
  mkdirSync(dir, { recursive: true })
  const apiKeyFile = join(dir, 'apikey.json')
  writeFileSync(apiKeyFile, JSON.stringify({ apiKey: 'op read op://vault/item/key' }))
  expect(readLinearConfig(apiKeyFile)).toEqual({ apiKey: 'op read op://vault/item/key' })
  const oauthFile = join(dir, 'oauth.json')
  writeFileSync(oauthFile, JSON.stringify({ clientId: 'op read op://v/i/id', clientSecret: 'op read op://v/i/s' }))
  expect(readLinearConfig(oauthFile)).toEqual({
    clientId: 'op read op://v/i/id',
    clientSecret: 'op read op://v/i/s',
  })
  rmSync(dir, { recursive: true, force: true })
})

test('readLinearConfig refuses a literal key or secret, and the message does not echo it', () => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'literal.json')
  writeFileSync(file, JSON.stringify({ apiKey: 'lin_api_fixtureNOTREAL' }))
  expect(() => readLinearConfig(file)).toThrow(/command/)
  try {
    readLinearConfig(file)
    throw new Error('did not throw')
  } catch (err) {
    expect((err as Error).message).not.toContain('lin_api_fixtureNOTREAL')
  }
  writeFileSync(file, JSON.stringify({ clientId: 'x', clientSecret: 'lin_oauth_zzz' }))
  expect(() => readLinearConfig(file)).toThrow(/command/)
  rmSync(dir, { recursive: true, force: true })
})

test('readLinearConfig refuses a file with neither shape', () => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'bad.json')
  writeFileSync(file, JSON.stringify({ nope: 1 }))
  expect(() => readLinearConfig(file)).toThrow('apiKey')
  rmSync(dir, { recursive: true, force: true })
})

test('syncEnv runs the apiKey command and sets LINEAR_API_KEY, dropping every inherited LINEAR_* first', () => {
  const base = {
    LINEAR_API_KEY: 'stale',
    LINEAR_OAUTH_CLIENT_ID: 'stale-id',
    LINEAR_OAUTH_CLIENT_SECRET: 'stale-secret',
    PATH: process.env.PATH,
  }
  const env = syncEnv({ apiKey: 'printf test-key-123' }, base)
  expect(env.LINEAR_API_KEY).toBe('test-key-123')
  expect(env.LINEAR_OAUTH_CLIENT_ID).toBeUndefined()
  expect(env.LINEAR_OAUTH_CLIENT_SECRET).toBeUndefined()
  expect(env.PATH).toBe(process.env.PATH)
})

test('syncEnv runs both OAuth commands and sets the client id and secret, never LINEAR_API_KEY', () => {
  const env = syncEnv({ clientId: 'printf cid-1', clientSecret: 'printf csecret-1' }, { LINEAR_API_KEY: 'stale' })
  expect(env.LINEAR_OAUTH_CLIENT_ID).toBe('cid-1')
  expect(env.LINEAR_OAUTH_CLIENT_SECRET).toBe('csecret-1')
  expect(env.LINEAR_API_KEY).toBeUndefined()
})

test('syncEnv throws when the command fails, naming no value', () => {
  expect(() => syncEnv({ apiKey: 'sh -c "exit 7"' }, {})).toThrow()
})

test('parseSync reads a fresh skip, a real pull, and an engine error, the three shapes bd 1.3.0 prints', () => {
  expect(parseSync('{"is_fresh":true,"skipped":true,"last_pull":"2026-10-15T10:00:00Z","age":"5m"}', 0)).toEqual({
    fresh: true,
    lastPull: '2026-10-15T10:00:00Z',
  })
  expect(
    parseSync(
      '{"stats":{"pulled":3,"pushed":0,"created":2,"updated":1,"skipped":0,"errors":0,"conflicts":0},"warnings":[],"is_fresh":true,"skipped":false}',
      0,
    ),
  ).toEqual({ fresh: false, pulled: 3, created: 2, updated: 1 })
  expect(parseSync('{"error":"dial tcp 127.0.0.1:3308: i/o timeout"}', 1)).toEqual({
    error: 'dial tcp 127.0.0.1:3308: i/o timeout',
  })
})

test('parseSync treats a nonzero exit with no parseable error field as an error too', () => {
  expect(parseSync('not json', 1)).toMatchObject({ error: expect.any(String) })
  expect(parseSync('{"stats":{}}', 1)).toMatchObject({ error: expect.any(String) })
})

test('redact blanks every secret value in the text and clips it to 200 chars', () => {
  const long = `failed: key lin_api_SECRETVALUE rejected ${'x'.repeat(250)}`
  const out = redact(long, ['lin_api_SECRETVALUE'])
  expect(out).not.toContain('lin_api_SECRETVALUE')
  expect(out).toContain('***')
  expect(out.length).toBeLessThanOrEqual(201) // 200 chars + the clip marker
})

test('redact with no secrets still clips long text', () => {
  const out = redact('x'.repeat(300), [])
  expect(out.length).toBeLessThanOrEqual(201)
})

// The loop end to end through `bin/factory linear`, with a fake `bd` on PATH that logs every call's
// argv, cwd and LINEAR_* env, so the real loop (src/cli.ts's linearPass) is proven, not a mock of it.
import { afterAll, beforeEach } from 'bun:test'
import { chmodSync, existsSync, readFileSync } from 'node:fs'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const cdir = join(tmpdir(), `linear-cli-${process.pid}`)
const home = join(cdir, 'home')
const bin = join(cdir, 'bin')
const calls = join(cdir, 'calls.log')
const mode = join(cdir, 'mode') // fresh | pulled | error, read by the fake bd's `linear sync`
const listTurn = join(cdir, 'list-turn') // counts `bd list` calls, so before/after differ

const TEAM = '04114abf-ddb7-4a6f-bb47-814fd2c44373'
const repoA = join(cdir, 'repo-a')
const repoB = join(cdir, 'repo-b')

afterAll(() => rmSync(cdir, { recursive: true, force: true }))

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: { ...laptop, FACTORY_HOME: home, PATH: `${bin}:${laptop.PATH}`, FACTORY_SELF_UPDATE: '0', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** fake bd: `linear sync` answers from $mode (fresh|pulled|error); `list` answers [] the first time (no
 * bead carries the label yet) and one newly-labeled bead the second time, so the strip step has exactly
 * one new id to act on; `label remove` and anything else just logs and exits 0. Every call appends one
 * line: its argv, its cwd, and the three LINEAR_* env vars it saw (empty when unset). */
function fakeBd() {
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "ARGV|$*|CWD|$(pwd)|KEY|${'$'}{LINEAR_API_KEY}|OAUTHID|${'$'}{LINEAR_OAUTH_CLIENT_ID}|OAUTHSECRET|${'$'}{LINEAR_OAUTH_CLIENT_SECRET}" >> ${calls}`,
    'case "$1" in',
    '  linear)',
    `    m=$(cat ${mode} 2>/dev/null || echo fresh)`,
    '    case "$m" in',
    '      fresh) printf \'%s\' \'{"is_fresh":true,"skipped":true,"last_pull":"2026-10-15T10:00:00Z","age":"5m"}\';;',
    '      pulled) printf \'%s\' \'{"stats":{"pulled":2,"pushed":0,"created":1,"updated":1,"skipped":0,"errors":0,"conflicts":0},"warnings":[],"is_fresh":true,"skipped":false}\';;',
    '      error) echo "dial tcp 127.0.0.1:3308: i/o timeout, key test-key-123" >&2; printf \'%s\' \'{"error":"dial tcp 127.0.0.1:3308: i/o timeout, key test-key-123"}\'; exit 1;;',
    '    esac;;',
    '  list)',
    `    n=$(cat ${listTurn} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${listTurn}`,
    '    case "$n" in',
    '      1) printf \'%s\' \'[{"id":"acme-old"}]\';;',
    '      *) printf \'%s\' \'[{"id":"acme-old"},{"id":"acme-new"}]\';;',
    '    esac;;',
    '  label) exit 0;;',
    '  *) exit 0;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
}

function writeRigs(rigsList: unknown[]) {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'rigs.json'), JSON.stringify(rigsList))
}

const linearJson = (cfg: unknown) => writeFileSync(join(home, 'linear.json'), JSON.stringify(cfg))

function reset() {
  rmSync(cdir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(repoA, { recursive: true })
  mkdirSync(repoB, { recursive: true })
  fakeBd()
  writeFileSync(mode, 'pulled')
}

const callLines = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [])
const argvOf = (line: string) => line.split('|')[1]!
const cwdOf = (line: string) => line.split('|')[3]!
const keyOf = (line: string) => line.split('|')[5]!

beforeEach(reset)

test('linearPass runs pull-if-stale for every opted-in rig only, never --push, cwd the rig repo', () => {
  writeRigs([
    { name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] },
    { name: 'b', repo: repoB, factory: 'lifecycle' }, // not opted in: no Linear call at all
  ])
  linearJson({ apiKey: 'printf test-key-123' })
  const out = factory(['linear'])
  expect(out.code).toBe(0)
  const syncCalls = callLines().filter(l => argvOf(l).startsWith('linear sync'))
  expect(syncCalls).toHaveLength(1)
  expect(argvOf(syncCalls[0]!)).toBe(`linear sync --pull-if-stale --threshold 15m --team ${TEAM} --json`)
  expect(argvOf(syncCalls[0]!)).not.toContain('--push')
  expect(cwdOf(syncCalls[0]!)).toEndWith('/repo-a')
  expect(callLines().some(l => cwdOf(l).endsWith('/repo-b'))).toBe(false)
})

test('the key reaches bd only by env, on the sync call; list/label calls carry no key at all', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] }])
  linearJson({ apiKey: 'printf test-key-123' })
  factory(['linear'])
  const syncCall = callLines().find(l => argvOf(l).startsWith('linear sync'))!
  expect(keyOf(syncCall)).toBe('test-key-123')
  expect(argvOf(syncCall)).not.toContain('test-key-123')
  for (const l of callLines().filter(l => !argvOf(l).startsWith('linear sync'))) expect(keyOf(l)).toBe('')
})

test('a rig syncs at most once per 20 min; --force syncs again right away', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] }])
  linearJson({ apiKey: 'printf test-key-123' })
  factory(['linear'])
  expect(callLines().filter(l => argvOf(l).startsWith('linear sync'))).toHaveLength(1)
  factory(['linear']) // too soon: no second call
  expect(callLines().filter(l => argvOf(l).startsWith('linear sync'))).toHaveLength(1)
  factory(['linear', '--force'])
  expect(callLines().filter(l => argvOf(l).startsWith('linear sync'))).toHaveLength(2)
})

test('after a pull, only the bead newly labeled factory loses the label; one already labeled keeps it', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] }])
  linearJson({ apiKey: 'printf test-key-123' })
  factory(['linear'])
  const removes = callLines().filter(l => argvOf(l).startsWith('label remove'))
  expect(removes).toHaveLength(1)
  expect(argvOf(removes[0]!)).toBe('label remove acme-new factory')
})

test('linear sync never runs for a rig with no linear.json: it errors "no linear.json", and bd is never called', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] }])
  // no linear.json written
  const out = factory(['linear'])
  expect(out.out).toContain('no')
  expect(out.out).toContain('linear.json')
  expect(out.out).toContain('docs/beads.md')
  expect(callLines()).toHaveLength(0)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.error).toContain('docs/beads.md')
})

test('a sync error is recorded redacted (no secret value) and clipped, in linear-sync.json', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] }])
  linearJson({ apiKey: 'printf test-key-123' })
  writeFileSync(mode, 'error')
  factory(['linear'])
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.error).toBeTruthy()
  expect(state.a.error).not.toContain('test-key-123')
  expect(state.a.error.length).toBeLessThanOrEqual(201)
})

test('a fresh skip is recorded, with no label strip (nothing new to strip)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] }])
  linearJson({ apiKey: 'printf test-key-123' })
  writeFileSync(mode, 'fresh')
  factory(['linear'])
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.fresh).toBe(true)
  expect(state.a.lastPull).toBe('2026-10-15T10:00:00Z')
  expect(callLines().some(l => argvOf(l).startsWith('label remove'))).toBe(false)
})

test('rig list shows a Linear-opted rig\'s last pull count, or its error (claude-factory-b6c.5)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] }])
  writeFileSync(
    join(home, 'linear-sync.json'),
    JSON.stringify({ a: { at: Date.now(), fresh: false, pulled: 3, created: 1, updated: 2, stripped: 0 } }),
  )
  const pulled = factory(['rig', 'list'])
  expect(pulled.out).toContain(`linear: ${TEAM} (pulled 3,`)

  writeFileSync(join(home, 'linear-sync.json'), JSON.stringify({ a: { at: Date.now(), fresh: false, error: 'boom' } }))
  const erred = factory(['rig', 'list'])
  expect(erred.out).toContain(`linear: ${TEAM} (error`)
  expect(erred.out).toContain('boom')
})

// These tests cover tick() (claude-factory-b6c.5). tick() builds the console's view of each opted-in
// rig's last Linear pull. tick() also sends one manager mail for each new Linear pull error.
//
// A fake `beads.lock` blocks a race. The lock holds this test's own pid, which stays alive through the
// test. The lock stops tick's kickBeads function. kickBeads would start a real `factory beads` pass.
// That pass would pull again through the fake bd, and so it would race these assertions.
const blockBeadsKick = () => {
  mkdirSync(join(home, 'beads.lock'), { recursive: true })
  writeFileSync(join(home, 'beads.lock', 'pid'), String(process.pid))
}
const writeSyncState = (s: unknown) => writeFileSync(join(home, 'linear-sync.json'), JSON.stringify(s))
const tickJson = () => JSON.parse(factory(['tick']).out)

test("tick's out.rigs carries each opted-in rig's last Linear sync state, for the console", () => {
  writeRigs([
    { name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] },
    { name: 'b', repo: repoB, factory: 'lifecycle' }, // not opted in: no linearSync at all
  ])
  blockBeadsKick()
  const state = { at: Date.now(), fresh: false, pulled: 2, created: 1, updated: 1, stripped: 0 }
  writeSyncState({ a: state })
  const out = tickJson()
  expect(out.rigs.find((r: { name: string }) => r.name === 'a').linearSync).toEqual(state)
  expect(out.rigs.find((r: { name: string }) => r.name === 'b').linearSync).toBeUndefined()
})

test('a failing rig mails the manager once; the same error again mails nothing more; success then failure mails again', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: [TEAM] }])
  blockBeadsKick()
  const linearMailOf = (out: { manager: { from: string; text: string; run: string }[] }) =>
    out.manager.filter(m => m.from === 'linear')

  writeSyncState({ a: { at: Date.now(), fresh: false, error: 'boom' } })
  const first = linearMailOf(tickJson())
  expect(first).toHaveLength(1)
  expect(first[0]!.run).toBe('factory')
  expect(first[0]!.text).toContain('boom')

  const second = linearMailOf(tickJson()) // the same error, unchanged: no second mail
  expect(second).toHaveLength(0)

  // a success since the last mail clears the told state
  writeSyncState({ a: { at: Date.now(), fresh: true, lastPull: '2026-10-15T10:00:00Z' } })
  const third = linearMailOf(tickJson())
  expect(third).toHaveLength(0)

  writeSyncState({ a: { at: Date.now(), fresh: false, error: 'boom2' } }) // a new error after a success
  const fourth = linearMailOf(tickJson())
  expect(fourth).toHaveLength(1)
  expect(fourth[0]!.text).toContain('boom2')
})
