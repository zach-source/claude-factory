import { afterAll, beforeAll, expect, test } from 'bun:test'
import { makeGate } from './pkggate'

// Fixtures trimmed from real proxy.golang.org responses (golang.org/x/text), 2026-10-14:
// curl https://proxy.golang.org/golang.org/x/text/@v/v0.26.0.info
const GO_INFO_OLD =
  '{"Version":"v0.26.0","Time":"2025-06-05T15:08:00Z","Origin":{"VCS":"git","URL":"https://go.googlesource.com/text","Hash":"80721808805f9d846d907c85d73ca6b5b6ecb870","Ref":"refs/tags/v0.26.0"}}'
// curl https://proxy.golang.org/golang.org/x/text/@v/v0.43.0.info (and identical body at @latest that day)
const GO_INFO_YOUNG =
  '{"Version":"v0.43.0","Time":"2026-10-09T15:18:32Z","Origin":{"VCS":"git","URL":"https://go.googlesource.com/text","Hash":"ac40b0f06c159afb5bfca4d1860f8b4b60dbc160","Ref":"refs/tags/v0.43.0"}}'
// curl https://proxy.golang.org/golang.org/x/text/@v/v0.26.0.mod
const GO_MOD_OLD = `module golang.org/x/text

go 1.23.0

require golang.org/x/tools v0.33.0 // tagx:ignore

require (
	golang.org/x/mod v0.25.0 // indirect; tagx:ignore
	golang.org/x/sync v0.15.0 // indirect
)
`
const GO_ZIP_OLD = 'ZIPBYTES-v0.26.0'
const GO_ALLOWLISTED_INFO = '{"Version":"v9.9.9","Time":"2026-10-10T23:00:00Z"}'

// a fake upstream: proxy.golang.org (and a fake sumdb) answering only the exact paths the tests use
type Route = { status: number; body: string; type?: string }
const routes: Record<string, Route> = {
  '/golang.org/x/text/@v/v0.26.0.info': { status: 200, body: GO_INFO_OLD },
  '/golang.org/x/text/@v/v0.43.0.info': { status: 200, body: GO_INFO_YOUNG },
  '/golang.org/x/text/@v/v0.26.0.mod': { status: 200, body: GO_MOD_OLD },
  '/golang.org/x/text/@v/v0.26.0.zip': { status: 200, body: GO_ZIP_OLD, type: 'application/zip' },
  '/golang.org/x/text/@v/list': { status: 200, body: 'v0.26.0\nv0.43.0\n' },
  '/golang.org/x/text/@latest': { status: 200, body: GO_INFO_YOUNG },
  '/example.com/bad500/@v/v1.0.0.info': { status: 500, body: 'internal error' },
  '/example.com/notime/@v/v1.0.0.info': { status: 200, body: '{"Version":"v1.0.0"}' },
  '/allowed.example.com/mod/@v/v9.9.9.info': { status: 200, body: GO_ALLOWLISTED_INFO },
  '/sumdb/sum.golang.org/supported': { status: 200, body: '' },
  '/sumdb/sum.golang.org/lookup/golang.org/x/text@v0.26.0': { status: 200, body: 'fakehash\n' },
}
let upstream: ReturnType<typeof Bun.serve>
beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      const r = routes[path]
      if (!r) return new Response('not found', { status: 404 })
      return new Response(r.body, { status: r.status, headers: r.type ? { 'content-type': r.type } : {} })
    },
  })
})
afterAll(() => upstream.stop(true))

// 2026-10-11T00:00:00Z: v0.43.0 (published 2026-10-09T15:18:32Z) is ~32.7h old, under the 4d minimum;
// v0.26.0 (2025-06-05) is far over it
const NOW = Date.parse('2026-10-11T00:00:00Z')
const base = () => upstream.url.origin
const gate = () =>
  makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base() },
    now: () => NOW,
  })

test('a young Go version is refused on .info, .mod, .zip and @latest, with the reason in the body', async () => {
  const g = gate()
  const info = await g(new Request('http://gate/go/golang.org/x/text/@v/v0.43.0.info'))
  expect(info.status).toBe(404)
  expect(await info.text()).toBe('pkg-gate: golang.org/x/text@v0.43.0 published 32h ago, minimum 4d')

  const mod = await g(new Request('http://gate/go/golang.org/x/text/@v/v0.43.0.mod'))
  expect(mod.status).toBe(404)
  const zip = await g(new Request('http://gate/go/golang.org/x/text/@v/v0.43.0.zip'))
  expect(zip.status).toBe(404)
})

test('an old Go version is served byte-identical to upstream on .info, .mod and .zip', async () => {
  const g = gate()
  const info = await g(new Request('http://gate/go/golang.org/x/text/@v/v0.26.0.info'))
  expect(info.status).toBe(200)
  expect(await info.text()).toBe(GO_INFO_OLD)

  const mod = await g(new Request('http://gate/go/golang.org/x/text/@v/v0.26.0.mod'))
  expect(mod.status).toBe(200)
  expect(await mod.text()).toBe(GO_MOD_OLD)

  const zip = await g(new Request('http://gate/go/golang.org/x/text/@v/v0.26.0.zip'))
  expect(zip.status).toBe(200)
  expect(await zip.text()).toBe(GO_ZIP_OLD)
})

test('@v/list omits a version younger than the minimum', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/go/golang.org/x/text/@v/list'))
  expect(r.status).toBe(200)
  expect(await r.text()).toBe('v0.26.0\n')
})

test('@latest falls back to the newest old-enough version when the real latest is too young', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/go/golang.org/x/text/@latest'))
  expect(r.status).toBe(200)
  expect(await r.json()).toMatchObject({ Version: 'v0.26.0' })
})

test('@latest passes through when the real latest is already old enough', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base() },
    // a year after v0.43.0 published: old enough on its own, no fallback needed
    now: () => Date.parse('2027-10-11T00:00:00Z'),
  })
  const r = await g(new Request('http://gate/go/golang.org/x/text/@latest'))
  expect(r.status).toBe(200)
  expect(await r.text()).toBe(GO_INFO_YOUNG)
})

test('an upstream 500 is refused, never passed through', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/go/example.com/bad500/@v/v1.0.0.info'))
  expect(r.status).toBe(502)
  expect(await r.text()).toContain('pkg-gate')
})

test('a missing publish time is refused, never allowed through', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/go/example.com/notime/@v/v1.0.0.info'))
  expect(r.status).toBe(404)
  expect(await r.text()).toContain('pkg-gate')
})

test('an allowlisted module is let through even when young', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base() },
    now: () => NOW,
    allowlist: ['allowed.example.com/mod'],
  })
  const r = await g(new Request('http://gate/go/allowed.example.com/mod/@v/v9.9.9.info'))
  expect(r.status).toBe(200)
  expect(await r.text()).toBe(GO_ALLOWLISTED_INFO)
})

test('sumdb is proxied verbatim, including /supported', async () => {
  const g = gate()
  const supported = await g(new Request('http://gate/go/sumdb/sum.golang.org/supported'))
  expect(supported.status).toBe(200)
  const lookup = await g(new Request('http://gate/go/sumdb/sum.golang.org/lookup/golang.org/x/text@v0.26.0'))
  expect(lookup.status).toBe(200)
  expect(await lookup.text()).toBe('fakehash\n')
})
