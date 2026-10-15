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
// an .info Time 30 days before the test clock (NOW, below): old enough on its own, used by every
// claude-factory-8ub fixture below so the sum.golang.org first-logged check is what actually decides it
const GO_INFO_BACKDATED_TIME = '2026-09-11T00:00:00Z'

// claude-factory-8ub: the Go age gate also checks sum.golang.org's first-logged record.
// It does this through two new upstreams (`sumdb`, `goIndex`). Every fixture in this file now points both
// at this same fake server. `/index` answers any `since` with 9 synthetic entries, each timestamped inside
// the requested window. `/latest` answers with a tree size (1,000,000) far above every record id this file
// uses, so no sample is ever dropped as an outlier (claude-factory-8ub.6). So the floor comes out the same
// (100, see below), no matter which `now`/minDays a given test uses. `/lookup/<mod>@<version>` answers with
// a low id (at or below the floor) for anything not explicitly listed below. So every pre-existing "old
// enough" Go fixture in this file keeps passing, without each needing its own record.
const escapeGoPath = (s: string) => s.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`)
const GO_FLOOR_SAMPLE_VERSION = 'v1.0.0'
const GO_FLOOR_SAMPLE_PATHS = [
  'floorsample-a.example.com/mod',
  'floorsample-b.example.com/mod',
  'floorsample-c.example.com/mod',
  // real casing has an uppercase letter: proves the floor refresh escapes Path/Version the way a real Go
  // client would, not the raw casing index.golang.org reports (AC10)
  'github.com/Azure/floorsample',
  'floorsample-e.example.com/mod',
  'floorsample-f.example.com/mod',
  'floorsample-g.example.com/mod',
  'floorsample-h.example.com/mod',
  'floorsample-i.example.com/mod',
]
// ids 100..108: makeGate's goFloor takes the minimum of these (the safe side, claude-factory-8ub.6), 100
const GO_FLOOR_RECORD = 100
const GO_FLOOR_RECORDS: Record<string, number> = Object.fromEntries(
  GO_FLOOR_SAMPLE_PATHS.map((p, i) => [`${escapeGoPath(p)}@${escapeGoPath(GO_FLOOR_SAMPLE_VERSION)}`, 100 + i]),
)
// versions this file needs to look too-new (first logged after the floor); everything else defaults to
// GO_FLOOR_RECORD - 1, always at or below it
const GO_HIGH_RECORDS: Record<string, number> = {
  'backdated.example.com/mod@v1.0.0': GO_FLOOR_RECORD + 1000,
  'listfixture.example.com/mod@v2.0.0': GO_FLOOR_RECORD + 1000,
}
const GO_LOOKUP_500 = new Set(['lookupfail500.example.com/mod@v1.0.0'])
const GO_LOOKUP_HANGS = new Set(['lookuptimeout.example.com/mod@v1.0.0'])
const GO_LOOKUP_BAD_BODY: Record<string, string> = { 'lookupbadbody.example.com/mod@v1.0.0': 'abc\n' }
// counts every /lookup/<key> hit, so a test can assert a specific key was (or was never) looked up
const goLookupHits: Record<string, number> = {}

function goIndexBody(sinceIso: string): string {
  const sinceMs = Date.parse(sinceIso)
  const ts = new Date(sinceMs + 15 * 60_000).toISOString() // inside [since, since + 30min]
  return GO_FLOOR_SAMPLE_PATHS.map(p => JSON.stringify({ Path: p, Version: GO_FLOOR_SAMPLE_VERSION, Timestamp: ts })).join('\n') + '\n'
}

// sum.golang.org's `GET /latest` signed note (claude-factory-8ub.6): a floor refresh reads its tree size
// before looking up any sample, and drops a sample whose own record sits at or past it. `size` far above
// every record id a given fixture server hands out keeps that filter a no-op there.
const sumdbLatestBody = (size: number) => `go.sum database tree\n${size}\nfakehash\n\n— sum.golang.org fakesignature\n`

// claude-factory-8ub.7: a decision with a present floor does not wait for the refresh it triggers. It
// decides at once, with the old, still-safe floor. A test that needs the refresh's own result (its
// /healthz value, or its log line) must wait for that refresh's JSON line first. `lines` is a
// `console.log` capture the caller owns.
async function waitForFloorRefresh(lines: string[], from: number, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const landed = lines.slice(from).some(l => {
      const j = JSON.parse(l)
      return j.eco === 'go' && (typeof j.floor === 'number' || (j.decision === 'error' && typeof j.reason === 'string' && j.reason.startsWith('sumdb floor refresh')))
    })
    if (landed) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('waitForFloorRefresh: no floor refresh landed in time')
}

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
  // a module whose real casing has an uppercase letter: Go's proxy protocol case-encodes it (`!azure`) and
  // never decodes it (handleGo's comment), so an allowlist entry written in the module's real casing has to
  // be unescaped to match it (ei0.18)
  '/github.com/!azure/azure-sdk-for-go/@v/v1.0.0.info': { status: 200, body: '{"Version":"v1.0.0","Time":"2026-10-10T23:00:00Z"}' },
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

  // claude-factory-8ub: an .info Time 30d old, but first logged in sum.golang.org after the floor -- AC1
  '/backdated.example.com/mod/@v/v1.0.0.info': { status: 200, body: `{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}` },
  // the control for AC1: same .info Time, but a record at or below the floor -- AC2
  '/loggedold.example.com/mod/@v/v1.0.0.info': { status: 200, body: `{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}` },
  // AC3: a module whose @v/list has one allowed version and one backdated one, and whose @latest names the
  // backdated one -- the list must drop it, and the @latest fallback must pick the allowed release instead
  '/listfixture.example.com/mod/@v/list': { status: 200, body: 'v1.0.0\nv2.0.0\n' },
  '/listfixture.example.com/mod/@v/v1.0.0.info': { status: 200, body: `{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}` },
  '/listfixture.example.com/mod/@v/v2.0.0.info': { status: 200, body: `{"Version":"v2.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}` },
  '/listfixture.example.com/mod/@latest': { status: 200, body: `{"Version":"v2.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}` },
  // AC4: a sum.golang.org lookup that 500s, hangs, or answers a non-numeric body -- none is ever an allow
  '/lookupfail500.example.com/mod/@v/v1.0.0.info': { status: 200, body: `{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}` },
  '/lookuptimeout.example.com/mod/@v/v1.0.0.info': { status: 200, body: `{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}` },
  '/lookupbadbody.example.com/mod/@v/v1.0.0.info': { status: 200, body: `{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}` },
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

// a compromised (or merely malicious) upstream packument naming a tarball URL the gate must never fetch
// verbatim: a `file://` URL (Bun's fetch reads it straight off the gate pod's filesystem) and an off-origin
// http(s) host (SSRF from the gate pod) -- both old enough to pass the age gate, so the URL check is what's
// actually on trial here, not a 404 from a young-version refusal (ei0.23)
const evilNpmPackument = (version: string, tarball: string) =>
  JSON.stringify({
    name: 'evilnpm',
    'dist-tags': { latest: version },
    versions: { [version]: { name: 'evilnpm', version, dist: { tarball } } },
    time: { created: '2020-01-01T00:00:00Z', modified: '2020-01-01T00:00:00Z', [version]: '2020-01-01T00:00:00Z' },
  })

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

// a project whose real distribution name is mixed-case (PyYAML): fileDecision/pypiSimple decide on the PEP
// 503 normalized form ("pyyaml"), so an allowlist entry written in the real name has to be normalized the
// same way to match (ei0.18)
const PYYAML_YOUNG_PATH = '/packages/yaml/synthetic/PyYAML-6.0.2.tar.gz'
const pyyamlIndex = (origin: string) =>
  JSON.stringify({
    name: 'PyYAML',
    files: [
      {
        filename: 'PyYAML-6.0.2.tar.gz',
        url: `${origin}${PYYAML_YOUNG_PATH}`,
        'upload-time': '2026-10-10T12:00:00.000Z', // ~12h before the test clock: too young without the allowlist
      },
    ],
  })

// PEP 691 allows a file `url` relative to the index URL; a mirror (devpi, Artifactory, Nexus) commonly sends
// one, unlike pypi.org itself (ei0.21). The resolved absolute URL lands on the *index* host, not necessarily
// the separate `files` upstream.
const RELPROJ_RELATIVE_FILE = 'relproj-1.0.0.tar.gz' // relative to /simple/relproj/
const relprojIndex = () =>
  JSON.stringify({
    name: 'relproj',
    files: [
      {
        filename: 'relproj-1.0.0.tar.gz',
        url: RELPROJ_RELATIVE_FILE,
        'upload-time': '2020-01-01T00:00:00Z', // old enough
      },
    ],
  })

// same probe as evilnpm above, for PyPI's own file `url` (ei0.23)
const evilPypiIndex = (filename: string, url: string) =>
  JSON.stringify({ name: filename, files: [{ filename, url, 'upload-time': '2020-01-01T00:00:00Z' }] })

// proves `PKG_GATE_UPSTREAM_FILES` is actually honored, on a host distinct from every other upstream in this
// file -- every other fixture here points `files` at the same fake server as everything else, so none of
// them could tell a real files-upstream fetch from one that was silently ignored (ei0.23)
const FILESPROJ_PATH = '/dist/goodfile-1.0.0.tar.gz'
let filesUpstream: ReturnType<typeof Bun.serve>
const filesprojIndex = (filesOrigin: string) =>
  JSON.stringify({
    name: 'filesproj',
    files: [{ filename: 'goodfile-1.0.0.tar.gz', url: `${filesOrigin}${FILESPROJ_PATH}`, 'upload-time': '2020-01-01T00:00:00Z' }],
  })

let upstream: ReturnType<typeof Bun.serve>
beforeAll(() => {
  filesUpstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === FILESPROJ_PATH) return new Response('FILEBYTES-fromfiles')
      return new Response('not found', { status: 404 })
    },
  })
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
      // a malicious/compromised upstream naming a tarball the gate must refuse to fetch verbatim (ei0.23)
      if (url.pathname === '/evilnpm-file')
        return new Response(evilNpmPackument('1.0.0', 'file:///etc/passwd'), { headers: { 'content-type': 'application/json' } })
      // reachable but never configured as this gate's npm upstream (it's the separate `files` fixture
      // server) -- proves the off-origin refusal by a byte-identical fetch that would otherwise succeed,
      // not merely by hitting a closed port (ei0.23)
      if (url.pathname === '/evilnpm-http')
        return new Response(evilNpmPackument('1.0.0', `${filesUpstream.url.origin}${FILESPROJ_PATH}`), {
          headers: { 'content-type': 'application/json' },
        })
      // a malformed upstream packument (a null version entry): proves a bad shape is refused as an upstream
      // error at the parse site, instead of throwing deep inside filterPackument and surfacing raw exception
      // text through the handler's catch-all (ei0.20)
      if (url.pathname === '/badpkg')
        return new Response(
          JSON.stringify({ name: 'badpkg', 'dist-tags': {}, versions: { '1.0.0': null }, time: { '1.0.0': '2020-01-01T00:00:00Z' } }),
          { headers: { 'content-type': 'application/json' } },
        )
      if (url.pathname === '/simple/requests/')
        return req.headers.get('accept') === 'application/vnd.pypi.simple.v1+json'
          ? new Response(pypiIndex(url.origin), { headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' } })
          : new Response(PYPI_LEGACY_HTML, { headers: { 'content-type': 'text/html' } }) // proves the gate always asks for PEP 691 JSON
      if (url.pathname === '/simple/pyyaml/')
        return req.headers.get('accept') === 'application/vnd.pypi.simple.v1+json'
          ? new Response(pyyamlIndex(url.origin), { headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' } })
          : new Response('', { status: 404 })
      if (url.pathname === '/simple/relproj/')
        return req.headers.get('accept') === 'application/vnd.pypi.simple.v1+json'
          ? new Response(relprojIndex(), { headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' } })
          : new Response('', { status: 404 })
      if (url.pathname === `/simple/relproj/${RELPROJ_RELATIVE_FILE}`) return new Response('FILEBYTES-relproj-1.0.0')
      // same probe as evilnpm above, for PyPI's own file `url` (ei0.23)
      if (url.pathname === '/simple/evilpypi-file/')
        return new Response(evilPypiIndex('evil.whl', 'file:///etc/passwd'), { headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' } })
      // reachable but, for the default `gate()` below, not a configured pypi/files upstream either (it's
      // the separate `files` fixture server) -- proves the off-origin refusal by a byte-identical fetch
      // that would otherwise succeed, not merely by hitting a closed port (ei0.23)
      if (url.pathname === '/simple/evilpypi-http/')
        return new Response(evilPypiIndex('evil.tar.gz', `${filesUpstream.url.origin}${FILESPROJ_PATH}`), {
          headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' },
        })
      // the file `url` here points at `filesUpstream`, a host distinct from this server, proving PKG_GATE_UPSTREAM_FILES
      // is honored and actually fetched from, not merely accepted and ignored (ei0.23)
      if (url.pathname === '/simple/filesproj/')
        return new Response(filesprojIndex(filesUpstream.url.origin), { headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' } })
      if (url.pathname === '/simple/missingproj/') return new Response('not found', { status: 404 })
      if (url.pathname === '/simple/brokenproj/') return new Response('internal error', { status: 500 })
      if (PYPI_FILES[url.pathname]) return new Response(PYPI_FILES[url.pathname])
      if (url.pathname === '/sumdb/sum.golang.org/tile/8/0/000')
        return new Response(SUMDB_TILE_BYTES, { headers: { 'content-type': 'application/octet-stream' } })
      // never responds: proves a hanging upstream is refused by the gate's own timeout, not left to hang (ei0.12)
      if (url.pathname === '/example.com/hangs/@v/v1.0.0.info') return new Promise<Response>(() => {})
      // claude-factory-8ub: index.golang.org's /index, which refreshGoFloor samples. Every `since` gets the
      // same 9 synthetic entries. Each entry's Timestamp sits inside the requested window. So the floor
      // always comes out as GO_FLOOR_RECORD (100), no matter which test's `now`/minDays asked for it.
      if (url.pathname === '/index') return new Response(goIndexBody(url.searchParams.get('since') ?? new Date(NOW).toISOString()))
      // claude-factory-8ub.6: sum.golang.org's /latest, read before every floor refresh's lookups. 1,000,000
      // sits far above every record id this file hands out, so the outlier filter never drops a sample here.
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(1_000_000))
      // sum.golang.org's /lookup/<mod>@<version>. A key with no fixture below defaults to GO_FLOOR_RECORD - 1
      // (at or below the floor). So every pre-existing "old enough" Go fixture in this file still passes,
      // with no record of its own.
      if (url.pathname.startsWith('/lookup/')) {
        const key = url.pathname.slice('/lookup/'.length)
        goLookupHits[key] = (goLookupHits[key] ?? 0) + 1
        if (GO_LOOKUP_500.has(key)) return new Response('internal error', { status: 500 })
        if (GO_LOOKUP_HANGS.has(key)) return new Promise<Response>(() => {})
        if (GO_LOOKUP_BAD_BODY[key]) return new Response(GO_LOOKUP_BAD_BODY[key])
        if (GO_FLOOR_RECORDS[key] !== undefined) return new Response(`${GO_FLOOR_RECORDS[key]}\n`)
        if (GO_HIGH_RECORDS[key] !== undefined) return new Response(`${GO_HIGH_RECORDS[key]}\n`)
        return new Response(`${GO_FLOOR_RECORD - 1}\n`)
      }
      const r = routes[url.pathname]
      if (!r) return new Response('not found', { status: 404 })
      return new Response(r.body, { status: r.status, headers: r.type ? { 'content-type': r.type } : {} })
    },
  })
})
afterAll(() => {
  upstream.stop(true)
  filesUpstream.stop(true)
})

// 2026-10-11T00:00:00Z: v0.43.0 (published 2026-10-09T15:18:32Z) is ~32.7h old, under the 4d minimum;
// v0.26.0 (2025-06-05) is far over it
const NOW = Date.parse('2026-10-11T00:00:00Z')
const base = () => upstream.url.origin
const gate = () =>
  makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
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
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
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
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
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

// claude-factory-8ub: the Go age gate also checks sum.golang.org's first-logged record, not only .info
// Time. AC1-AC10 below are the acceptance criteria from the goal's plan.

test('AC1: an .info Time 30d old but first logged in sum.golang.org after the floor is refused', async () => {
  const g = gate()
  const info = await g(new Request('http://gate/go/backdated.example.com/mod/@v/v1.0.0.info'))
  expect(info.status).toBe(404)
  expect(await info.text()).toBe('pkg-gate: backdated.example.com/mod@v1.0.0 first logged in sum.golang.org less than 4d ago, minimum 4d')
  const mod = await g(new Request('http://gate/go/backdated.example.com/mod/@v/v1.0.0.mod'))
  expect(mod.status).toBe(404)
  const zip = await g(new Request('http://gate/go/backdated.example.com/mod/@v/v1.0.0.zip'))
  expect(zip.status).toBe(404)
})

test('AC2: the same .info Time, with a sum.golang.org record at or below the floor, is allowed (control for AC1)', async () => {
  const g = gate()
  const info = await g(new Request('http://gate/go/loggedold.example.com/mod/@v/v1.0.0.info'))
  expect(info.status).toBe(200)
  expect(await info.text()).toBe(`{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
})

test('AC3: @v/list drops a version first logged in sum.golang.org after the floor; @latest falls back past it', async () => {
  const g = gate()
  const list = await g(new Request('http://gate/go/listfixture.example.com/mod/@v/list'))
  expect(list.status).toBe(200)
  expect(await list.text()).toBe('v1.0.0\n')
  const latest = await g(new Request('http://gate/go/listfixture.example.com/mod/@latest'))
  expect(latest.status).toBe(200)
  expect(await latest.json()).toMatchObject({ Version: 'v1.0.0' })
})

test('AC4: a sum.golang.org lookup that 500s, times out, or answers a non-numeric body is never an allow, and is never cached', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
    fetchTimeoutMs: 50,
  })
  for (const mod of ['lookupfail500.example.com/mod', 'lookuptimeout.example.com/mod', 'lookupbadbody.example.com/mod']) {
    const key = `${mod}@v1.0.0`
    const before = goLookupHits[key] ?? 0
    const first = await g(new Request(`http://gate/go/${mod}/@v/v1.0.0.info`))
    expect(first.status).toBe(502)
    const second = await g(new Request(`http://gate/go/${mod}/@v/v1.0.0.info`))
    expect(second.status).toBe(502)
    // each request made its own lookup: a failed lookup is never cached on the .info entry
    expect(goLookupHits[key] ?? 0).toBe(before + 2)
  }
})

test('AC5: a cold start with index.golang.org down refuses an old version (no floor), but still allows an allowlisted one with zero sumdb or index hits', async () => {
  let indexHits = 0
  let lookupHits = 0
  const deadIndex = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') {
        indexHits++
        return new Response('internal error', { status: 500 })
      }
      if (url.pathname.startsWith('/lookup/')) {
        lookupHits++
        return new Response('1\n')
      }
      if (url.pathname === '/coldstart.example.com/mod/@v/v1.0.0.info' || url.pathname === '/coldstart.example.com/allowed/@v/v1.0.0.info')
        return new Response(`{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({
      upstream: { go: deadIndex.url.origin, npm: base(), pypi: base(), files: base(), sumdb: deadIndex.url.origin, goIndex: deadIndex.url.origin },
      now: () => NOW,
      allowlist: { go: ['coldstart.example.com/allowed'] },
    })
    const old = await g(new Request('http://gate/go/coldstart.example.com/mod/@v/v1.0.0.info'))
    expect(old.status).toBe(502)
    const allowed = await g(new Request('http://gate/go/coldstart.example.com/allowed/@v/v1.0.0.info'))
    expect(allowed.status).toBe(200)
    expect(indexHits).toBe(1) // the non-allowlisted decision's one refresh attempt
    expect(lookupHits).toBe(0) // the allowlisted decision never reaches sum.golang.org
  } finally {
    deadIndex.stop(true)
  }
})

test('AC6: a failed floor refresh keeps the old floor; a later successful one raises it and never lowers it', async () => {
  let now = NOW
  let indexUp = true
  let recordOffset = 0
  // each version of the probe module carries its own fixed sum.golang.org record, so each call is a fresh
  // decision (never served from goInfoCache's forever cache), but still proves which floor was in force
  const probeRecords: Record<string, number> = { 'v1.0.0': 500, 'v2.0.0': 500, 'v3.0.0': 500, 'v4.0.0': 300 }
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') {
        if (!indexUp) return new Response('internal error', { status: 500 })
        return new Response(goIndexBody(url.searchParams.get('since') ?? new Date(now).toISOString()))
      }
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(1_000_000))
      if (url.pathname.startsWith('/lookup/')) {
        const key = url.pathname.slice('/lookup/'.length)
        const probeVersion = key.startsWith('floortiming.example.com/mod@') ? key.slice('floortiming.example.com/mod@'.length) : null
        if (probeVersion && probeRecords[probeVersion] !== undefined) return new Response(`${probeRecords[probeVersion]}\n`)
        const sample = GO_FLOOR_RECORDS[key]
        return new Response(`${(sample ?? GO_FLOOR_RECORD - 1) + recordOffset}\n`)
      }
      const m = url.pathname.match(/^\/floortiming\.example\.com\/mod\/@v\/(v[\d.]+)\.info$/)
      if (m) return new Response(`{"Version":"${m[1]}","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  // claude-factory-8ub.7: a decision with a present floor no longer waits for the refresh it triggers (it
  // decides with the old, still-safe floor right away). So each phase below drives one priming decision,
  // then waits for that refresh's own JSON line to land before reading /healthz or moving to the next phase
  // -- otherwise a slow refresh from one phase could still be in flight when the next phase changes the
  // fixture under it.
  const lines: string[] = []
  const origLog = console.log
  console.log = (s: string) => lines.push(s)
  try {
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => now,
    })
    // the floor builds at 100 (a cold start always waits for it); the probe's own record (500) outranks it
    const first = await g(new Request('http://gate/go/floortiming.example.com/mod/@v/v1.0.0.info'))
    expect(first.status).toBe(404)

    // a refresh is now due, but the index is down. This decision does not wait for it (claude-factory-8ub.7)
    // -- it still gets refused, because the old floor (100) is what decides it either way
    indexUp = false
    now += 31 * 60_000
    const m1 = lines.length
    const second = await g(new Request('http://gate/go/floortiming.example.com/mod/@v/v2.0.0.info'))
    expect(second.status).toBe(404)
    await waitForFloorRefresh(lines, m1) // let this failed attempt fully land before phase 3 changes the fixture

    // the index comes back, with every sample now higher. A priming decision starts the new refresh; once
    // it lands, the floor reads 700
    indexUp = true
    recordOffset = 600
    now += 31 * 60_000
    const m2 = lines.length
    await g(new Request('http://gate/go/floortiming.example.com/mod/@v/v0.5.0.info'))
    await waitForFloorRefresh(lines, m2)
    const healthzThird = await g(new Request('http://gate/healthz'))
    expect((await (healthzThird.json() as Promise<{ goFloor: { record: number } | null }>)).goFloor?.record).toBe(700)
    // the probe's own record (500) is now below the floor; the same probe, under a new version so its
    // decision does not come from cache, is allowed
    const third = await g(new Request('http://gate/go/floortiming.example.com/mod/@v/v3.0.0.info'))
    expect(third.status).toBe(200)

    // the index now reports a thinner window again (recordOffset back to 0, minimum 100). Once this refresh
    // lands too, the floor must still read 700 -- proof it never dropped back down to 100
    recordOffset = 0
    now += 31 * 60_000
    const m3 = lines.length
    await g(new Request('http://gate/go/floortiming.example.com/mod/@v/v0.6.0.info'))
    await waitForFloorRefresh(lines, m3)
    const healthzFourth = await g(new Request('http://gate/healthz'))
    expect((await (healthzFourth.json() as Promise<{ goFloor: { record: number } | null }>)).goFloor?.record).toBe(700)
    // a 4th probe version, with a record (300) between the two floors, is still allowed
    const fourth = await g(new Request('http://gate/go/floortiming.example.com/mod/@v/v4.0.0.info'))
    expect(fourth.status).toBe(200)
  } finally {
    console.log = origLog
    srv.stop(true)
  }
})

test('claude-factory-8ub.6: a floor refresh never trusts sample records logged only by its own lookup traffic', async () => {
  // 9 modules this fixture server's own /index answers with, regardless of `since`. Their sum.golang.org
  // records differ by phase (below), to prove the floor cannot be poisoned upward.
  const POISON_PATHS = Array.from({ length: 9 }, (_, i) => `poisonfloor-${String.fromCharCode(97 + i)}.example.com/mod`)
  const POISON_VERSION = 'v1.0.0'
  // phase 'honest': every sample sits far below sum.golang.org's tree size (1,000,000), so none is dropped,
  // and the floor comes out as their minimum, 50.
  const HONEST_IDS = [50, 51, 52, 53, 54, 55, 56, 57, 58]
  // phase 'poison': the tree size drops to 200 (as if read right after an attacker's own flood of lookups
  // grew it). 4 samples (60-63) still sit below it; the other 5 (250-290) do not -- they were logged no
  // earlier than this very refresh's own lookup traffic, so the fix drops them. Only 4 honest samples are
  // left, below GO_FLOOR_MIN_SAMPLES (5): this refresh must fail and keep the OLD floor, not jump toward 250.
  const POISON_IDS = [60, 61, 62, 63, 250, 260, 270, 280, 290]
  let phase: 'honest' | 'poison' = 'honest'
  let now = NOW
  // a probe module, separate from the sample paths, so its own decisions never feed the floor it is judged
  // against. Each version gets its own fixed record, so each decision is a fresh one (not goInfoCache's
  // forever cache of a prior version).
  const PROBE_RECORDS: Record<string, number> = { 'v1.0.0': 10, 'v2.0.0': 10, 'v3.0.0': 150 }
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') {
        const sinceMs = Date.parse(url.searchParams.get('since') ?? new Date(now).toISOString())
        const ts = new Date(sinceMs + 15 * 60_000).toISOString()
        return new Response(POISON_PATHS.map(p => JSON.stringify({ Path: p, Version: POISON_VERSION, Timestamp: ts })).join('\n') + '\n')
      }
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(phase === 'honest' ? 1_000_000 : 200))
      if (url.pathname.startsWith('/lookup/')) {
        const key = url.pathname.slice('/lookup/'.length)
        const probePrefix = 'poisonprobe.example.com/mod@'
        if (key.startsWith(probePrefix)) return new Response(`${PROBE_RECORDS[key.slice(probePrefix.length)] ?? 10}\n`)
        const idx = POISON_PATHS.findIndex(p => key === `${escapeGoPath(p)}@${escapeGoPath(POISON_VERSION)}`)
        const id = idx >= 0 ? (phase === 'honest' ? HONEST_IDS[idx] : POISON_IDS[idx]) : 999_999
        return new Response(`${id}\n`)
      }
      const m = url.pathname.match(/^\/poisonprobe\.example\.com\/mod\/@v\/(v[\d.]+)\.info$/)
      if (m) return new Response(`{"Version":"${m[1]}","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  const lines: string[] = []
  const origLog = console.log
  console.log = (s: string) => lines.push(s)
  try {
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => now,
    })
    // the honest phase establishes a floor of 50 (the minimum of 50..58); the probe's own record (10) sits
    // below it, so it is allowed
    const m0 = lines.length
    const first = await g(new Request('http://gate/go/poisonprobe.example.com/mod/@v/v1.0.0.info'))
    await waitForFloorRefresh(lines, m0)
    expect(first.status).toBe(200)
    const healthzHonest = await g(new Request('http://gate/healthz'))
    expect((await (healthzHonest.json() as Promise<{ goFloor: { record: number } | null }>)).goFloor?.record).toBe(50)

    // the poison phase: a priming decision triggers a background refresh; wait for it to land, then check
    // the floor never jumped toward the poisoned ids (250-290) -- it failed instead, and kept 50
    phase = 'poison'
    now += 31 * 60_000
    const m1 = lines.length
    await g(new Request('http://gate/go/poisonprobe.example.com/mod/@v/v2.0.0.info'))
    await waitForFloorRefresh(lines, m1)
    const healthzPoison = await g(new Request('http://gate/healthz'))
    expect((await (healthzPoison.json() as Promise<{ goFloor: { record: number } | null }>)).goFloor?.record).toBe(50)

    // decisive proof: a version whose own record (150) sits strictly between the honest floor (50) and the
    // poisoned peak (290) is still refused. A floor that had jumped to 250 (the old median+ratchet behavior)
    // would wrongly allow this one.
    const third = await g(new Request('http://gate/go/poisonprobe.example.com/mod/@v/v3.0.0.info'))
    expect(third.status).toBe(404)
  } finally {
    console.log = origLog
    srv.stop(true)
  }
})

test('claude-factory-8ub.7: a stale floor decides at once, and a down index backs off instead of retrying every decision', async () => {
  let indexHits = 0
  let now = NOW
  let indexUp = true
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') {
        indexHits++
        // a hang, not a fast 500: the gate's own fetchTimeoutMs (set below) is the only thing that ever
        // resolves this request, so a decision that waited on it would be slow enough for the timing
        // assertions below to catch -- a fast error response would not (claude-factory-8ub.7)
        if (!indexUp) return new Promise<Response>(() => {})
        return new Response(goIndexBody(url.searchParams.get('since') ?? new Date(now).toISOString()))
      }
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(1_000_000))
      if (url.pathname.startsWith('/lookup/')) {
        const key = url.pathname.slice('/lookup/'.length)
        return new Response(`${GO_FLOOR_RECORDS[key] ?? GO_FLOOR_RECORD - 1}\n`)
      }
      if (url.pathname === '/backoffprobe.example.com/mod/@v/v1.0.0.info') return new Response(`{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      if (url.pathname === '/backoffprobe.example.com/mod/@v/v2.0.0.info') return new Response(`{"Version":"v2.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      if (url.pathname === '/backoffprobe.example.com/mod/@v/v3.0.0.info') return new Response(`{"Version":"v3.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      if (url.pathname === '/backoffprobe.example.com/mod/@v/v4.0.0.info') return new Response(`{"Version":"v4.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  const lines: string[] = []
  const origLog = console.log
  console.log = (s: string) => lines.push(s)
  try {
    // a short fetchTimeoutMs keeps this test fast, and makes a blocked decision's wait (if the fix were
    // missing) long enough for the timing assertions below to tell it apart from an unblocked one
    const FETCH_TIMEOUT_MS = 2000
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => now,
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
    })
    // a cold start always awaits its own refresh, so this establishes a floor while the index is up
    const m0 = lines.length
    const first = await g(new Request('http://gate/go/backoffprobe.example.com/mod/@v/v1.0.0.info'))
    await waitForFloorRefresh(lines, m0)
    expect(first.status).toBe(200)
    expect(indexHits).toBe(1)

    // the index goes down (hangs), and the clock moves past the floor's window: the next decision is due a
    // refresh
    indexUp = false
    now += 31 * 60_000
    const m1 = lines.length
    const t1 = Date.now()
    const second = await g(new Request('http://gate/go/backoffprobe.example.com/mod/@v/v2.0.0.info'))
    const elapsed1 = Date.now() - t1
    // decided at once, with the old, still-safe floor -- not blocked on the refresh its own staleness just
    // triggered in the background (claude-factory-8ub.7). A decision that waited on the hanging index would
    // take at least FETCH_TIMEOUT_MS to come back.
    expect(second.status).toBe(200)
    expect(elapsed1).toBeLessThan(FETCH_TIMEOUT_MS / 2)
    await waitForFloorRefresh(lines, m1, 2000) // let that background refresh's own failure, and its backoff, land

    // two further decisions, issued once the first failure's backoff is already in force: neither starts a
    // new refresh, so the index sees no further requests from them
    const t2 = Date.now()
    const third = await g(new Request('http://gate/go/backoffprobe.example.com/mod/@v/v3.0.0.info'))
    const elapsed2 = Date.now() - t2
    expect(third.status).toBe(200)
    expect(elapsed2).toBeLessThan(FETCH_TIMEOUT_MS / 2)
    const fourth = await g(new Request('http://gate/go/backoffprobe.example.com/mod/@v/v4.0.0.info'))
    expect(fourth.status).toBe(200)

    // 1 for the initial floor build, 1 for the failed retry that set the backoff; the backoff suppressed
    // every retry after that
    expect(indexHits).toBe(2)
  } finally {
    console.log = origLog
    srv.stop(true)
  }
})

test('AC7: a version too young by .info Time alone makes no sum.golang.org or index.golang.org request', async () => {
  const before = goLookupHits['golang.org/x/text@v0.43.0'] ?? 0
  const g = gate()
  const r = await g(new Request('http://gate/go/golang.org/x/text/@v/v0.43.0.info'))
  expect(r.status).toBe(404)
  expect(goLookupHits['golang.org/x/text@v0.43.0'] ?? 0).toBe(before)
})

test('AC8: a @v/list of 20 versions, decided concurrently, causes exactly one index.golang.org request', async () => {
  let indexHits = 0
  const versions = Array.from({ length: 20 }, (_, i) => `v1.${i}.0`)
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') {
        indexHits++
        return new Response(goIndexBody(url.searchParams.get('since') ?? new Date(NOW).toISOString()))
      }
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(1_000_000))
      if (url.pathname.startsWith('/lookup/')) return new Response(`${GO_FLOOR_RECORD - 1}\n`)
      if (url.pathname === '/concurrent20.example.com/mod/@v/list') return new Response(versions.join('\n') + '\n')
      const m = url.pathname.match(/^\/concurrent20\.example\.com\/mod\/@v\/(v[\d.]+)\.info$/)
      if (m) return new Response(`{"Version":"${m[1]}","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => NOW,
    })
    const r = await g(new Request('http://gate/go/concurrent20.example.com/mod/@v/list'))
    expect(r.status).toBe(200)
    expect((await r.text()).trim().split('\n').length).toBe(20)
    expect(indexHits).toBe(1)
  } finally {
    srv.stop(true)
  }
})

test('AC9: index lines with bad JSON, missing fields, or a Timestamp outside the window are skipped; fewer than 5 good samples builds no floor', async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') {
        const sinceMs = Date.parse(url.searchParams.get('since')!)
        const inWindow = new Date(sinceMs + 15 * 60_000).toISOString()
        const outOfWindow = new Date(sinceMs - 60 * 60_000).toISOString() // before the window: must be skipped
        const lines = [
          'not json at all',
          JSON.stringify({ Path: 'thin-a.example.com/mod', Version: 'v1.0.0' }), // missing Timestamp
          JSON.stringify({ Path: 'thin-b.example.com/mod', Version: 'v1.0.0', Timestamp: outOfWindow }),
          JSON.stringify({ Path: 'thin-c.example.com/mod', Version: 'v1.0.0', Timestamp: inWindow }),
          JSON.stringify({ Path: 'thin-d.example.com/mod', Version: 'v1.0.0', Timestamp: inWindow }),
          JSON.stringify({ Path: 'thin-e.example.com/mod', Version: 'v1.0.0', Timestamp: inWindow }),
          JSON.stringify({ Path: 'thin-f.example.com/mod', Version: 'v1.0.0', Timestamp: inWindow }),
        ]
        return new Response(lines.join('\n') + '\n')
      }
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(1_000_000))
      if (url.pathname.startsWith('/lookup/')) return new Response('1\n')
      if (url.pathname === '/thin.example.com/mod/@v/v1.0.0.info') return new Response(`{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => NOW,
    })
    // only 4 lines are both well-formed and inside the window (thin-c..f): below GO_FLOOR_MIN_SAMPLES (5),
    // so no floor is built, and the decision is an error (502), not a pass-through
    const r = await g(new Request('http://gate/go/thin.example.com/mod/@v/v1.0.0.info'))
    expect(r.status).toBe(502)
  } finally {
    srv.stop(true)
  }
})

test('AC10: a floor refresh looks up a sampled module under the Path case-encoding a real go command sends, not its raw casing', async () => {
  const g = gate() // a fresh gate: its own goFloor starts null, so the next decision forces a refresh
  await g(new Request('http://gate/go/golang.org/x/text/@v/v0.26.0.info'))
  expect(goLookupHits['github.com/!azure/floorsample@v1.0.0']).toBeGreaterThan(0)
  expect(goLookupHits['github.com/Azure/floorsample@v1.0.0']).toBeUndefined()
})

test('AC11: /healthz shows the sumdb goFloor as null, then {record, at}; a successful refresh logs one line naming no URL', async () => {
  const lines: string[] = []
  const orig = console.log
  console.log = (s: string) => lines.push(s)
  try {
    const g = gate() // a fresh gate: its own goFloor starts null
    const before = await g(new Request('http://gate/healthz'))
    expect((await before.json() as { goFloor: unknown }).goFloor).toBeNull()

    await g(new Request('http://gate/go/golang.org/x/text/@v/v0.26.0.info')) // allow: forces the first refresh

    const after = await g(new Request('http://gate/healthz'))
    expect((await after.json() as { goFloor: unknown }).goFloor).toEqual({ record: GO_FLOOR_RECORD, at: '2026-10-07T00:00:00.000Z' })

    const parsed = lines.map(l => JSON.parse(l))
    const floorLine = parsed.find(l => l.eco === 'go' && typeof l.floor === 'number')
    expect(floorLine).toMatchObject({ eco: 'go', floor: GO_FLOOR_RECORD, at: '2026-10-07T00:00:00.000Z', samples: 9 })
    for (const l of lines) expect(l).not.toContain('http')
  } finally {
    console.log = orig
  }
})

test('AC11: a failed floor refresh (index.golang.org down) logs a decision:\'error\' line naming no URL', async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') return new Response('internal error', { status: 500 })
      if (url.pathname === '/healthzfail.example.com/mod/@v/v1.0.0.info') return new Response(`{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  const lines: string[] = []
  const orig = console.log
  console.log = (s: string) => lines.push(s)
  try {
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => NOW,
    })
    await g(new Request('http://gate/go/healthzfail.example.com/mod/@v/v1.0.0.info'))
    const parsed = lines.map(l => JSON.parse(l))
    const errLine = parsed.find(l => l.decision === 'error' && typeof l.reason === 'string' && l.reason.startsWith('sumdb floor refresh'))
    expect(errLine).toBeDefined()
    for (const l of lines) expect(l).not.toContain('http')
  } finally {
    console.log = orig
    srv.stop(true)
  }
})

test('claude-factory-8ub.8: a sumdb lookup escapes an uppercase prerelease in the .info body\'s Version, not just the module path', async () => {
  // "v1.0.0-RC1" is the .info body's raw Version. The sumdb lookup key must use its Go-case-escaped form,
  // the same way index.golang.org's Path is already escaped elsewhere (AC10). This server answers only
  // that escaped key; the raw, unescaped form (the bug) is a lookup miss.
  const rawVersion = 'v1.0.0-RC1'
  const escapedVersion = escapeGoPath(rawVersion)
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') return new Response(goIndexBody(url.searchParams.get('since') ?? new Date(NOW).toISOString()))
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(1_000_000))
      if (url.pathname.startsWith('/lookup/')) {
        const key = url.pathname.slice('/lookup/'.length)
        if (key === `rcversion.example.com/mod@${escapedVersion}`) return new Response('10\n')
        if (GO_FLOOR_RECORDS[key] !== undefined) return new Response(`${GO_FLOOR_RECORDS[key]}\n`)
        return new Response('not found', { status: 404 })
      }
      if (url.pathname === `/rcversion.example.com/mod/@v/${escapedVersion}.info`)
        return new Response(`{"Version":"${rawVersion}","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => NOW,
    })
    const r = await g(new Request(`http://gate/go/rcversion.example.com/mod/@v/${escapedVersion}.info`))
    expect(r.status).toBe(200)
  } finally {
    srv.stop(true)
  }
})

test('claude-factory-8ub.9: @latest caches its own sumdb record, so a second @latest for the same version skips the lookup', async () => {
  let lookupHits = 0
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') return new Response(goIndexBody(url.searchParams.get('since') ?? new Date(NOW).toISOString()))
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(1_000_000))
      if (url.pathname.startsWith('/lookup/')) {
        lookupHits++
        const key = url.pathname.slice('/lookup/'.length)
        return new Response(`${GO_FLOOR_RECORDS[key] ?? GO_FLOOR_RECORD - 1}\n`)
      }
      if (url.pathname === '/latestcache.example.com/mod/@latest') return new Response(`{"Version":"v1.0.0","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => NOW,
    })
    const first = await g(new Request('http://gate/go/latestcache.example.com/mod/@latest'))
    expect(first.status).toBe(200)
    const hitsAfterFirst = lookupHits
    expect(hitsAfterFirst).toBeGreaterThan(0) // the cold-start floor build plus the probe's own lookup
    const second = await g(new Request('http://gate/go/latestcache.example.com/mod/@latest'))
    expect(second.status).toBe(200)
    // the second @latest reuses the cached record from the first (claude-factory-8ub.9); no new lookup
    expect(lookupHits).toBe(hitsAfterFirst)
  } finally {
    srv.stop(true)
  }
})

test("claude-factory-8ub.13: an uppercase prerelease .info caches, so a third request repeats neither the .info fetch nor the sumdb lookup", async () => {
  // "v1.0.0-RC1" is the .info body's raw Version. goDecideVersion's cache guard compared that raw form
  // against the escaped path segment (v1.0.0-!r!c1) and never matched, so every request repeated both the
  // .info fetch and the sumdb lookup. This server 404s on anything but the exact escaped key, so a bug that
  // looks up or fetches the unescaped form shows up as an error, not a silent extra hit.
  const rawVersion = 'v1.0.0-RC1'
  const escapedVersion = escapeGoPath(rawVersion)
  let infoHits = 0
  let lookupHits = 0
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/index') return new Response(goIndexBody(url.searchParams.get('since') ?? new Date(NOW).toISOString()))
      if (url.pathname === '/latest') return new Response(sumdbLatestBody(1_000_000))
      if (url.pathname.startsWith('/lookup/')) {
        const key = url.pathname.slice('/lookup/'.length)
        if (key === `rc13.example.com/mod@${escapedVersion}`) {
          lookupHits++
          return new Response('10\n')
        }
        if (GO_FLOOR_RECORDS[key] !== undefined) return new Response(`${GO_FLOOR_RECORDS[key]}\n`)
        return new Response('not found', { status: 404 })
      }
      if (url.pathname === `/rc13.example.com/mod/@v/${escapedVersion}.info`) {
        infoHits++
        return new Response(`{"Version":"${rawVersion}","Time":"${GO_INFO_BACKDATED_TIME}"}`)
      }
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const g = makeGate({
      upstream: { go: srv.url.origin, npm: base(), pypi: base(), files: base(), sumdb: srv.url.origin, goIndex: srv.url.origin },
      now: () => NOW,
    })
    for (let i = 0; i < 3; i++) {
      const r = await g(new Request(`http://gate/go/rc13.example.com/mod/@v/${escapedVersion}.info`))
      expect(r.status).toBe(200)
    }
    expect(infoHits).toBe(1)
    expect(lookupHits).toBe(1)
  } finally {
    srv.stop(true)
  }
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
    const g = makeGate({ upstream: { go: counting.url.origin, npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() }, now: () => NOW })
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
    const g = makeGate({ upstream: { go: moving.url.origin, npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() }, now: () => NOW })
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
    const g = makeGate({ upstream: { go: flaky.url.origin, npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() }, now: () => NOW })
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
      upstream: { go: base(), npm: counting.url.origin, pypi: base(), files: base(), sumdb: base(), goIndex: base() },
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
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
    allowlist: { go: ['allowed.example.com/mod'] },
  })
  const r = await g(new Request('http://gate/go/allowed.example.com/mod/@v/v9.9.9.info'))
  expect(r.status).toBe(200)
  expect(await r.text()).toBe(GO_ALLOWLISTED_INFO)
})

test('an allowlist entry in a Go module\'s real casing matches the proxy protocol\'s !-case-encoded path (ei0.18)', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
    allowlist: { go: ['github.com/Azure/azure-sdk-for-go'] }, // real casing, not the !azure the proxy sends
  })
  const r = await g(new Request('http://gate/go/github.com/!azure/azure-sdk-for-go/@v/v1.0.0.info'))
  expect(r.status).toBe(200)
})

test('a Go allowlist entry already in the proxy\'s lowercase-escaped form does not match the real uppercase module (the missing ei0.18 negative, ei0.22)', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
    allowlist: { go: ['github.com/azure/azure-sdk-for-go'] }, // lowercase "azure": the real module is "Azure"
  })
  const r = await g(new Request('http://gate/go/github.com/!azure/azure-sdk-for-go/@v/v1.0.0.info'))
  expect(r.status).toBe(404) // goModuleUnescape(path) => "...Azure...", which != the lowercase entry
})

test('an allowlist entry in a PyPI project\'s real casing matches its PEP 503 normalized name (ei0.18)', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
    allowlist: { pypi: ['PyYAML'] }, // real casing, not the PEP 503 "pyyaml" fileDecision compares
  })
  const r = await g(new Request('http://gate/pypi/simple/PyYAML/'))
  expect(r.status).toBe(200)
  const idx = (await r.json()) as { files: { filename: string }[] }
  expect(idx.files.map(f => f.filename)).toEqual(['PyYAML-6.0.2.tar.gz'])
})

test('an allowlist entry for one ecosystem does not unlock the same name in another (ei0.22)', async () => {
  // "allowed.example.com/mod" is the Go fixture's module name; allowlisting it for pypi/npm only must not
  // let the Go module through -- one shared list let an entry for one ecosystem unlock the same name
  // (typosquat surface) in the others
  const pypiOnly = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
    allowlist: { pypi: ['allowed.example.com/mod'] },
  })
  const r1 = await pypiOnly(new Request('http://gate/go/allowed.example.com/mod/@v/v9.9.9.info'))
  expect(r1.status).toBe(404)

  const npmOnly = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
    allowlist: { npm: ['allowed.example.com/mod'] },
  })
  const r2 = await npmOnly(new Request('http://gate/go/allowed.example.com/mod/@v/v9.9.9.info'))
  expect(r2.status).toBe(404)

  // and the reverse: a Go entry does not allowlist the same-spelled PyPI project
  const goOnly = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
    allowlist: { go: ['pyyaml'] },
  })
  const r3 = await goOnly(new Request('http://gate/pypi/simple/pyyaml/'))
  expect(r3.status).toBe(200) // the index itself always serves
  const idx = (await r3.json()) as { files: { filename: string }[] }
  expect(idx.files).toHaveLength(0) // but the young file inside it is still refused, not allowlisted
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

test('an npm tarball url of file:// is refused before fetch, never reading the gate pod\'s filesystem (ei0.23)', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/npm/evilnpm-file/-/passwd'))
  const body = await r.text()
  expect(r.status).toBe(502)
  expect(body).toContain('pkg-gate')
  expect(body).not.toContain('root:') // would appear if /etc/passwd were actually read back
})

test('an npm tarball url on an unconfigured (off-origin) host is refused, even though that host would really answer (ei0.23)', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/npm/evilnpm-http/-/goodfile-1.0.0.tar.gz'))
  expect(r.status).toBe(502)
  expect(await r.text()).toContain('pkg-gate')
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

test('a PEP 691 file url relative to the index (a devpi/Artifactory/Nexus mirror, not pypi.org) is resolved and gated, not thrown on (ei0.21)', async () => {
  const g = gate()
  const idxResp = await g(new Request('http://gate/pypi/simple/relproj/'))
  expect(idxResp.status).toBe(200)
  const idx = (await idxResp.json()) as { files: { filename: string; url: string }[] }
  expect(idx.files).toHaveLength(1)
  const rewrittenUrl = idx.files[0]!.url
  expect(rewrittenUrl).toBe(`http://gate/pypi/files/relproj/simple/relproj/${RELPROJ_RELATIVE_FILE}`)

  const fileResp = await g(new Request(rewrittenUrl))
  expect(fileResp.status).toBe(200)
  expect(await fileResp.text()).toBe('FILEBYTES-relproj-1.0.0')
})

test('a PyPI file url of file:// is refused before fetch, never reading the gate pod\'s filesystem (ei0.23)', async () => {
  const g = gate()
  const r = await g(new Request('http://gate/pypi/files/evilpypi-file/etc/passwd'))
  const body = await r.text()
  expect(r.status).toBe(502)
  expect(body).toContain('pkg-gate')
  expect(body).not.toContain('root:') // would appear if /etc/passwd were actually read back
})

test('a PyPI file url on an unconfigured (off-origin) host is refused, even though that host would really answer (ei0.23)', async () => {
  const g = gate()
  const r = await g(new Request(`http://gate/pypi/files/evilpypi-http${FILESPROJ_PATH}`))
  expect(r.status).toBe(502)
  expect(await r.text()).toContain('pkg-gate')
})

test('a PyPI file url on the separate `files` upstream is fetched and served; PKG_GATE_UPSTREAM_FILES is honored, not dead (ei0.23)', async () => {
  // unlike every other test in this file, `files` is genuinely a different host than `pypi` here -- the only
  // way to tell a real fetch from it apart from one that silently never happens
  const g = makeGate({ upstream: { go: base(), npm: base(), pypi: base(), files: filesUpstream.url.origin, sumdb: base(), goIndex: base() }, now: () => NOW })
  const r = await g(new Request('http://gate/pypi/files/filesproj/dist/goodfile-1.0.0.tar.gz'))
  expect(r.status).toBe(200)
  expect(await r.text()).toBe('FILEBYTES-fromfiles')
})

test('/healthz reports minDays, the allow/refuse/error counters since start, and the sumdb goFloor (claude-factory-8ub)', async () => {
  const g = gate()
  const before = await g(new Request('http://gate/healthz'))
  expect(before.status).toBe(200)
  expect(await before.json()).toEqual({ ok: true, minDays: 4, goFloor: null, allow: 0, refuse: 0, error: 0 })

  await g(new Request('http://gate/go/golang.org/x/text/@v/v0.26.0.info')) // allow: also builds the floor
  await g(new Request('http://gate/go/golang.org/x/text/@v/v0.43.0.info')) // refuse
  await g(new Request('http://gate/go/example.com/bad500/@v/v1.0.0.info')) // error

  const after = await g(new Request('http://gate/healthz'))
  // minDays:4 at NOW (2026-10-11T00:00:00Z): the floor's window ends at now-4d
  expect(await after.json()).toEqual({
    ok: true,
    minDays: 4,
    goFloor: { record: GO_FLOOR_RECORD, at: '2026-10-07T00:00:00.000Z' },
    allow: 1,
    refuse: 1,
    error: 1,
  })
})

test('makeGate throws on a non-finite or negative minDays instead of silently allowing everything (ei0.10)', () => {
  const cfg = { upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() } }
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

test('a malformed upstream packument (a null version entry) is a fixed-text 5xx, never echoing the exception, with one error log line (ei0.20)', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    now: () => NOW,
  })
  const lines: string[] = []
  const orig = console.log
  console.log = (s: string) => lines.push(s)
  let r: Response
  try {
    r = await g(new Request('http://gate/npm/badpkg'))
  } finally {
    console.log = orig
  }
  expect(r.status).toBeGreaterThanOrEqual(500)
  const text = await r.text()
  expect(text).toContain('pkg-gate')
  expect(text).not.toContain('null') // no exception text (e.g. "null is not an object (evaluating vd.dist)")
  expect(text).not.toContain('evaluating')
  const errorLines = lines.map(l => JSON.parse(l)).filter(p => p.decision === 'error')
  expect(errorLines.length).toBeGreaterThanOrEqual(1)
  // caught at parsePackument, not merely by the handler's generic catch-all (whose own log line carries no
  // eco/name): proves the bad shape never got as far as throwing inside filterPackument
  expect(errorLines[0]).toMatchObject({ eco: 'npm', name: 'badpkg' })
  const health = await g(new Request('http://gate/healthz'))
  expect((await health.json() as { error: number }).error).toBeGreaterThanOrEqual(1)
})

test('a non-URIError thrown from the handler is a fixed-text 502, never echoing the exception, with one error log line (ei0.20)', async () => {
  const g = makeGate({
    upstream: { go: base(), npm: base(), pypi: base(), files: base(), sumdb: base(), goIndex: base() },
    // a generic throw from anywhere other code calls into (here: the injected clock), not decodeURIComponent's
    // URIError, must still never reach the response body and must still count/log as an error (ei0.20)
    now: () => {
      throw new Error('boom: should never reach the response body')
    },
  })
  const lines: string[] = []
  const orig = console.log
  console.log = (s: string) => lines.push(s)
  let r: Response
  try {
    r = await g(new Request('http://gate/go/golang.org/x/text/@v/v0.26.0.info'))
  } finally {
    console.log = orig
  }
  expect(r.status).toBe(502)
  expect(await r.text()).toBe('pkg-gate: internal error')
  const errorLines = lines.map(l => JSON.parse(l)).filter(p => p.decision === 'error')
  expect(errorLines.length).toBeGreaterThanOrEqual(1)
})

test('PyPI upstream errors refuse rather than pass through', async () => {
  const g = gate()
  const notFound = await g(new Request('http://gate/pypi/simple/missingproj/'))
  expect(notFound.status).toBe(404)
  const broken = await g(new Request('http://gate/pypi/simple/brokenproj/'))
  expect(broken.status).toBe(502)
  expect(await broken.text()).toContain('pkg-gate')
})
