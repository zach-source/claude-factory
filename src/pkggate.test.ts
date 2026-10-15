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

// a transparency-log tile is raw hash bytes, not text: this probe (00 ff 80 c3, repeated) is exactly what
// review found UTF-8 decoding turns into 00 ef bf bd ef bf bd... when passed through fetchText (ei0.8)
const SUMDB_TILE_BYTES = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x00, 0xff, 0x80, 0xc3])

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
  // a module whose real @latest (v1.2.0) is too young, with an old-enough pseudo-version published more
  // recently than the old-enough release -- proves the fallback picks the release, not the newest by time (ei0.11)
  '/example.com/preview/@latest': { status: 200, body: '{"Version":"v1.2.0","Time":"2026-10-10T12:00:00Z"}' },
  '/example.com/preview/@v/list': { status: 200, body: 'v1.0.0\nv1.1.0-0.20261001120000-abcdef123456\nv1.2.0\n' },
  '/example.com/preview/@v/v1.0.0.info': { status: 200, body: '{"Version":"v1.0.0","Time":"2025-01-01T00:00:00Z"}' },
  '/example.com/preview/@v/v1.1.0-0.20261001120000-abcdef123456.info': {
    status: 200,
    body: '{"Version":"v1.1.0-0.20261001120000-abcdef123456","Time":"2026-10-05T00:00:00Z"}',
  },
  '/example.com/preview/@v/v1.2.0.info': { status: 200, body: '{"Version":"v1.2.0","Time":"2026-10-10T12:00:00Z"}' },
  '/sumdb/sum.golang.org/supported': { status: 200, body: '' },
  '/sumdb/sum.golang.org/lookup/golang.org/x/text@v0.26.0': { status: 200, body: 'fakehash\n' },
  '/nope': { status: 404, body: '{"error":"Not found"}' },
  '/boom500': { status: 500, body: 'internal error' },
}

// trimmed from a real `curl -H 'Accept: application/json' https://registry.npmjs.org/@types%2fms`
// (2026-10-14), with a synthetic young 2.2.0 added to exercise the age gate. `tarball` points back at
// this fake upstream itself (`origin`), the way the real registry's own host would appear there.
const npmVersion = (origin: string, version: string, shasum: string, integrity: string) => ({
  name: '@types/ms',
  version,
  description: 'TypeScript definitions for ms',
  dist: { shasum, tarball: `${origin}/@types/ms/-/ms-${version}.tgz`, integrity },
})
const npmPackument = (origin: string) =>
  JSON.stringify({
    name: '@types/ms',
    'dist-tags': { latest: '2.2.0' },
    versions: {
      '0.7.34': npmVersion(
        origin,
        '0.7.34',
        '10964ba0dee6ac4cd462e2795b6bebd407303433',
        'sha512-nG96G3Wp6acyAgJqGasjODb+acrI7KltPiRxzHPXnP3NgI28bpQDRv53olbqGXbfcgF5aiiHmO3xpwEpS5Ld9g==',
      ),
      '2.1.0': npmVersion(
        origin,
        '2.1.0',
        '052aa67a48eccc4309d7f0191b7e41434b90bb78',
        'sha512-GsCCIZDE/p3i96vtEqx+7dBUGXrc7zeSK3wwPHIaRThS+9OhWIXRqzs4d6k1SVU8g91DrNRWxWUGhp5KXQb2VA==',
      ),
      '2.2.0': npmVersion(origin, '2.2.0', 'synthetic', 'sha512-synthetic=='),
    },
    time: {
      created: '2016-05-17T18:23:02.430Z',
      modified: '2026-10-10T12:00:00.000Z',
      '0.7.34': '2023-11-07T11:26:21.925Z',
      '2.1.0': '2025-01-16T21:02:46.181Z',
      '2.2.0': '2026-10-10T12:00:00.000Z', // ~12h before the test clock: too young
    },
  })
const NPM_ABBREVIATED = JSON.stringify({ name: '@types/ms', 'dist-tags': { latest: '2.2.0' }, versions: {} })

// a package whose upstream `latest` points at a too-young nightly, with an old-enough prerelease published
// more recently than the old-enough release -- proves the re-point picks the release, not the newest by time (ei0.11)
const previewVersion = (origin: string, version: string) => ({
  name: 'preview-pkg',
  version,
  dist: { tarball: `${origin}/preview-pkg/-/preview-pkg-${version}.tgz`, shasum: 'x' },
})
const PREVIEW_PACKUMENT = (origin: string) =>
  JSON.stringify({
    name: 'preview-pkg',
    'dist-tags': { latest: '3.0.0-nightly.20261010' }, // too young: dropped
    versions: {
      '1.0.0': previewVersion(origin, '1.0.0'),
      '2.0.0-beta.1': previewVersion(origin, '2.0.0-beta.1'),
      '3.0.0-nightly.20261010': previewVersion(origin, '3.0.0-nightly.20261010'),
    },
    time: {
      created: '2020-01-01T00:00:00.000Z',
      modified: '2026-10-10T12:00:00.000Z',
      '1.0.0': '2024-01-01T00:00:00.000Z', // old release
      '2.0.0-beta.1': '2026-09-01T00:00:00.000Z', // old enough, newer than 1.0.0, but a prerelease
      '3.0.0-nightly.20261010': '2026-10-10T12:00:00.000Z', // ~12h before the test clock: too young
    },
  })
const NPM_TARBALLS: Record<string, string> = {
  'ms-0.7.34.tgz': 'TARBALL-BYTES-0.7.34',
  'ms-2.1.0.tgz': 'TARBALL-BYTES-2.1.0',
  'ms-2.2.0.tgz': 'TARBALL-BYTES-2.2.0',
}

// trimmed from a real `curl -H 'Accept: application/vnd.pypi.simple.v1+json' https://pypi.org/simple/requests/`
// (2026-10-14): two real files (PEP 700 upload-time included), plus a synthetic young one and a synthetic
// one with no upload-time at all, to exercise the age gate
const PYPI_OLD_WHEEL_PATH = '/packages/70/8e/0e2d847013cb52cd35b38c009bb167a1a26b2ce6cd6965bf26b47bc0bf44/requests-2.31.0-py3-none-any.whl'
const PYPI_OLD_SDIST_PATH = '/packages/9d/be/10918a2eac4ae9f02f6cfe6414b7a155ccd8f7f9d4380d62fd5b955065c3/requests-2.31.0.tar.gz'
const PYPI_YOUNG_PATH = '/packages/zz/zz/synthetic/requests-2.36.0.tar.gz'
const PYPI_NOTIME_PATH = '/packages/yy/yy/synthetic/requests-2.37.0.tar.gz'
const pypiIndex = (origin: string) =>
  JSON.stringify({
    name: 'requests',
    meta: { '_last-serial': 37059094, 'api-version': '1.4' },
    versions: ['2.31.0', '2.36.0', '2.37.0'],
    files: [
      {
        filename: 'requests-2.31.0-py3-none-any.whl',
        url: `${origin}${PYPI_OLD_WHEEL_PATH}`,
        hashes: { sha256: '58cd2187c01e70e6e26505bca751777aa9f2ee0b7f4300988b709f44e013003f' },
        size: 62574,
        'requires-python': '>=3.7',
        'upload-time': '2023-05-22T15:12:42.313790Z',
        yanked: false,
        // PEP 658/714: pip 25.3 GETs `<url>.metadata` with no fallback whenever these are present (ei0.9)
        'core-metadata': { sha256: '7823e890e9db6f415138badf9744791290ef76e7ec6fd09a3789e8247fffe782' },
        'data-dist-info-metadata': { sha256: '7823e890e9db6f415138badf9744791290ef76e7ec6fd09a3789e8247fffe782' },
      },
      {
        filename: 'requests-2.31.0.tar.gz',
        url: `${origin}${PYPI_OLD_SDIST_PATH}`,
        hashes: { sha256: '942c5a758f98d790eaed1a29cb6eefc7ffb0d1cf7af05c3d2791656dbd6ad1e1' },
        size: 110794,
        'requires-python': '>=3.7',
        'upload-time': '2023-05-22T15:12:44.175995Z',
        yanked: false,
      },
      {
        filename: 'requests-2.36.0.tar.gz', // synthetic: too young
        url: `${origin}${PYPI_YOUNG_PATH}`,
        hashes: { sha256: 'synthetic-young' },
        size: 1,
        'upload-time': '2026-10-10T12:00:00.000Z',
        yanked: false,
        'core-metadata': { sha256: 'synthetic-young-metadata' },
      },
      {
        filename: 'requests-2.37.0.tar.gz', // synthetic: no upload-time at all
        url: `${origin}${PYPI_NOTIME_PATH}`,
        hashes: { sha256: 'synthetic-notime' },
        size: 1,
        yanked: false,
      },
    ],
  })
const PYPI_LEGACY_HTML = '<!DOCTYPE html><html><body><a href="#">requests-2.31.0.tar.gz</a></body></html>'
const PYPI_FILES: Record<string, string> = {
  [PYPI_OLD_WHEEL_PATH]: 'FILEBYTES-wheel-2.31.0',
  [PYPI_OLD_SDIST_PATH]: 'FILEBYTES-sdist-2.31.0',
  [PYPI_YOUNG_PATH]: 'FILEBYTES-young-2.36.0',
  [PYPI_NOTIME_PATH]: 'FILEBYTES-notime-2.37.0',
  // curl -m5 -o /dev/null -w '%{http_code} %{content_type}\n' '<the real wheel url>.metadata' -> 200 application/octet-stream
  [`${PYPI_OLD_WHEEL_PATH}.metadata`]: 'METADATA-wheel-2.31.0',
  [`${PYPI_YOUNG_PATH}.metadata`]: 'METADATA-young-2.36.0',
}

let upstream: ReturnType<typeof Bun.serve>
beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/@types%2fms' || url.pathname === '/@types/ms')
        return req.headers.get('accept') === 'application/json'
          ? new Response(npmPackument(url.origin), { headers: { 'content-type': 'application/json' } })
          : new Response(NPM_ABBREVIATED, { headers: { 'content-type': 'application/json' } }) // no `time`: proves the gate always asks for the full doc
      const tarballFile = url.pathname.match(/^\/@types\/ms\/-\/(.+)$/)?.[1]
      if (tarballFile && NPM_TARBALLS[tarballFile]) return new Response(NPM_TARBALLS[tarballFile])
      if (url.pathname === '/preview-pkg')
        return new Response(PREVIEW_PACKUMENT(url.origin), { headers: { 'content-type': 'application/json' } })
      if (url.pathname === '/simple/requests/')
        return req.headers.get('accept') === 'application/vnd.pypi.simple.v1+json'
          ? new Response(pypiIndex(url.origin), { headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' } })
          : new Response(PYPI_LEGACY_HTML, { headers: { 'content-type': 'text/html' } }) // proves the gate always asks for PEP 691 JSON
      if (url.pathname === '/simple/missingproj/') return new Response('not found', { status: 404 })
      if (url.pathname === '/simple/brokenproj/') return new Response('internal error', { status: 500 })
      if (PYPI_FILES[url.pathname]) return new Response(PYPI_FILES[url.pathname])
      if (url.pathname === '/sumdb/sum.golang.org/tile/8/0/000')
        return new Response(SUMDB_TILE_BYTES, { headers: { 'content-type': 'application/octet-stream' } })
      // never responds: proves a hanging upstream is refused by the gate's own timeout, not left to hang (ei0.12)
      if (url.pathname === '/example.com/hangs/@v/v1.0.0.info') return new Promise<Response>(() => {})
      const r = routes[url.pathname]
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

test('@latest fallback picks the highest release, not a pseudo-version that is merely newer by time (ei0.11)', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/go/example.com/preview/@latest'))
  expect(r.status).toBe(200)
  // v1.1.0-0.20261001120000-abcdef123456 is a newer, old-enough pseudo-version; v1.0.0 is the only release
  expect(await r.json()).toMatchObject({ Version: 'v1.0.0' })
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

test('a hanging upstream is refused (502) after fetchTimeoutMs, not left waiting for the server\'s own idle timeout (ei0.12)', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base() },
    now: () => NOW,
    fetchTimeoutMs: 50,
  })
  const start = Date.now()
  const r = await g(new Request('http://gate/go/example.com/hangs/@v/v1.0.0.info'))
  // well under Bun.serve's own 10s idle timeout, which would otherwise mask a missing AbortSignal
  expect(Date.now() - start).toBeLessThan(2_000)
  expect(r.status).toBe(502)
  expect(await r.text()).toContain('pkg-gate')
})

test('a module version is decided once, then cached: a second request for the same version makes no second upstream fetch (ei0.12)', async () => {
  let hits = 0
  const counting = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/counted.example.com/mod/@v/v1.0.0.info') {
        hits++
        return new Response('{"Version":"v1.0.0","Time":"2025-06-05T15:08:00Z"}')
      }
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({ upstream: { go: counting.url.origin, npm: base(), pypi: base(), files: base() }, now: () => NOW })
    await g(new Request('http://gate/go/counted.example.com/mod/@v/v1.0.0.info'))
    await g(new Request('http://gate/go/counted.example.com/mod/@v/v1.0.0.info'))
    await g(new Request('http://gate/go/counted.example.com/mod/@v/v1.0.0.info'))
    expect(hits).toBe(1)
  } finally {
    counting.stop(true)
  }
})

test('a non-canonical query (a branch/tag, whose .info resolves to a moving version) is never cached under the query key (ei0.14)', async () => {
  let answer = GO_INFO_OLD // Version v0.26.0, old enough
  const moving = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/moving.example.com/mod/@v/master.info') return new Response(answer)
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({ upstream: { go: moving.url.origin, npm: base(), pypi: base(), files: base() }, now: () => NOW })
    const first = await g(new Request('http://gate/go/moving.example.com/mod/@v/master.info'))
    expect(first.status).toBe(200)
    expect(await first.text()).toBe(GO_INFO_OLD)
    // upstream's `master` has since moved to a too-young version; a cached entry keyed on the literal
    // query "master" would still serve the old, stale answer forever instead of refetching
    answer = GO_INFO_YOUNG
    const second = await g(new Request('http://gate/go/moving.example.com/mod/@v/master.info'))
    expect(second.status).toBe(404) // now too young: proves it was refetched, not served from a stale cache
  } finally {
    moving.stop(true)
  }
})

test('an unparseable .info is never cached, so a later, parseable answer is served (ei0.14)', async () => {
  let answer = '{"Version":"v1.0.0"}' // no Time: unparseable per parseGoInfo
  const flaky = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/flaky.example.com/mod/@v/v1.0.0.info') return new Response(answer)
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({ upstream: { go: flaky.url.origin, npm: base(), pypi: base(), files: base() }, now: () => NOW })
    const first = await g(new Request('http://gate/go/flaky.example.com/mod/@v/v1.0.0.info'))
    expect(first.status).toBe(404) // missing time: refused
    answer = '{"Version":"v1.0.0","Time":"2025-06-05T15:08:00Z"}' // same version, now with a real, old-enough Time
    const second = await g(new Request('http://gate/go/flaky.example.com/mod/@v/v1.0.0.info'))
    expect(second.status).toBe(200) // proves the unparseable first answer was never cached
  } finally {
    flaky.stop(true)
  }
})

test('the npm packument cache evicts the oldest entry once over its cap, so a later request for it refetches (ei0.13)', async () => {
  const hits: Record<string, number> = {}
  const counting = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\//, '')
      hits[name] = (hits[name] ?? 0) + 1
      return new Response(JSON.stringify({ name, 'dist-tags': {}, versions: {}, time: {} }), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  try {
    const g = makeGate({
      upstream: { go: base(), npm: counting.url.origin, pypi: base(), files: base() },
      now: () => NOW,
      registryCacheMaxEntries: 2,
    })
    await g(new Request('http://gate/npm/pkg-a'))
    await g(new Request('http://gate/npm/pkg-b'))
    await g(new Request('http://gate/npm/pkg-c')) // the cache is now over its cap of 2: pkg-a (oldest) is evicted
    await g(new Request('http://gate/npm/pkg-a')) // refetched, since it was evicted
    expect(hits['pkg-a']).toBe(2)
    expect(hits['pkg-b']).toBe(1)
    expect(hits['pkg-c']).toBe(1)
  } finally {
    counting.stop(true)
  }
})

test('a bulk npm packument request logs only the refused version, not every allowed one, plus one summary line (ei0.13)', async () => {
  const g = gate()
  const lines: string[] = []
  const orig = console.log
  console.log = (s: string) => lines.push(s)
  try {
    await g(new Request('http://gate/npm/@types%2fms'))
  } finally {
    console.log = orig
  }
  const npmLines = lines.map(l => JSON.parse(l)).filter(p => p.eco === 'npm')
  // @types/ms (fixture above) has 2 allowed versions (0.7.34, 2.1.0) and 1 refused (2.2.0, too young)
  expect(npmLines.filter(p => p.decision === 'allow')).toHaveLength(0)
  expect(npmLines.filter(p => p.decision === 'refuse')).toHaveLength(1)
  const summaries = npmLines.filter(p => p.summary)
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toMatchObject({ allow: 2, refuse: 1, error: 0 })
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

test('sumdb passes a binary tile through byte-identical, not UTF-8-mangled (ei0.8)', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/go/sumdb/sum.golang.org/tile/8/0/000'))
  expect(r.status).toBe(200)
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(SUMDB_TILE_BYTES)
})

test('an npm packument drops the young version, re-points latest, and rewrites tarball URLs to the gate', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/npm/@types%2fms'))
  expect(r.status).toBe(200)
  const p = (await r.json()) as { versions: Record<string, { dist: { tarball: string; shasum: string } }>; 'dist-tags': { latest: string }; time: Record<string, string> }
  expect(Object.keys(p.versions).sort()).toEqual(['0.7.34', '2.1.0']) // 2.2.0 (young) is gone
  expect(p['dist-tags'].latest).toBe('2.1.0') // re-pointed off the removed young version
  expect(p.time['2.2.0']).toBeUndefined()
  expect(p.time.created).toBe('2016-05-17T18:23:02.430Z') // non-version time entries pass through
  expect(p.versions['2.1.0']!.dist.tarball).toBe('http://gate/npm/@types/ms/-/ms-2.1.0.tgz')
  expect(p.versions['0.7.34']!.dist.shasum).toBe('10964ba0dee6ac4cd462e2795b6bebd407303433') // untouched fields pass through
})

test('an npm packument works for the unencoded scoped form too (@scope/name, two segments)', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/npm/@types/ms'))
  expect(r.status).toBe(200)
  expect(Object.keys((await r.json() as { versions: Record<string, unknown> }).versions).sort()).toEqual(['0.7.34', '2.1.0'])
})

test('an old npm tarball is served byte-identical; a young one is refused', async () => {
  const g = gate()
  const old = await g(new Request('http://gate/npm/@types/ms/-/ms-2.1.0.tgz'))
  expect(old.status).toBe(200)
  expect(await old.text()).toBe('TARBALL-BYTES-2.1.0')

  const young = await g(new Request('http://gate/npm/@types/ms/-/ms-2.2.0.tgz'))
  expect(young.status).toBe(404)
  expect(await young.text()).toContain('pkg-gate')
})

test('a re-pointed npm `latest` picks the highest release, not a prerelease that is merely newer by time (ei0.11)', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/npm/preview-pkg'))
  expect(r.status).toBe(200)
  const p = (await r.json()) as { versions: Record<string, unknown>; 'dist-tags': { latest: string } }
  expect(Object.keys(p.versions).sort()).toEqual(['1.0.0', '2.0.0-beta.1']) // the nightly (young) is gone
  expect(p['dist-tags'].latest).toBe('1.0.0') // not '2.0.0-beta.1', even though it was published more recently
})

test('npm upstream errors refuse rather than pass through', async () => {
  const g = gate()
  const notFound = await g(new Request('http://gate/npm/nope'))
  expect(notFound.status).toBe(404)
  const broken = await g(new Request('http://gate/npm/boom500'))
  expect(broken.status).toBe(502)
  expect(await broken.text()).toContain('pkg-gate')
})

test('the PyPI simple index drops a young file and one with no upload-time, and rewrites file urls to the gate', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/pypi/simple/requests/'))
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('application/vnd.pypi.simple.v1+json')
  const idx = (await r.json()) as { files: { filename: string; url: string }[] }
  const names = idx.files.map(f => f.filename).sort()
  expect(names).toEqual(['requests-2.31.0-py3-none-any.whl', 'requests-2.31.0.tar.gz']) // young and no-upload-time files are gone
  const sdist = idx.files.find(f => f.filename === 'requests-2.31.0.tar.gz')!
  expect(sdist.url).toBe(`http://gate/pypi/files/requests${PYPI_OLD_SDIST_PATH}`)
  const wheel = idx.files.find((f: { filename: string }) => f.filename === 'requests-2.31.0-py3-none-any.whl') as unknown as {
    'core-metadata': { sha256: string }
  }
  // PEP 658/714: the advertisement a kept file carries passes through unchanged, so pip still GETs <url>.metadata
  expect(wheel['core-metadata']).toEqual({ sha256: '7823e890e9db6f415138badf9744791290ef76e7ec6fd09a3789e8247fffe782' })
})

test('a wheel\'s PEP 658/714 <url>.metadata is served byte-identical when the wheel is allowed, refused when it is not (ei0.9)', async () => {
  const g = gate()
  const old = await g(new Request(`http://gate/pypi/files/requests${PYPI_OLD_WHEEL_PATH}.metadata`))
  expect(old.status).toBe(200)
  expect(await old.text()).toBe('METADATA-wheel-2.31.0')

  const young = await g(new Request(`http://gate/pypi/files/requests${PYPI_YOUNG_PATH}.metadata`))
  expect(young.status).toBe(404)
  expect(await young.text()).toContain('pkg-gate')
})

test('PyPI project names are normalized per PEP 503 (dots, underscores, case)', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/pypi/simple/Requests/'))
  expect(r.status).toBe(200)
  const idx = (await r.json()) as { files: { filename: string }[] }
  expect(idx.files.length).toBe(2)
})

test('an old PyPI file is served byte-identical; a young or unlisted one is refused', async () => {
  const g = gate()
  const old = await g(new Request(`http://gate/pypi/files/requests${PYPI_OLD_SDIST_PATH}`))
  expect(old.status).toBe(200)
  expect(await old.text()).toBe('FILEBYTES-sdist-2.31.0')

  const young = await g(new Request(`http://gate/pypi/files/requests${PYPI_YOUNG_PATH}`))
  expect(young.status).toBe(404)
  expect(await young.text()).toContain('pkg-gate')

  const notime = await g(new Request(`http://gate/pypi/files/requests${PYPI_NOTIME_PATH}`))
  expect(notime.status).toBe(404)
  expect(await notime.text()).toContain('pkg-gate')

  const unlisted = await g(new Request('http://gate/pypi/files/requests/packages/no/such/file.tar.gz'))
  expect(unlisted.status).toBe(404)
})

test('/healthz reports minDays and the allow/refuse/error counters since start', async () => {
  const g = gate()
  const before = await g(new Request('http://gate/healthz'))
  expect(before.status).toBe(200)
  expect(await before.json()).toEqual({ ok: true, minDays: 4, allow: 0, refuse: 0, error: 0 })

  await g(new Request('http://gate/go/golang.org/x/text/@v/v0.26.0.info')) // allow
  await g(new Request('http://gate/go/golang.org/x/text/@v/v0.43.0.info')) // refuse
  await g(new Request('http://gate/go/example.com/bad500/@v/v1.0.0.info')) // error

  const after = await g(new Request('http://gate/healthz'))
  expect(await after.json()).toEqual({ ok: true, minDays: 4, allow: 1, refuse: 1, error: 1 })
})

test('makeGate throws on a non-finite or negative minDays instead of silently allowing everything (ei0.10)', () => {
  const cfg = { upstream: { go: base(), npm: base(), pypi: base(), files: base() } }
  expect(() => makeGate({ ...cfg, minDays: Number('four') })).toThrow(/finite, non-negative/)
  expect(() => makeGate({ ...cfg, minDays: NaN })).toThrow(/finite, non-negative/)
  expect(() => makeGate({ ...cfg, minDays: Infinity })).toThrow(/finite, non-negative/)
  expect(() => makeGate({ ...cfg, minDays: -1 })).toThrow(/finite, non-negative/)
  expect(() => makeGate({ ...cfg, minDays: 0 })).not.toThrow() // 0 is a legitimate (if permissive) minimum
})

test('a malformed request (invalid percent-encoding) is a plain-text refusal counted as an error, never an uncaught exception (ei0.15)', async () => {
  const g = gate()
  // '%A' with no second hex digit is not a valid escape: decodeURIComponent throws URIError here, which an
  // uncaught throw inside the handler would otherwise surface as Bun's dev-mode HTML error page (with the
  // stack and source), uncounted in cfg.stats
  const r = await g(new Request('http://gate/pypi/simple/%E0%A4%A/'))
  expect(r.status).toBeGreaterThanOrEqual(400)
  expect(r.status).toBeLessThan(500)
  const text = await r.text()
  expect(text).toContain('pkg-gate')
  expect(text).not.toContain('<html')
  expect((r.headers.get('content-type') ?? '')).toContain('text/plain')

  const health = await g(new Request('http://gate/healthz'))
  expect((await health.json() as { error: number }).error).toBe(1)
})

test('PyPI upstream errors refuse rather than pass through', async () => {
  const g = gate()
  const notFound = await g(new Request('http://gate/pypi/simple/missingproj/'))
  expect(notFound.status).toBe(404)
  const broken = await g(new Request('http://gate/pypi/simple/brokenproj/'))
  expect(broken.status).toBe(502)
  expect(await broken.text()).toContain('pkg-gate')
})
