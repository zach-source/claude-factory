// src/linear.ts's pure helpers: team ids, routing, secret-broker credentials, the Linear API list
// call, argv, env and output parsing, redaction. The broker and Linear API tests run a fake HTTP
// server (Bun.serve), never a real one. The end-to-end loop through a fake `bd` on PATH is in this
// file's CLI tests, further down.
import { expect, test } from 'bun:test'
import {
  type ConnectCache,
  CONNECT_SETUP_HELP,
  fetchLinearIssues,
  parseLinearList,
  parseLinearTeams,
  parseSync,
  pullArgs,
  redact,
  resolveConnectCreds,
  resolveLinearApiKey,
  routeLinearIssue,
  syncEnv,
} from './linear'

test('parseLinearTeams accepts one or more UUIDs, and refuses anything else, naming it', () => {
  const id1 = '04114abf-ddb7-4a6f-bb47-814fd2c44373'
  const id2 = '11111111-2222-3333-4444-555555555555'
  expect(parseLinearTeams(id1)).toEqual([id1])
  expect(parseLinearTeams(`${id1},${id2}`)).toEqual([id1, id2])
  expect(() => parseLinearTeams('not-a-uuid')).toThrow('"not-a-uuid"')
  expect(() => parseLinearTeams(`${id1},nope`)).toThrow('"nope"')
})

test('parseLinearList splits a comma list and trims each name, and refuses an empty list', () => {
  expect(parseLinearList('a, b ,c')).toEqual(['a', 'b', 'c'])
  expect(() => parseLinearList('')).toThrow()
  expect(() => parseLinearList(' , ')).toThrow()
})

test('pullArgs is "linear pull <ref...> --json", by identifier, never --push, a URL, or the key', () => {
  const args = pullArgs(['STI-1', 'STI-2'])
  expect(args).toEqual(['linear', 'pull', 'STI-1', 'STI-2', '--json'])
  expect(args).not.toContain('--push')
  expect(args.join(' ')).not.toMatch(/lin_/)
  expect(args.join(' ')).not.toContain('://')
})

test('routeLinearIssue rule 1: a project named "[<rig-name>] ..." routes to that rig, with no other config', () => {
  const rigs = [
    { name: 'acme', linear: { team: ['t'] } },
    { name: 'widget', linear: { team: ['t'] } },
  ]
  expect(routeLinearIssue({ project: '[acme] fix the thing', labels: [] }, rigs)).toBe('acme')
  expect(routeLinearIssue({ project: '[widget] ship it', labels: [] }, rigs)).toBe('widget')
})

test('routeLinearIssue rule 2: an exact project-name match routes to the rig that configured it', () => {
  const rigs = [{ name: 'acme', linear: { team: ['t'], projects: ['Infra Catalog'] } }]
  expect(routeLinearIssue({ project: 'Infra Catalog', labels: [] }, rigs)).toBe('acme')
  expect(routeLinearIssue({ project: 'Other Project', labels: [] }, rigs)).toBeUndefined()
})

test('routeLinearIssue rule 2: a matching label routes to the rig that configured it', () => {
  const rigs = [{ name: 'acme', linear: { team: ['t'], labels: ['Area/infra'] } }]
  expect(routeLinearIssue({ project: undefined, labels: ['Area/infra', 'bug'] }, rigs)).toBe('acme')
  expect(routeLinearIssue({ project: undefined, labels: ['bug'] }, rigs)).toBeUndefined()
})

test('routeLinearIssue: the first opted-in rig, in order, wins a rule-2 tie', () => {
  const rigs = [
    { name: 'acme', linear: { team: ['t'], labels: ['Area/x'] } },
    { name: 'widget', linear: { team: ['t'], labels: ['Area/x'] } },
  ]
  expect(routeLinearIssue({ project: undefined, labels: ['Area/x'] }, rigs)).toBe('acme')
})

test('routeLinearIssue returns undefined with no match, and ignores a rig not opted in', () => {
  const rigs = [{ name: 'acme', linear: { team: ['t'], projects: ['Infra Catalog'] } }, { name: 'other' }]
  expect(routeLinearIssue({ project: 'Nowhere', labels: [] }, rigs)).toBeUndefined()
})

test('routeLinearIssue: a "[x] ..." project with no opted-in rig named x is final, never falls through to rule 2 (claude-factory-b6c.23)', () => {
  const rigs = [{ name: 'acme', linear: { team: ['t'], labels: ['Area/auth'] } }]
  // the bracket names no opted-in rig ("other"), and the issue also carries a label that rule 2
  // would otherwise route to acme. Rule 1 must still win, as "no rig": the issue stays unrouted.
  expect(routeLinearIssue({ project: '[other] auth work', labels: ['Area/auth'] }, rigs)).toBeUndefined()
})

// A fake secret-broker server.
// It answers the 3 real broker routes the loop calls.
// It records every request's headers and path.
// A test can check them. The test needs no real broker.
function fakeConnect(
  opts: { vaultTitle?: string; itemTitle?: string; fieldLabel?: string; key?: string } = {},
) {
  const {
    vaultTitle = 'test-vault',
    itemTitle = 'LinearBotsApiKey',
    fieldLabel = 'credential',
    key = 'lin_api_FAKEKEY',
  } = opts
  const requests: { path: string; headers: Record<string, string> }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requests.push({
        path: url.pathname + url.search,
        headers: {
          'x-op-token': req.headers.get('x-op-token') ?? '',
          'cf-access-client-id': req.headers.get('cf-access-client-id') ?? '',
          'cf-access-client-secret': req.headers.get('cf-access-client-secret') ?? '',
        },
      })
      if (url.pathname === '/v1/vaults') return Response.json([{ id: 'vault-1', name: vaultTitle }])
      if (url.pathname === '/v1/vaults/vault-1/items')
        return url.search.includes(encodeURIComponent(itemTitle).replace(/%20/g, '+')) ||
          url.search.includes(itemTitle)
          ? Response.json([{ id: 'item-1', title: itemTitle }])
          : Response.json([])
      if (url.pathname === '/v1/vaults/vault-1/items/item-1')
        return Response.json({ fields: [{ label: fieldLabel, value: key }] })
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: server.url.toString().replace(/\/$/, ''),
    vault: vaultTitle,
    requests,
    stop: () => server.stop(true),
  }
}

test('resolveConnectCreds reads all 5 values from the environment, with no default host or vault', () => {
  const creds = resolveConnectCreds({
    OP_CONNECT_HOST: 'https://example.invalid',
    OP_CONNECT_VAULT: 'test-vault',
    OP_CONNECT_TOKEN: 'tok',
    CF_ACCESS_CLIENT_ID: 'cfid',
    CF_ACCESS_CLIENT_SECRET: 'cfsecret',
  })
  expect(creds).toEqual({
    host: 'https://example.invalid',
    vault: 'test-vault',
    token: 'tok',
    cfId: 'cfid',
    cfSecret: 'cfsecret',
  })
})

test('resolveConnectCreds fails with the setup message when OP_CONNECT_HOST or OP_CONNECT_VAULT is missing, even with the 3 header values set', () => {
  const headers = { OP_CONNECT_TOKEN: 'tok', CF_ACCESS_CLIENT_ID: 'i', CF_ACCESS_CLIENT_SECRET: 's' }
  expect(() => resolveConnectCreds({ ...headers, OP_CONNECT_VAULT: 'test-vault' })).toThrow(
    CONNECT_SETUP_HELP,
  )
  expect(() => resolveConnectCreds({ ...headers, OP_CONNECT_HOST: 'https://example.invalid' })).toThrow(
    CONNECT_SETUP_HELP,
  )
})

test('resolveConnectCreds with none of the 3 header values set fails with the setup message, no interactive op', () => {
  // FACTORY_NO_KEYCHAIN=1 skips the real Keychain lookup. A dev machine, or this factory's own, can
  // hold a real "claude-factory" Keychain entry (the person's one-time setup); this test must never
  // read it, so a real token can never reach this test's own output on a failed assertion.
  expect(() =>
    resolveConnectCreds({
      OP_CONNECT_HOST: 'https://example.invalid',
      OP_CONNECT_VAULT: 'test-vault',
      FACTORY_NO_KEYCHAIN: '1',
    }),
  ).toThrow(CONNECT_SETUP_HELP)
})

test('resolveLinearApiKey sends all 3 headers on every request, and finds the vault, item and field by name', async () => {
  const fake = fakeConnect()
  try {
    const creds = { host: fake.url, vault: fake.vault, token: 'tok', cfId: 'cfid', cfSecret: 'cfsecret' }
    const key = await resolveLinearApiKey(creds)
    expect(key).toBe('lin_api_FAKEKEY')
    expect(fake.requests.length).toBeGreaterThanOrEqual(3) // vaults, items, item
    for (const r of fake.requests)
      expect(r.headers).toEqual({
        'x-op-token': 'tok',
        'cf-access-client-id': 'cfid',
        'cf-access-client-secret': 'cfsecret',
      })
  } finally {
    fake.stop()
  }
})

test('resolveLinearApiKey caches the vault and item id, not the key: a second call makes 1 request, not 3', async () => {
  const fake = fakeConnect()
  try {
    const creds = { host: fake.url, vault: fake.vault, token: 'tok', cfId: 'cfid', cfSecret: 'cfsecret' }
    const cache: ConnectCache = {}
    await resolveLinearApiKey(creds, cache)
    const after1 = fake.requests.length
    await resolveLinearApiKey(creds, cache)
    expect(fake.requests.length).toBe(after1 + 1) // only the item fetch: vault and item id came from cache
    expect(cache).toEqual({ vaultId: 'vault-1', itemId: 'item-1' })
  } finally {
    fake.stop()
  }
})

test('resolveLinearApiKey fails with a generic message, naming neither the vault nor its own title, when the vault is not found', async () => {
  const fake = fakeConnect({ vaultTitle: 'some-other-vault' })
  try {
    const creds = { host: fake.url, vault: 'test-vault', token: 'tok', cfId: 'cfid', cfSecret: 'cfsecret' }
    await expect(resolveLinearApiKey(creds)).rejects.toThrow(
      'secret broker: the configured vault was not found',
    )
    try {
      await resolveLinearApiKey(creds)
      throw new Error('did not throw')
    } catch (err) {
      expect((err as Error).message).not.toContain('test-vault')
      expect((err as Error).message).not.toContain('some-other-vault')
    }
  } finally {
    fake.stop()
  }
})

test('resolveLinearApiKey refuses a redirect from the secret broker, and never calls the redirect target (claude-factory-b6c.28)', async () => {
  let targetCalls = 0
  const target = Bun.serve({
    port: 0,
    fetch() {
      targetCalls++
      return Response.json([{ id: 'vault-1', name: 'test-vault' }])
    },
  })
  const broker = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/v1/vaults') return Response.redirect(`${target.url}v1/vaults`, 302)
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const creds = { host: broker.url.toString(), vault: 'test-vault', token: 't', cfId: 'i', cfSecret: 's' }
    await expect(resolveLinearApiKey(creds)).rejects.toThrow()
    try {
      await resolveLinearApiKey(creds)
      throw new Error('did not throw')
    } catch (err) {
      // the error must name neither server's own URL (claude-factory-b6c.28, same rule as .14)
      expect((err as Error).message).not.toContain(broker.url.toString())
      expect((err as Error).message).not.toContain(target.url.toString())
    }
    expect(targetCalls).toBe(0) // the redirect was never followed: the broker's secret headers never left it
  } finally {
    broker.stop(true)
    target.stop(true)
  }
})

test('syncEnv sets LINEAR_API_KEY and LINEAR_TEAM_IDS, dropping every inherited LINEAR_* first (claude-factory-b6c.20)', () => {
  const base = {
    LINEAR_API_KEY: 'stale',
    LINEAR_OAUTH_CLIENT_ID: 'stale-id',
    LINEAR_OAUTH_CLIENT_SECRET: 'stale-secret',
    LINEAR_TEAM_ID: 'stale-team',
    LINEAR_TEAM_IDS: 'stale-team-1,stale-team-2',
    PATH: process.env.PATH,
  }
  const env = syncEnv('test-key-123', ['team-1', 'team-2'], base)
  expect(env.LINEAR_API_KEY).toBe('test-key-123')
  expect(env.LINEAR_TEAM_IDS).toBe('team-1,team-2')
  expect(env.LINEAR_OAUTH_CLIENT_ID).toBeUndefined()
  expect(env.LINEAR_OAUTH_CLIENT_SECRET).toBeUndefined()
  expect(env.LINEAR_TEAM_ID).toBeUndefined()
  expect(env.PATH).toBe(process.env.PATH)
})

// A fake Linear GraphQL endpoint, in-process (safe here: nothing in this test uses Bun.spawnSync,
// so this process keeps serving its own event loop between requests). `pages` with more entries
// than `fetchLinearIssues`'s own 50-page cap lets a test force a truncated listing.
function fakeLinearApi(pages: { ref: string; updatedAt?: string; project?: string; labels: string[] }[][]) {
  const requests: { authorization: string | null; variables: Record<string, unknown> }[] = []
  let call = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { variables: Record<string, unknown> }
      requests.push({ authorization: req.headers.get('authorization'), variables: body.variables })
      const page = pages[call] ?? pages[pages.length - 1]!
      call++
      return Response.json({
        data: {
          issues: {
            nodes: page.map(i => ({
              identifier: i.ref,
              updatedAt: i.updatedAt ?? '2026-01-01T00:00:00.000Z',
              project: i.project ? { name: i.project } : null,
              labels: { nodes: i.labels.map(name => ({ name })) },
            })),
            pageInfo: { hasNextPage: call < pages.length, endCursor: `c${call}` },
          },
        },
      })
    },
  })
  return { url: server.url.toString(), requests, stop: () => server.stop(true) }
}

test('fetchLinearIssues sends the raw key as the Authorization header (no Bearer prefix) and follows pageInfo across pages', async () => {
  const fake = fakeLinearApi([
    [{ ref: 'A-1', updatedAt: '2026-01-01T00:00:00.000Z', project: '[acme] p', labels: [] }],
    [{ ref: 'A-2', updatedAt: '2026-01-02T00:00:00.000Z', labels: ['Area/x'] }],
  ])
  try {
    const { issues, truncated } = await fetchLinearIssues('test-key', ['team-1'], fake.url)
    expect(issues).toEqual([
      { ref: 'A-1', updatedAt: '2026-01-01T00:00:00.000Z', project: '[acme] p', labels: [] },
      { ref: 'A-2', updatedAt: '2026-01-02T00:00:00.000Z', project: undefined, labels: ['Area/x'] },
    ])
    expect(truncated).toBe(false)
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[0]!.authorization).toBe('test-key')
    expect(fake.requests[0]!.authorization).not.toContain('Bearer')
    expect((fake.requests[1]!.variables as { after?: string }).after).toBe('c1')
  } finally {
    fake.stop()
  }
})

test('fetchLinearIssues reports truncated when a team has more than 50 pages (claude-factory-b6c.24)', async () => {
  const pages = Array.from({ length: 51 }, (_, i) => [{ ref: `A-${i}`, labels: [] }])
  const fake = fakeLinearApi(pages)
  try {
    const { issues, truncated } = await fetchLinearIssues('test-key', ['team-1'], fake.url)
    expect(truncated).toBe(true)
    expect(issues).toHaveLength(50) // the cap: it reads exactly 50 pages, never the 51st
  } finally {
    fake.stop()
  }
})

test('fetchLinearIssues refuses a redirect from the Linear API, and never calls the redirect target (claude-factory-b6c.28)', async () => {
  let targetCalls = 0
  const target = Bun.serve({
    port: 0,
    fetch() {
      targetCalls++
      return Response.json({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: '' } } },
      })
    },
  })
  const api = Bun.serve({ port: 0, fetch: () => Response.redirect(target.url.toString(), 302) })
  try {
    await expect(fetchLinearIssues('test-key', ['team-1'], api.url.toString())).rejects.toThrow()
    expect(targetCalls).toBe(0) // the redirect was never followed: the Authorization header never left the API's own host
  } finally {
    api.stop(true)
    target.stop(true)
  }
})

test('fetchLinearIssues refuses an identifier not shaped <KEY>-<n>, instead of passing it through (claude-factory-b6c.29)', async () => {
  const fake = fakeLinearApi([[{ ref: '--force', project: '[a]', labels: [] }]])
  try {
    await expect(fetchLinearIssues('test-key', ['team-1'], fake.url)).rejects.toThrow('--force')
  } finally {
    fake.stop()
  }
})

test('parseSync reads a real pull and an engine error, the two shapes "bd linear pull" prints', () => {
  expect(
    parseSync(
      '{"stats":{"pulled":3,"pushed":0,"created":2,"updated":1,"skipped":0,"errors":0,"conflicts":0},"warnings":[],"is_fresh":true,"skipped":false}',
      0,
    ),
  ).toEqual({ pulled: 3, created: 2, updated: 1 })
  expect(parseSync('{"error":"dial tcp 127.0.0.1:3308: i/o timeout"}', 1)).toEqual({
    error: 'dial tcp 127.0.0.1:3308: i/o timeout',
  })
})

test('parseSync treats a pull with skipped or errored refs as a failure, even on exit 0 (claude-factory-b6c.21)', () => {
  expect(
    parseSync(
      '{"stats":{"pulled":0,"pushed":0,"created":0,"updated":0,"skipped":2,"errors":0,"conflicts":0},"warnings":["issue not found"],"is_fresh":true,"skipped":false}',
      0,
      'Warning: issue not found: X-9\nWarning: issue not found: X-10',
    ),
  ).toEqual({ error: 'Warning: issue not found: X-9' })
  expect(
    parseSync(
      '{"stats":{"pulled":1,"pushed":0,"created":1,"updated":0,"skipped":0,"errors":1,"conflicts":0},"warnings":[],"is_fresh":true,"skipped":false}',
      0,
    ),
  ).toEqual({ error: 'bd linear pull: skipped 0, errors 1' }) // no stderr Warning line: falls back to a count
})

test('parseSync treats a nonzero exit with no parseable error field as an error too', () => {
  expect(parseSync('not json', 1)).toMatchObject({ error: expect.any(String) })
  expect(parseSync('{"stats":{}}', 1)).toMatchObject({ error: expect.any(String) })
})

test('parseSync falls back to stderr when stdout has no usable detail', () => {
  expect(parseSync('', 1, 'panic: dial tcp timeout\nmore lines')).toEqual({
    error: 'panic: dial tcp timeout',
  })
  expect(parseSync('{"stats":{}}', 1, 'panic: dial tcp timeout')).toEqual({
    error: 'bd linear pull exited 1: panic: dial tcp timeout',
  })
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

test('redact scrubs a lin_api_ or lin_oauth_ token the secrets list never learned (security#1.14)', () => {
  // syncEnv can throw before it resolves a value (the config command failed): `secrets` stays empty,
  // or misses the OAuth client id, even though the failing command's own stderr can carry a token.
  expect(redact('linear.json command failed: rejected lin_api_SURPRISE999', [])).not.toContain(
    'lin_api_SURPRISE999',
  )
  expect(redact('bad token lin_oauth_zzz999 in request', [])).not.toContain('lin_oauth_zzz999')
})

test('redact strips control characters, like an ANSI escape, from the text (security#1.15)', () => {
  const out = redact('\x1b[31mBOOM\x1b[0m\x07', [])
  expect(out).not.toMatch(/[\x00-\x1f\x7f]/)
  expect(out).toContain('BOOM')
})

// These tests run the loop end to end, through `bin/factory linear`.
// A fake `bd` on PATH logs every call's argv, cwd and LINEAR_* env.
// So these tests check the real loop (src/cli.ts's linearPass), not a mock of it.
//
// `factory(...)` below runs the CLI with `Bun.spawnSync`. This call blocks the test file's own
// event loop until the child exits. `fakeConnect` and `fakeLinearApi` (an in-process `Bun.serve`,
// used above for the pure unit tests) would deadlock here. The reason: the spawned `factory`
// process sends a `fetch` call back to this process. This process must run its event loop to
// answer that call. But `Bun.spawnSync` has already blocked that loop. `fakeConnectProcess` and
// `fakeLinearProcess` below avoid this. Each runs its fake server in its own OS process, so it
// keeps answering requests while `Bun.spawnSync` blocks this process.
import { afterAll, beforeEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The broker fake from `fakeConnect`, run as its own process via `bun -e`. See the note above. */
async function fakeConnectProcess(opts: { vaultTitle?: string; key?: string } = {}) {
  const { vaultTitle = 'test-vault', key = 'lin_api_FAKEKEY' } = opts
  const script = `
    const vaultTitle = ${JSON.stringify(vaultTitle)}
    const itemTitle = 'LinearBotsApiKey'
    const key = ${JSON.stringify(key)}
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/v1/vaults') return Response.json([{ id: 'vault-1', name: vaultTitle }])
        if (url.pathname === '/v1/vaults/vault-1/items')
          return url.search.includes(itemTitle) || url.search.includes(encodeURIComponent(itemTitle))
            ? Response.json([{ id: 'item-1', title: itemTitle }])
            : Response.json([])
        if (url.pathname === '/v1/vaults/vault-1/items/item-1')
          return Response.json({ fields: [{ label: 'credential', value: key }] })
        return new Response('not found', { status: 404 })
      },
    })
    console.log(server.port)
    await new Promise(() => {}) // stay alive until killed
  `
  const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const { value } = await proc.stdout.getReader().read()
  const port = new TextDecoder().decode(value).trim()
  return { url: `http://127.0.0.1:${port}`, vault: vaultTitle, stop: () => proc.kill() }
}

/**
 * A fake Linear GraphQL endpoint, run as its own process via `bun -e`. See the note above.
 * It re-reads `issuesFile` (JSON, an array of `{ref, updatedAt?, project?, labels}`) on every
 * request, so a test can change the fixture between `factory(...)` calls. It always answers one
 * page (`hasNextPage: false`) and ignores the query's team filter: `routeLinearIssue` is already
 * unit tested above, so these end-to-end tests only need to exercise the wiring. `updatedAt`
 * defaults to a fixed past date, old enough that the incremental cutoff (claude-factory-b6c.24)
 * excludes it once a rig has one good pull on record; a test that needs a fresh issue sets its own.
 */
async function fakeLinearProcess(issuesFile: string) {
  const script = `
    const fs = require('node:fs')
    const issuesFile = ${JSON.stringify(issuesFile)}
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const issues = JSON.parse(fs.readFileSync(issuesFile, 'utf8'))
        return Response.json({
          data: {
            issues: {
              nodes: issues.map(i => ({
                identifier: i.ref,
                updatedAt: i.updatedAt ?? '2026-01-01T00:00:00.000Z',
                project: i.project ? { name: i.project } : null,
                labels: { nodes: (i.labels ?? []).map(name => ({ name })) },
              })),
              pageInfo: { hasNextPage: false, endCursor: '' },
            },
          },
        })
      },
    })
    console.log(server.port)
    await new Promise(() => {}) // stay alive until killed
  `
  const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const { value } = await proc.stdout.getReader().read()
  const port = new TextDecoder().decode(value).trim()
  return { url: `http://127.0.0.1:${port}/graphql`, stop: () => proc.kill() }
}

/**
 * This is a fake Linear GraphQL endpoint (claude-factory-b6c.22). It never answers a request for
 * one team id, `hangTeam`. It answers every other team's request at once, from `fastIssues`. It
 * reads the request body's own team filter. `fakeLinearProcess` above does not. A test can use
 * this to prove a timeout on one rig's fetch does not stall another rig's own fetch and pull.
 */
async function fakeLinearProcessSlow(hangTeam: string, fastIssues: { ref: string; project?: string }[]) {
  const script = `
    const hangTeam = ${JSON.stringify(hangTeam)}
    const fastIssues = ${JSON.stringify(fastIssues)}
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json()
        const teams = body?.variables?.filter?.team?.id?.in ?? []
        if (teams.includes(hangTeam)) return await new Promise(() => {}) // never answers
        return Response.json({
          data: {
            issues: {
              nodes: fastIssues.map(i => ({
                identifier: i.ref,
                updatedAt: '2026-10-16T00:00:00.000Z',
                project: i.project ? { name: i.project } : null,
                labels: { nodes: [] },
              })),
              pageInfo: { hasNextPage: false, endCursor: '' },
            },
          },
        })
      },
    })
    console.log(server.port)
    await new Promise(() => {}) // stay alive until killed
  `
  const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const { value } = await proc.stdout.getReader().read()
  const port = new TextDecoder().decode(value).trim()
  return { url: `http://127.0.0.1:${port}/graphql`, stop: () => proc.kill() }
}

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const cdir = join(tmpdir(), `linear-cli-${process.pid}`)
const home = join(cdir, 'home')
const bin = join(cdir, 'bin')
const calls = join(cdir, 'calls.log')
const mode = join(cdir, 'mode') // pulled | error, read by the fake bd's `linear pull`
const listTurn = join(cdir, 'list-turn') // counts `bd list` calls, so before/after differ
const failLabel = join(cdir, 'fail-label') // an id `bd label remove` exits 1 for, when this file names it
const listFailTurns = join(cdir, 'list-fail-turns') // comma-joined `bd list` turn numbers that exit 1
const readyFlag = join(cdir, 'ready-has-acme-new') // makes `bd ready --label factory` list acme-new too
const linearIssuesFile = join(cdir, 'linear-issues.json') // fixture fakeLinearProcess reads

const TEAM = '04114abf-ddb7-4a6f-bb47-814fd2c44373'
const repoA = join(cdir, 'repo-a')
const repoB = join(cdir, 'repo-b')
// the default fixture (one issue, project "[a]"): rule 1 routes it to a rig named "a" with no
// other config, so every pre-existing test below keeps working with only its `writeRigs` call
// changed from `linear: [TEAM]` to `linear: { team: [TEAM] }`.
const DEFAULT_REF = 'A-1'
const defaultIssues = () => [{ ref: DEFAULT_REF, project: '[a]', labels: [] }]

const connect = await fakeConnectProcess({ key: 'test-key-123' })
const linearApi = await fakeLinearProcess(linearIssuesFile)
afterAll(() => {
  rmSync(cdir, { recursive: true, force: true })
  connect.stop()
  linearApi.stop()
})

const factory = (args: string[], env: Record<string, string> = {}) => {
  const { FACTORY_OUTBOX, FACTORY_FROM, ...laptop } = process.env
  const p = Bun.spawnSync([CLI, ...args], {
    env: {
      ...laptop,
      FACTORY_HOME: home,
      PATH: `${bin}:${laptop.PATH}`,
      FACTORY_SELF_UPDATE: '0',
      // FACTORY_NO_KEYCHAIN=1: this spawned `factory` process must never read the real macOS
      // Keychain. This machine, or any dev machine, can hold a real "claude-factory" Keychain entry
      // (the person's one-time setup); a real token must never reach these tests, or their output.
      FACTORY_NO_KEYCHAIN: '1',
      OP_CONNECT_HOST: connect.url,
      OP_CONNECT_VAULT: connect.vault,
      OP_CONNECT_TOKEN: 'tok',
      CF_ACCESS_CLIENT_ID: 'cfid',
      CF_ACCESS_CLIENT_SECRET: 'cfsecret',
      LINEAR_API_URL: linearApi.url,
      ...env,
    },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
/** the args for a `factory(...)` call that has none of the 3 header env values set */
const noConnectEnv = { OP_CONNECT_TOKEN: '', CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' }

/**
 * This is the fake bd. It answers each call this way:
 * - `linear pull`, with no `LINEAR_TEAM_IDS` (and no `LINEAR_TEAM_ID`) set: exits 1, "no Linear
 *   team ID configured" (the real bd 1.3.0 message, claude-factory-b6c.20).
 * - `linear pull <ref...>`, with the team env set: a ref that is not shaped `<KEY>-<n>` (for
 *   example a URL) counts in `stats.skipped`, exits 0, with a `Warning: issue not found` line on
 *   stderr for each one (claude-factory-b6c.19, claude-factory-b6c.21). With every ref shaped
 *   `<KEY>-<n>`, it answers from $mode instead: `pulled` (a clean pull), `skipped` (every ref
 *   valid, but bd still counts 2 as skipped, exit 0: a partial failure with no bad ref), or
 *   `error` (an engine error, exit 1).
 * - `list`, turn 1: `[{"id":"acme-old"}]`. No bead carries the label yet.
 * - `list`, turn 2 on: adds `acme-new`. The strip step then has one new id to act on.
 * - `list`, a turn named in $listFailTurns (comma-joined): exits 1, names the turn in stderr.
 * - `label remove`: exits 1 for the id named in $failLabel, exits 0 for every other call.
 * - `ready`: `[{"id":"acme-new"}]` when $readyFlag exists (acme-new really still carries the label,
 *   as a pull would leave it), else `[]`. Used only by dispatch() tests (claude-factory-b6c.16).
 * - `children`: `[]`, always (no bead here has one).
 * Every call logs one line: its argv, its cwd, and the LINEAR_* env vars it saw (empty when unset).
 */
function fakeBd() {
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    `echo "ARGV|$*|CWD|$(pwd)|KEY|${'$'}{LINEAR_API_KEY}|OAUTHID|${'$'}{LINEAR_OAUTH_CLIENT_ID}|OAUTHSECRET|${'$'}{LINEAR_OAUTH_CLIENT_SECRET}|TEAMIDS|${'$'}{LINEAR_TEAM_IDS}" >> ${calls}`,
    'case "$1" in',
    '  linear)',
    '    case "$2" in',
    '      pull)',
    `        if [ -z "${'$'}{LINEAR_TEAM_IDS}${'$'}{LINEAR_TEAM_ID}" ]; then`,
    '          echo "no Linear team ID configured" >&2',
    '          printf \'%s\' \'{"error":"no Linear team ID configured"}\'',
    '          exit 1',
    '        fi',
    '        shift 2',
    '        bad=0',
    '        for a in "$@"; do',
    '          [ "$a" = "--json" ] && continue',
    '          case "$a" in',
    '            */*) bad=$((bad + 1));;',
    '            *) echo "$a" | grep -Eq \'^[A-Za-z0-9]+-[0-9]+$\' || bad=$((bad + 1));;',
    '          esac',
    '        done',
    '        if [ "$bad" -gt 0 ]; then',
    '          echo "Warning: issue not found" >&2',
    '          printf \'{"stats":{"pulled":0,"pushed":0,"created":0,"updated":0,"skipped":%s,"errors":0,"conflicts":0},"warnings":["issue not found"],"is_fresh":true,"skipped":false}\' "$bad"',
    '          exit 0',
    '        fi',
    `        m=$(cat ${mode} 2>/dev/null || echo pulled)`,
    '        case "$m" in',
    '          pulled) printf \'%s\' \'{"stats":{"pulled":2,"pushed":0,"created":1,"updated":1,"skipped":0,"errors":0,"conflicts":0},"warnings":[],"is_fresh":true,"skipped":false}\';;',
    '          skipped) echo "Warning: issue not found: X-9" >&2; printf \'%s\' \'{"stats":{"pulled":0,"pushed":0,"created":0,"updated":0,"skipped":2,"errors":0,"conflicts":0},"warnings":["issue not found"],"is_fresh":true,"skipped":false}\';;',
    '          error) echo "dial tcp 127.0.0.1:3308: i/o timeout, key test-key-123" >&2; printf \'%s\' \'{"error":"dial tcp 127.0.0.1:3308: i/o timeout, key test-key-123"}\'; exit 1;;',
    '        esac;;',
    '      *) exit 0;;',
    '    esac;;',
    '  list)',
    `    n=$(cat ${listTurn} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${listTurn}`,
    `    ft=$(cat ${listFailTurns} 2>/dev/null || echo "")`,
    '    case ",$ft," in',
    '      *",$n,"*) echo "list failed (turn $n)" >&2; exit 1;;',
    '    esac',
    '    case "$n" in',
    '      1) printf \'%s\' \'[{"id":"acme-old"}]\';;',
    '      *) printf \'%s\' \'[{"id":"acme-old"},{"id":"acme-new"}]\';;',
    '    esac;;',
    '  label)',
    `    f=$(cat ${failLabel} 2>/dev/null || echo "")`,
    '    [ "$2" = "remove" ] && [ -n "$f" ] && [ "$3" = "$f" ] && exit 1',
    '    exit 0;;',
    '  ready)',
    `    if [ -f ${readyFlag} ]; then printf '%s' '[{"id":"acme-new"}]'; else printf '%s' '[]'; fi;;`,
    '  children)',
    "    printf '%s' '[]';;",
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

function reset() {
  rmSync(cdir, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(repoA, { recursive: true })
  mkdirSync(repoB, { recursive: true })
  fakeBd()
  writeFileSync(mode, 'pulled')
  writeFileSync(linearIssuesFile, JSON.stringify(defaultIssues()))
}

const callLines = () =>
  existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []
const argvOf = (line: string) => line.split('|')[1]!
const cwdOf = (line: string) => line.split('|')[3]!
const keyOf = (line: string) => line.split('|')[5]!
const teamIdsOf = (line: string) => line.split('|')[11]!

beforeEach(reset)

test("linearPass pulls each opted-in rig's routed issues only, by identifier, never --push, cwd the rig repo", () => {
  writeRigs([
    { name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } },
    { name: 'b', repo: repoB, factory: 'lifecycle' }, // not opted in: no Linear call at all
  ])
  const out = factory(['linear'])
  expect(out.code).toBe(0)
  const pullCalls = callLines().filter(l => argvOf(l).startsWith('linear pull'))
  expect(pullCalls).toHaveLength(1)
  expect(argvOf(pullCalls[0]!)).toBe(`linear pull ${DEFAULT_REF} --json`)
  expect(argvOf(pullCalls[0]!)).not.toContain('--push')
  expect(argvOf(pullCalls[0]!)).not.toContain('://') // a Linear identifier, never a URL (claude-factory-b6c.19)
  expect(cwdOf(pullCalls[0]!)).toEndWith('/repo-a')
  expect(callLines().some(l => cwdOf(l).endsWith('/repo-b'))).toBe(false)
})

test("bd gets the rig's own team ids by LINEAR_TEAM_IDS, dropping an inherited stale value (claude-factory-b6c.20)", () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  const out = factory(['linear'], { LINEAR_TEAM_IDS: 'stale-team-id' })
  expect(out.code).toBe(0)
  const pullCall = callLines().find(l => argvOf(l).startsWith('linear pull'))!
  expect(teamIdsOf(pullCall)).toBe(TEAM)
  expect(teamIdsOf(pullCall)).not.toContain('stale-team-id')
})

test('the key reaches bd only by env, on the pull call; list/label calls carry no key at all', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  factory(['linear'])
  const pullCall = callLines().find(l => argvOf(l).startsWith('linear pull'))!
  expect(keyOf(pullCall)).toBe('test-key-123')
  expect(argvOf(pullCall)).not.toContain('test-key-123')
  for (const l of callLines().filter(l => !argvOf(l).startsWith('linear pull'))) expect(keyOf(l)).toBe('')
})

test('a rig pulls at most once per 20 min; --force pulls again right away', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  factory(['linear'])
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1)
  factory(['linear']) // too soon: no second call
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1)
  factory(['linear', '--force'])
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(2)
})

test('after a pull, only the bead newly labeled factory loses the label; one already labeled keeps it', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  factory(['linear'])
  const removes = callLines().filter(l => argvOf(l).startsWith('label remove'))
  expect(removes).toHaveLength(1)
  expect(argvOf(removes[0]!)).toBe('label remove acme-new factory')
})

test('the Linear pull loop never runs for a rig with no secret-broker credentials: it errors with the setup message, and bd is never called (claude-factory-b6c.17)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  const out = factory(['linear'], noConnectEnv) // no env, and this worker's Keychain has no entry either
  expect(out.out).toContain('secret-broker credentials')
  expect(out.out).toContain('docs/beads.md')
  expect(callLines()).toHaveLength(0)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.error).toContain('docs/beads.md')
})

test('a pull error is recorded redacted (no secret value) and clipped, in linear-sync.json', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(mode, 'error')
  factory(['linear'])
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.error).toBeTruthy()
  expect(state.a.error).not.toContain('test-key-123')
  expect(state.a.error.length).toBeLessThanOrEqual(201)
})

test('an issue identifier not shaped <KEY>-<n> never reaches bd argv; the pass records an error instead (claude-factory-b6c.29)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(linearIssuesFile, JSON.stringify([{ ref: '--force', project: '[a]', labels: [] }]))
  const out = factory(['linear'])
  expect(out.code).toBe(0) // the loop itself still exits 0: the failure is this rig's own recorded state
  expect(callLines().some(l => argvOf(l).startsWith('linear pull'))).toBe(false) // never reached bd at all
  expect(callLines().every(l => !argvOf(l).includes('--force'))).toBe(true)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.error).toBeTruthy()
  expect(state.a.error).toContain('--force')
})

test('a pull that reports skipped or errored refs, with exit 0, is recorded as a failure, not a silent "pulled 0" (claude-factory-b6c.21)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(mode, 'skipped') // the fake bd: every ref valid, stats.skipped=2, exit 0 (see fakeBd's doc comment)
  const out = factory(['linear'])
  expect(out.code).toBe(0) // the loop itself still exits 0: the failure is this rig's own recorded state
  const pullCalls = callLines().filter(l => argvOf(l).startsWith('linear pull'))
  expect(pullCalls).toHaveLength(1) // bd really ran and really answered exit 0
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.error).toBeTruthy()
  expect(state.a.error).toContain('issue not found')
  expect(state.a.pulled).toBeUndefined() // never reported as a successful pull
})

test('a pull error still strips a bead the pull newly labeled before it erred (claude-factory-b6c.8)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(mode, 'error')
  factory(['linear'])
  const removes = callLines().filter(l => argvOf(l).startsWith('label remove'))
  expect(removes).toHaveLength(1)
  expect(argvOf(removes[0]!)).toBe('label remove acme-new factory')
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.error).toBeTruthy()
  expect(state.a.unstripped).toBeUndefined() // the strip succeeded: nothing left to retry
})

test('a bead whose label remove fails is queued and retried first next pass (claude-factory-b6c.9)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(failLabel, 'acme-new')
  factory(['linear'])
  let state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.unstripped).toEqual(['acme-new']) // the attempt failed: recorded, not counted as stripped
  expect(state.a.stripped).toBe(0)

  rmSync(failLabel, { force: true })
  factory(['linear', '--force'])
  const removes = callLines().filter(l => argvOf(l).startsWith('label remove acme-new'))
  expect(removes.length).toBeGreaterThanOrEqual(2) // the failed attempt, then the retry
  state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.unstripped).toBeUndefined()
  expect(state.a.stripped).toBeGreaterThanOrEqual(1)
})

test('a post-pull listing that still fails after one retry keeps the pre-pull before-set as a baseline; the next pass strips the bead it missed (security#1.13)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  // turn 1 is the pre-pull before-list. Turns 2 and 3 are the post-pull listing's first try and its one
  // retry: both fail. The pass cannot confirm acme-new as newly labeled, so it must not strip it, and it
  // must not drop the fact that it still owes that check.
  writeFileSync(listFailTurns, '2,3')
  factory(['linear'])
  let state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.baseline).toEqual(['acme-old'])
  expect(callLines().some(l => argvOf(l).startsWith('label remove'))).toBe(false)

  // the next pass: the listing now succeeds. Pre-fix code takes a fresh before-snapshot here, which
  // already includes acme-new, so the diff finds nothing new and acme-new keeps the factory label
  // forever. The fix diffs against the stored baseline instead, so acme-new is still "newly labeled".
  factory(['linear', '--force'])
  const removes = callLines().filter(l => argvOf(l).startsWith('label remove'))
  expect(removes).toHaveLength(1)
  expect(argvOf(removes[0]!)).toBe('label remove acme-new factory')
  state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.baseline).toBeUndefined() // the listing resolved: nothing left to carry
  expect(state.a.stripped).toBe(1)
})

test('a rig with no routed issues pulls nothing, calls bd not at all, and records the unrouted count', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(linearIssuesFile, JSON.stringify([{ ref: 'A-9', project: '[nowhere]', labels: [] }]))
  factory(['linear'])
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.pulled).toBe(0)
  expect(state.a.unrouted).toBe(1)
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(0)
  expect(callLines().some(l => argvOf(l).startsWith('label remove'))).toBe(false)
})

test('the loop routes each issue to at most one opted-in rig, by bracket prefix or configured project/label, and counts the rest as unrouted (claude-factory-b6c.18)', () => {
  writeRigs([
    {
      name: 'acme',
      repo: repoA,
      factory: 'lifecycle',
      linear: { team: [TEAM], projects: ['Infra Catalog'] },
    },
    { name: 'widget', repo: repoB, factory: 'lifecycle', linear: { team: [TEAM], labels: ['Area/widget'] } },
  ])
  writeFileSync(
    linearIssuesFile,
    JSON.stringify([
      { ref: 'A-1', project: '[acme] bracket rule', labels: [] }, // rule 1 -> acme
      { ref: 'A-2', project: 'Infra Catalog', labels: [] }, // rule 2 project -> acme
      { ref: 'A-3', labels: ['Area/widget'] }, // rule 2 label -> widget
      { ref: 'A-4', project: 'Nowhere', labels: [] }, // unrouted
    ]),
  )
  factory(['linear', '--force'])
  const acmePull = callLines().find(l => cwdOf(l).endsWith('/repo-a') && argvOf(l).startsWith('linear pull'))!
  const widgetPull = callLines().find(
    l => cwdOf(l).endsWith('/repo-b') && argvOf(l).startsWith('linear pull'),
  )!
  expect(argvOf(acmePull)).toBe('linear pull A-1 A-2 --json')
  expect(argvOf(widgetPull)).toBe('linear pull A-3 --json')
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.acme.unrouted).toBe(1)
  expect(state.widget.unrouted).toBe(1)
})

test("rig list shows a Linear-opted rig's last pull count, or its error (claude-factory-b6c.5)", () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(
    join(home, 'linear-sync.json'),
    JSON.stringify({ a: { at: Date.now(), pulled: 3, created: 1, updated: 2, stripped: 0, unrouted: 1 } }),
  )
  const pulled = factory(['rig', 'list'])
  expect(pulled.out).toContain(`linear: team ${TEAM} (pulled 3, unrouted 1,`)

  writeFileSync(join(home, 'linear-sync.json'), JSON.stringify({ a: { at: Date.now(), error: 'boom' } }))
  const erred = factory(['rig', 'list'])
  expect(erred.out).toContain(`linear: team ${TEAM} (error`)
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
    { name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } },
    { name: 'b', repo: repoB, factory: 'lifecycle' }, // not opted in: no linearSync at all
  ])
  blockBeadsKick()
  const state = { at: Date.now(), pulled: 2, created: 1, updated: 1, stripped: 0, unrouted: 0 }
  writeSyncState({ a: state })
  const out = tickJson()
  expect(out.rigs.find((r: { name: string }) => r.name === 'a').linearSync).toEqual(state)
  expect(out.rigs.find((r: { name: string }) => r.name === 'b').linearSync).toBeUndefined()
})

test('a failing rig mails the manager once; the same error again mails nothing more; success then failure mails again', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  blockBeadsKick()
  const linearMailOf = (out: { manager: { from: string; text: string; run: string }[] }) =>
    out.manager.filter(m => m.from === 'linear')

  writeSyncState({ a: { at: Date.now(), error: 'boom' } })
  const first = linearMailOf(tickJson())
  expect(first).toHaveLength(1)
  expect(first[0]!.run).toBe('factory')
  expect(first[0]!.text).toContain('boom')

  const second = linearMailOf(tickJson()) // the same error, unchanged: no second mail
  expect(second).toHaveLength(0)

  // a success since the last mail clears the told state
  writeSyncState({ a: { at: Date.now(), pulled: 1, created: 0, updated: 0, stripped: 0 } })
  const third = linearMailOf(tickJson())
  expect(third).toHaveLength(0)

  writeSyncState({ a: { at: Date.now(), error: 'boom2' } }) // a new error after a success
  const fourth = linearMailOf(tickJson())
  expect(fourth).toHaveLength(1)
  expect(fourth[0]!.text).toContain('boom2')
})

test('factory beads runs the Linear pass too, not only factory linear (claude-factory-b6c.11)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  factory(['beads'])
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.pulled).toBe(2)
})

test("factory linear holds beads.lock, so it never races a tick's beadsPass (claude-factory-b6c.10)", () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  blockBeadsKick() // simulates a live beadsPass already holding the lock
  const out = factory(['linear'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('beads.lock')
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(0)
})

test('factory linear fails naming an unknown rig, and a rig not opted into the loop, writing nothing (claude-factory-b6c.12)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle' }]) // no --linear: not opted in

  const unknown = factory(['linear', 'nope'])
  expect(unknown.code).not.toBe(0)
  expect(unknown.err).toContain('no rig "nope"')

  const notOptedIn = factory(['linear', 'a'])
  expect(notOptedIn.code).not.toBe(0)
  expect(notOptedIn.err).toContain('"a"')
  expect(notOptedIn.err).toContain('not opted')

  expect(callLines()).toHaveLength(0)
})

test('factory linear fails, naming why, when the factory is halted (claude-factory-b6c.12)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(
    join(home, 'halt.json'),
    JSON.stringify({ state: 'stopping', at: Date.now(), told: {}, closed: {} }),
  )
  const out = factory(['linear'])
  expect(out.code).not.toBe(0)
  expect(out.err).toContain('stopping')
  expect(callLines()).toHaveLength(0)
})

// claude-factory-b6c.16: dispatch must fail closed on a bead a Linear pull labeled `factory`, until the
// strip confirms it removed that label. `ready` is a real bd command dispatch calls; the fake bd above
// lists `acme-new` there too, while $readyFlag exists, so these tests exercise the real dispatch() path
// through `factory beads`, not a stub of it.

test('dispatch does not start a run while a post-pull listing leaves the baseline open (claude-factory-b6c.16)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(readyFlag, '1') // acme-new is really labeled `factory`, as the pull left it
  // turn 1 is the pre-pull before-list; turns 2 and 3 are the post-pull listing and its one retry: both
  // fail, so the pass cannot learn that acme-new is newly labeled and must not treat it as confirmed safe
  writeFileSync(listFailTurns, '2,3')
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.baseline).toEqual(['acme-old'])
  // pre-fix code starts a run on acme-new here: dispatch claims the bead before the strip is confirmed
  expect(callLines().some(l => argvOf(l).startsWith('update acme-new'))).toBe(false)

  // the next pass: the listing now succeeds. The retry must resolve this with no new `linear pull` call
  // (`linearRecoverOne`, not `linearSyncOne`): the pull already ran, only the strip was unconfirmed.
  rmSync(listFailTurns, { force: true })
  factory(['beads'])
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1)
  const removes = callLines().filter(l => argvOf(l).startsWith('label remove'))
  expect(removes).toHaveLength(1)
  expect(argvOf(removes[0]!)).toBe('label remove acme-new factory')
  const state2 = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state2.a.baseline).toBeUndefined()
})

test('dispatch does not start a run on a bead a label remove failed on (claude-factory-b6c.16)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  writeFileSync(readyFlag, '1')
  writeFileSync(failLabel, 'acme-new')
  const out = factory(['beads'])
  expect(out.code).toBe(0)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.unstripped).toEqual(['acme-new'])
  expect(callLines().some(l => argvOf(l).startsWith('update acme-new'))).toBe(false)

  // the next pass: the label remove now succeeds, with no new `linear pull` call, and the retry resolves it
  rmSync(failLabel, { force: true })
  factory(['beads'])
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1)
  const removes = callLines().filter(l => argvOf(l).startsWith('label remove acme-new'))
  expect(removes.length).toBeGreaterThanOrEqual(2) // the failed attempt, then the retry
  const state2 = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state2.a.unstripped).toBeUndefined()
})

test('a Linear API endpoint that never answers times out within a short bound; that rig records an error, and another rig still pulls (claude-factory-b6c.22)', async () => {
  const OTHER_TEAM = '11111111-2222-3333-4444-555555555555'
  const slow = await fakeLinearProcessSlow(TEAM, [{ ref: 'B-1', project: '[b]' }])
  try {
    writeRigs([
      { name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }, // this team hangs
      { name: 'b', repo: repoB, factory: 'lifecycle', linear: { team: [OTHER_TEAM] } }, // answers right away
    ])
    const started = Date.now()
    const out = factory(['linear'], { LINEAR_API_URL: slow.url, FACTORY_LINEAR_FETCH_TIMEOUT_MS: '300' })
    const elapsed = Date.now() - started
    expect(out.code).toBe(0)
    expect(elapsed).toBeLessThan(10_000) // well inside the bound; the real default wait is 30s
    const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
    expect(state.a.error).toBeTruthy() // rig a's own fetch timed out
    expect(state.b.pulled).toBe(2) // rig b's own fetch answered fine, and its pull still ran
  } finally {
    slow.stop()
  }
})

test("a second due pass sends bd only issues changed since the rig's last good pull; an unchanged issue makes no new pull call (claude-factory-b6c.24)", () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  factory(['linear']) // first pass: no prior lastGoodAt yet, so it pulls the fixture's one issue
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  expect(state.a.lastGoodAt).toBeTruthy()

  // backdate state.a.at so the pull is due again, with no --force: --force would bypass the
  // incremental cutoff entirely (cli.ts linearSyncOne), which would hide the bug this test checks.
  state.a.at = Date.now() - 20 * 60_000 - 1000
  writeFileSync(join(home, 'linear-sync.json'), JSON.stringify(state))

  factory(['linear']) // due again; the fixture's issue (updatedAt 2026-01-01) predates lastGoodAt
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1) // still just the first
})

test("a second due pass pulls an issue Linear marks as changed after the rig's last good pull, naming only that issue (claude-factory-b6c.25)", () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  factory(['linear']) // first pass: no prior lastGoodAt yet, so it pulls the fixture's one issue
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  const lastGoodAt = state.a.lastGoodAt
  expect(lastGoodAt).toBeTruthy()

  // backdate state.a.at so the pull is due again, with no --force: --force would bypass the
  // incremental cutoff entirely, which would hide the bug this test checks.
  state.a.at = Date.now() - 20 * 60_000 - 1000
  writeFileSync(join(home, 'linear-sync.json'), JSON.stringify(state))

  // a second issue, changed well after the rig's last good pull. The first issue's fixture
  // (updatedAt 2026-01-01) still predates lastGoodAt, so it must not appear in the new pull call.
  writeFileSync(
    linearIssuesFile,
    JSON.stringify([
      ...defaultIssues(),
      { ref: 'A-2', project: '[a]', labels: [], updatedAt: new Date(lastGoodAt + 60_000).toISOString() },
    ]),
  )

  factory(['linear'])
  const pullCalls = callLines().filter(l => argvOf(l).startsWith('linear pull'))
  expect(pullCalls).toHaveLength(2) // the first pass's call, plus exactly one new call
  expect(argvOf(pullCalls[1]!)).toBe('linear pull A-2 --json') // only the changed issue, never A-1 again
})

test('the incremental cutoff looks 5 minutes behind the last good pull, so clock drift does not skip an issue updated just before it (claude-factory-b6c.26)', () => {
  writeRigs([{ name: 'a', repo: repoA, factory: 'lifecycle', linear: { team: [TEAM] } }])
  factory(['linear']) // first pass: no prior lastGoodAt yet, so it pulls the fixture's one issue
  expect(callLines().filter(l => argvOf(l).startsWith('linear pull'))).toHaveLength(1)
  const state = JSON.parse(readFileSync(join(home, 'linear-sync.json'), 'utf8'))
  const lastGoodAt = state.a.lastGoodAt
  expect(lastGoodAt).toBeTruthy()

  state.a.at = Date.now() - 20 * 60_000 - 1000
  writeFileSync(join(home, 'linear-sync.json'), JSON.stringify(state))

  // an issue Linear's own clock marks as updated 2 minutes before this rig's last good pull: inside
  // the 5-minute skew buffer, so the cutoff must still count it as changed.
  writeFileSync(
    linearIssuesFile,
    JSON.stringify([
      { ref: 'A-2', project: '[a]', labels: [], updatedAt: new Date(lastGoodAt - 2 * 60_000).toISOString() },
    ]),
  )

  factory(['linear'])
  const pullCalls = callLines().filter(l => argvOf(l).startsWith('linear pull'))
  expect(pullCalls).toHaveLength(2) // the first pass's call, plus exactly one new call
  expect(argvOf(pullCalls[1]!)).toBe('linear pull A-2 --json')
})
