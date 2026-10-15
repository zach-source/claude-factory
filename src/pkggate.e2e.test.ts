import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from './pkggate'

// Real-toolchain e2e: each test below runs the actual go/npm/pip/uv binary (not a fixture of one) against
// `serve()` plus a fake upstream, to prove the gate refuses a young version/file through the real protocol
// each tool speaks, not just through `fetch`. Bun.which resolves the real PATH binary directly, bypassing a
// shell-function wrapper such as pkg-guard's (confirmed on this machine: `file $(Bun.which('go'))` etc. are
// real binaries, not scripts) -- the same way `nix shell nixpkgs#go -c go get ...` did in claude-factory-ei0.
// A binary missing from PATH skips its test (test.if); see claude-factory-ei0.4's report for which ran.
const GO = Bun.which('go')
const NPM = Bun.which('npm')
const PIP = Bun.which('pip')
const UV = Bun.which('uv')
const PYTHON3 = Bun.which('python3')
// only used to build the Go module zip and the PyPI wheel fixtures below, never to run a tool under test
const ZIP = Bun.which('zip')

const scratch = mkdtempSync(join(tmpdir(), 'pkggate-e2e-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const NOW = Date.now()
const OLD_TIME = new Date(NOW - 6 * 24 * 3600_000).toISOString() // 6d old: over the 4d minimum
const YOUNG_TIME = new Date(NOW - 1 * 24 * 3600_000).toISOString() // 1d old: under it

// Bun.spawnSync would block this thread's event loop while its child waits on a response from Bun.serve
// (the gate and fake upstream below, both served on this same thread) -- a deadlock. Bun.spawn plus await
// keeps the loop running so the server side of the same process can answer.
async function run(cmd: string[], env: Record<string, string | undefined>) {
  const p = Bun.spawn(cmd, { cwd: scratch, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  return { code, out, err }
}

// --- Go module zip, built with `zip` (real toolchain fixture, not a hand-rolled zip format) -----------

const GO_MODULE = 'example.com/pkggate-e2e-fixture'
// claude-factory-8ub, AC12: a version whose .info Time alone is old enough (OLD_TIME, like v1.0.0), but
// whose sum.golang.org record sits far above the floor -- a backdated commit on a freshly tagged version
const GO_BACKDATED_VERSION = 'v1.0.2'
function buildGoZip(version: string): Buffer {
  const root = join(scratch, `gozip-${version}`, `${GO_MODULE}@${version}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'go.mod'), `module ${GO_MODULE}\n\ngo 1.21\n`)
  writeFileSync(join(root, 'fixture.go'), 'package fixture\n\nconst X = 1\n')
  const zipPath = join(scratch, `gozip-${version}.zip`)
  const r = Bun.spawnSync(['zip', '-X', '-r', zipPath, `${GO_MODULE}@${version}`], {
    cwd: join(scratch, `gozip-${version}`),
  })
  if (r.exitCode !== 0) throw new Error(`zip: ${r.stderr.toString()}`)
  return readFileSync(zipPath)
}

// --- npm tarball, built with `npm pack` on a throwaway local package (works fully offline) -------------

const NPM_PKG = 'pkggate-e2e-fixture'
function buildNpmTarball(version: string): Buffer {
  const pkgDir = join(scratch, `npmpkg-${version}`)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: NPM_PKG, version }))
  writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {}\n')
  const outDir = join(scratch, `npmpack-${version}`)
  mkdirSync(outDir, { recursive: true })
  const r = Bun.spawnSync([NPM!, 'pack', '--pack-destination', outDir], { cwd: pkgDir })
  if (r.exitCode !== 0) throw new Error(`npm pack: ${r.stderr.toString()}`)
  return readFileSync(join(outDir, `${NPM_PKG}-${version}.tgz`))
}

// --- PyPI wheel, built with `zip` (a wheel is just a zip with dist-info metadata; pip never opens it to
// download a single pinned version, so a minimal one proves the gate's refusal without a real build) ----

const PY_PROJECT = 'pkggate-e2e-fixture'
const PY_DIST = 'pkggate_e2e_fixture'
function buildWheel(version: string): Buffer {
  const stage = join(scratch, `wheel-${version}`)
  const distInfo = join(stage, `${PY_DIST}-${version}.dist-info`)
  mkdirSync(distInfo, { recursive: true })
  writeFileSync(join(distInfo, 'METADATA'), `Metadata-Version: 2.1\nName: ${PY_PROJECT}\nVersion: ${version}\n`)
  writeFileSync(join(distInfo, 'WHEEL'), 'Wheel-Version: 1.0\nGenerator: pkggate-e2e\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
  writeFileSync(join(distInfo, 'RECORD'), '')
  const whlPath = join(scratch, `${PY_DIST}-${version}-py3-none-any.whl`)
  const r = Bun.spawnSync(['zip', '-X', '-r', whlPath, `${PY_DIST}-${version}.dist-info`], { cwd: stage })
  if (r.exitCode !== 0) throw new Error(`zip: ${r.stderr.toString()}`)
  return readFileSync(whlPath)
}

let fixtures: {
  goZipOld?: Buffer
  goZipYoung?: Buffer
  npmTarOld?: Buffer
  npmTarYoung?: Buffer
  wheelOld?: Buffer
  wheelYoung?: Buffer
} = {}
if (GO && ZIP) {
  fixtures.goZipOld = buildGoZip('v1.0.0')
  fixtures.goZipYoung = buildGoZip('v1.0.1')
}
if (NPM) {
  fixtures.npmTarOld = buildNpmTarball('1.0.0')
  fixtures.npmTarYoung = buildNpmTarball('1.0.1')
}
if (ZIP) {
  fixtures.wheelOld = buildWheel('1.0.0')
  fixtures.wheelYoung = buildWheel('1.0.1')
}

// one fake upstream answering all three ecosystems, keyed by the fixtures actually built above
let upstream: ReturnType<typeof Bun.serve>

// claude-factory-1hc: a fake sumdb server, apart from `upstream` (the fake go proxy).
//
// It proves the real socket test below routes to cfg.upstream.sumdb, not to a server that answers only
// because the fixture points go and sumdb at the same origin.
let sumdbUpstream: ReturnType<typeof Bun.serve>
let sumdbSupportedHits = 0
let gate: ReturnType<typeof serve>
let gateBase: string
beforeAll(async () => {
  sumdbUpstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      // sum.golang.org itself has no /supported path; it answers 404 there too. The gate must answer
      // /supported itself with zero fetch (claude-factory-1hc), so a hit here would be a regression.
      if (url.pathname === '/supported') {
        sumdbSupportedHits++
        return new Response('not found', { status: 404 })
      }
      // a transparency-log tile is raw hash bytes (binary, not text): proves the gate's /go/sumdb/ passthrough
      // survives a real Bun.serve HTTP socket round-trip byte-identical, not just the in-process handler call
      // pkggate.test.ts already covers (ei0.8; go's real GOSUMDB default needs a signed tree this fake sumdb
      // can't produce, so the `go mod download` test below still runs with GOSUMDB=off)
      if (url.pathname === '/tile/8/0/000')
        return new Response(new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x00, 0xff, 0x80, 0xc3]), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      // claude-factory-8ub: the gate's sumdb upstream points at this server. /lookup/ answers every key
      // with a low record (1), so it always sits at or below the floor this builds (also 1). /latest
      // (claude-factory-8ub.6) answers with a tree size far above every record id here, so none is ever
      // dropped as an outlier.
      if (url.pathname === '/latest') return new Response('go.sum database tree\n1000000\nfakehash\n\n— sum.golang.org fakesignature\n')
      // the backdated probe's own record sits far above the floor (1); every other lookup defaults low (AC12)
      if (url.pathname === `/lookup/${GO_MODULE}@${GO_BACKDATED_VERSION}`) return new Response('999999\n')
      if (url.pathname.startsWith('/lookup/')) return new Response('1\n')
      return new Response('not found', { status: 404 })
    },
  })
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      // claude-factory-8ub: the gate's goIndex upstream points at this fake server. /index answers any
      // `since` with 5 synthetic entries inside the requested window.
      if (url.pathname === '/index') {
        const sinceMs = Date.parse(url.searchParams.get('since') ?? new Date(NOW).toISOString())
        const ts = new Date(sinceMs + 15 * 60_000).toISOString()
        const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ Path: `floorsample-${i}.example.com/mod`, Version: 'v1.0.0', Timestamp: ts }))
        return new Response(lines.join('\n') + '\n')
      }
      if (url.pathname === `/${GO_MODULE}/@v/list`) return new Response('v1.0.0\nv1.0.1\n')
      if (url.pathname === `/${GO_MODULE}/@v/v1.0.0.info`)
        return new Response(JSON.stringify({ Version: 'v1.0.0', Time: OLD_TIME }), { headers: { 'content-type': 'application/json' } })
      if (url.pathname === `/${GO_MODULE}/@v/${GO_BACKDATED_VERSION}.info`)
        return new Response(JSON.stringify({ Version: GO_BACKDATED_VERSION, Time: OLD_TIME }), { headers: { 'content-type': 'application/json' } })
      if (url.pathname === `/${GO_MODULE}/@v/v1.0.1.info`)
        return new Response(JSON.stringify({ Version: 'v1.0.1', Time: YOUNG_TIME }), { headers: { 'content-type': 'application/json' } })
      if (url.pathname === `/${GO_MODULE}/@v/v1.0.0.mod` || url.pathname === `/${GO_MODULE}/@v/v1.0.1.mod`)
        return new Response(`module ${GO_MODULE}\n\ngo 1.21\n`)
      if (url.pathname === `/${GO_MODULE}/@v/v1.0.0.zip` && fixtures.goZipOld) return new Response(fixtures.goZipOld)
      if (url.pathname === `/${GO_MODULE}/@v/v1.0.1.zip` && fixtures.goZipYoung) return new Response(fixtures.goZipYoung)

      if (url.pathname === `/${NPM_PKG}` && fixtures.npmTarOld && fixtures.npmTarYoung) {
        const body = JSON.stringify({
          name: NPM_PKG,
          'dist-tags': { latest: '1.0.1' },
          versions: {
            '1.0.0': { name: NPM_PKG, version: '1.0.0', dist: { tarball: `${url.origin}/${NPM_PKG}/-/${NPM_PKG}-1.0.0.tgz`, shasum: 'x' } },
            '1.0.1': { name: NPM_PKG, version: '1.0.1', dist: { tarball: `${url.origin}/${NPM_PKG}/-/${NPM_PKG}-1.0.1.tgz`, shasum: 'y' } },
          },
          time: { created: OLD_TIME, modified: YOUNG_TIME, '1.0.0': OLD_TIME, '1.0.1': YOUNG_TIME },
        })
        return new Response(body, { headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname === `/${NPM_PKG}/-/${NPM_PKG}-1.0.0.tgz` && fixtures.npmTarOld) return new Response(fixtures.npmTarOld)
      if (url.pathname === `/${NPM_PKG}/-/${NPM_PKG}-1.0.1.tgz` && fixtures.npmTarYoung) return new Response(fixtures.npmTarYoung)

      if (url.pathname === `/simple/${PY_PROJECT}/` && fixtures.wheelOld && fixtures.wheelYoung) {
        const body = JSON.stringify({
          name: PY_PROJECT,
          files: [
            // core-metadata: true (PEP 658/714, no pinned hash) makes a real pip 25.3 GET <url>.metadata
            // with no fallback (ei0.9) before downloading the wheel itself
            {
              filename: `${PY_DIST}-1.0.0-py3-none-any.whl`,
              url: `${url.origin}/files/${PY_DIST}-1.0.0-py3-none-any.whl`,
              'upload-time': OLD_TIME,
              hashes: {},
              'core-metadata': true,
            },
            { filename: `${PY_DIST}-1.0.1-py3-none-any.whl`, url: `${url.origin}/files/${PY_DIST}-1.0.1-py3-none-any.whl`, 'upload-time': YOUNG_TIME, hashes: {} },
          ],
        })
        return new Response(body, { headers: { 'content-type': 'application/vnd.pypi.simple.v1+json' } })
      }
      if (url.pathname === `/files/${PY_DIST}-1.0.0-py3-none-any.whl` && fixtures.wheelOld) return new Response(fixtures.wheelOld)
      if (url.pathname === `/files/${PY_DIST}-1.0.1-py3-none-any.whl` && fixtures.wheelYoung) return new Response(fixtures.wheelYoung)
      // the same METADATA content buildWheel() packed into the wheel's own .dist-info, served separately
      if (url.pathname === `/files/${PY_DIST}-1.0.0-py3-none-any.whl.metadata`)
        return new Response(`Metadata-Version: 2.1\nName: ${PY_PROJECT}\nVersion: 1.0.0\n`)

      return new Response('not found', { status: 404 })
    },
  })
  const base = upstream.url.origin
  const sumdbBase = sumdbUpstream.url.origin
  gate = serve({ upstream: { go: base, npm: base, pypi: base, files: base, sumdb: sumdbBase, goIndex: base }, port: 0 })
  gateBase = gate.url.origin
  // a real-process client (go/npm/pip/uv) can hit a connection reset if it is the very first inbound
  // connection right after Bun.serve returns; warm up every server with a real fetch before any test runs
  await fetch(`${gateBase}/healthz`)
  await fetch(`${base}/`).catch(() => {})
  await fetch(`${sumdbBase}/`).catch(() => {})
})
afterAll(() => {
  upstream.stop(true)
  sumdbUpstream.stop(true)
  gate.stop(true)
})

test('a binary sumdb tile passes through serve()\'s real HTTP socket byte-identical (ei0.8), fetched from the distinct sumdb fake', async () => {
  const r = await fetch(`${gateBase}/go/sumdb/sum.golang.org/tile/8/0/000`)
  expect(r.status).toBe(200)
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x00, 0xff, 0x80, 0xc3]))
})

test('claude-factory-1hc AC6: GET /go/sumdb/sum.golang.org/supported is 200 over the real socket, with zero hit on the sumdb fake (it 404s /supported)', async () => {
  const before = sumdbSupportedHits
  const r = await fetch(`${gateBase}/go/sumdb/sum.golang.org/supported`)
  expect(r.status).toBe(200)
  expect(sumdbSupportedHits).toBe(before)
})

test('AC12: a backdated version (.info old enough, record above the floor) is refused through serve()\'s real socket; an old one with a low record still serves (claude-factory-8ub)', async () => {
  const backdated = await fetch(`${gateBase}/go/${GO_MODULE}/@v/${GO_BACKDATED_VERSION}.info`)
  expect(backdated.status).toBe(404)
  expect(await backdated.text()).toContain('first logged in sum.golang.org')

  const old = await fetch(`${gateBase}/go/${GO_MODULE}/@v/v1.0.0.info`)
  expect(old.status).toBe(200)
  expect(await old.json()).toMatchObject({ Version: 'v1.0.0' })
})

test.if(!!GO && !!ZIP)('go mod download: a young module version fails with pkg-gate in stderr; an old one succeeds', async () => {
  const env = {
    GOPROXY: `${gateBase}/go`,
    GOSUMDB: 'off',
    GOFLAGS: '-modcacherw',
    GOMODCACHE: join(scratch, 'gomodcache'),
    GOCACHE: join(scratch, 'gocache'),
    HOME: join(scratch, 'gohome'),
  }
  const young = await run([GO!, 'mod', 'download', `${GO_MODULE}@v1.0.1`], env)
  expect(young.code).not.toBe(0)
  expect(young.err).toContain('pkg-gate')

  const old = await run([GO!, 'mod', 'download', `${GO_MODULE}@v1.0.0`], env)
  expect(old.code).toBe(0)
})

test.if(!!NPM)('npm pack: a young package version fails; an old one succeeds', async () => {
  const outDir = join(scratch, 'npmout')
  mkdirSync(outDir, { recursive: true })
  const env = {
    NPM_CONFIG_REGISTRY: `${gateBase}/npm/`,
    HOME: join(scratch, 'npmhome'),
    npm_config_cache: join(scratch, 'npmcache'),
    // the host's own release cooldown (npm `before`) would hide the 6-day-old fixture before the gate sees it
    npm_config_before: new Date().toISOString(),
  }
  const young = await run([NPM!, 'pack', `${NPM_PKG}@1.0.1`, '--pack-destination', outDir], env)
  expect(young.code).not.toBe(0)

  const old = await run([NPM!, 'pack', `${NPM_PKG}@1.0.0`, '--pack-destination', outDir], env)
  expect(old.code).toBe(0)
})

test.if(!!PIP)('pip download --no-deps: a young file fails; an old one succeeds', async () => {
  const outDir = join(scratch, 'pipout')
  mkdirSync(outDir, { recursive: true })
  const env = { PIP_INDEX_URL: `${gateBase}/pypi/simple`, PIP_TRUSTED_HOST: new URL(gateBase).hostname }
  const young = await run([PIP!, 'download', '--no-deps', '-d', outDir, `${PY_PROJECT}==1.0.1`], env)
  expect(young.code).not.toBe(0)

  const old = await run([PIP!, 'download', '--no-deps', '-d', outDir, `${PY_PROJECT}==1.0.0`], env)
  expect(old.code).toBe(0)
})

test.if(!!UV && !!PYTHON3)('uv pip install --dry-run: a young version fails; an old one succeeds', async () => {
  const venv = join(scratch, 'uvvenv')
  const made = await run([UV!, 'venv', venv, '--python', PYTHON3!], {})
  expect(made.code).toBe(0)
  const env = {
    UV_DEFAULT_INDEX: `${gateBase}/pypi/simple`,
    UV_INSECURE_HOST: new URL(gateBase).hostname,
    UV_EXCLUDE_NEWER: new Date().toISOString(), // the host's own cooldown, as npm's `before` above
  }

  const young = await run([UV!, 'pip', 'install', '--dry-run', '--python', venv, `${PY_PROJECT}==1.0.1`], env)
  expect(young.code).not.toBe(0)

  const old = await run([UV!, 'pip', 'install', '--dry-run', '--python', venv, `${PY_PROJECT}==1.0.0`], env)
  expect(old.code).toBe(0)
})
