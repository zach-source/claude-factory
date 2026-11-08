import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildImage, parseDigest } from './image'

const HEX = 'a'.repeat(64)
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('parseDigest', () => {
  test('accepts the one form', () => {
    expect(parseDigest(JSON.stringify({ 'containerimage.digest': `sha256:${HEX}`, 'image.name': 'x' }))).toBe(
      `sha256:${HEX}`,
    )
  })
  const d = (v: unknown) => JSON.stringify({ 'containerimage.digest': v })
  const bad = [
    '',
    'not json',
    '[]',
    'null',
    '{}',
    d(null),
    d(5),
    d(`sha256:${'a'.repeat(63)}`),
    d(`sha256:${'a'.repeat(65)}`),
    d(`sha256:${'A'.repeat(64)}`),
    d(`sha512:${HEX}`),
    d(`sha256:${HEX}\n`),
    d(` sha256:${HEX}`),
  ]
  test.each(bad)('throws on %p', text => {
    expect(() => parseDigest(text)).toThrow('the build metadata has no sha256 digest')
  })
})

const setup = (
  stored: Record<string, string> = { 'image.registry': 'reg.example/acme', 'image.builder': 'amd64' },
) => {
  const home = mkdtempSync(join(tmpdir(), 'image-test-'))
  dirs.push(home)
  const file = join(home, 'settings.json')
  writeFileSync(file, JSON.stringify(stored))
  return file
}
const metaOf = (argv: string[]) => argv[argv.indexOf('--metadata-file') + 1]!

const base = (file: string, run: (a: string[]) => Promise<number>, over = {}) => ({
  target: 'worker' as const,
  settingsFile: file,
  root: '/r',
  sha: 'abc1234',
  env: {},
  run,
  ...over,
})
const good = async (a: string[]) => {
  writeFileSync(metaOf(a), JSON.stringify({ 'containerimage.digest': `sha256:${HEX}` }))
  return 0
}

describe('buildImage', () => {
  test('argv: worker without build args', async () => {
    const calls: string[][] = []
    await buildImage(base(setup(), async a => (calls.push(a), good(a))))
    expect(calls).toHaveLength(1)
    const meta = metaOf(calls[0]!)
    expect(calls[0]).toEqual([
      'buildx',
      'build',
      '--builder',
      'amd64',
      '--platform',
      'linux/amd64',
      '--target',
      'worker',
      '--push',
      '--metadata-file',
      meta,
      '-t',
      'reg.example/acme/factory-worker:abc1234',
      '-f',
      '/r/Dockerfile.worker',
      '/r',
    ])
  })
  test('argv: manager with both build args; an empty value adds none', async () => {
    const calls: string[][] = []
    const run = async (a: string[]) => (calls.push(a), good(a))
    await buildImage(
      base(setup(), run, { target: 'manager', env: { AX_CLI_REPO: 'https://x/y', AX_CLI_COMMIT: 'c0ffee' } }),
    )
    const a = calls[0]!
    const i = a.indexOf('--push') + 3
    expect(a.slice(i, i + 4)).toEqual([
      '--build-arg',
      'AX_CLI_REPO=https://x/y',
      '--build-arg',
      'AX_CLI_COMMIT=c0ffee',
    ])
    expect(a).toContain('reg.example/acme/factory-manager:abc1234')
    calls.length = 0
    await buildImage(base(setup(), run, { env: { AX_CLI_REPO: '', AX_CLI_COMMIT: 'c0ffee' } }))
    expect(calls[0]!.filter(x => x === '--build-arg')).toHaveLength(1)
    expect(calls[0]!.join(' ')).not.toContain('AX_CLI_REPO')
  })
  test('success stores the ref under the right key and keeps the other', async () => {
    const file = setup({
      'image.registry': 'r/a',
      'image.builder': 'b',
      'ax.image': 'old',
      'ax.manager-image': 'oldm',
    })
    const ref = await buildImage(base(file, good, { target: 'manager' }))
    expect(ref).toBe(`r/a/factory-manager:abc1234@sha256:${HEX}`)
    const s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s['ax.manager-image']).toBe(ref)
    expect(s['ax.image']).toBe('old')
    const w = await buildImage(base(file, good))
    expect(JSON.parse(readFileSync(file, 'utf8'))['ax.image']).toBe(w)
  })
  describe('failure stores nothing', () => {
    const rows: [string, (a: string[]) => Promise<number>, string][] = [
      ['exit 1', async () => 1, 'docker buildx build failed (exit 1)'],
      [
        'run throws',
        async () => {
          throw new Error('no docker')
        },
        'no docker',
      ],
      ['no meta', async () => 0, 'the build metadata has no sha256 digest'],
      [
        'bad meta',
        async a => (writeFileSync(metaOf(a), '{"containerimage.digest":"x"}'), 0),
        'the build metadata has no sha256 digest',
      ],
    ]
    test.each(rows)('%s', async (_n, run, msg) => {
      const file = setup({ 'image.registry': 'r/a', 'image.builder': 'b', 'ax.image': 'old' })
      const before = readFileSync(file)
      await expect(buildImage(base(file, run))).rejects.toThrow(msg)
      expect(readFileSync(file).equals(before)).toBe(true)
    })
  })
  describe('bad registry or builder makes no run call', () => {
    const rows: [string, Record<string, string>, string][] = []
    for (const key of ['image.registry', 'image.builder']) {
      const ok = { 'image.registry': 'r', 'image.builder': 'b' }
      const { [key]: _drop, ...missing } = ok
      rows.push(
        [`${key} missing`, missing, key],
        [`${key} empty`, { ...ok, [key]: '' }, key],
        [`${key} space`, { ...ok, [key]: 'a b' }, key],
      )
    }
    test.each(rows)('%s', async (_n, stored, key) => {
      let n = 0
      const run = async () => (n++, 0)
      await expect(buildImage(base(setup(stored), run))).rejects.toThrow(
        `${key} is not set: run factory settings set ${key} <value>`,
      )
      expect(n).toBe(0)
    })
  })
  test('the temp dir is gone after success, exit 1 and a throw', async () => {
    const seen: string[] = []
    const mk = (f: (a: string[]) => Promise<number>) => async (a: string[]) => (
      seen.push(dirname(metaOf(a))),
      f(a)
    )
    await buildImage(base(setup(), mk(good)))
    await buildImage(
      base(
        setup(),
        mk(async () => 1),
      ),
    ).catch(() => {})
    await buildImage(
      base(
        setup(),
        mk(async () => {
          throw new Error('x')
        }),
      ),
    ).catch(() => {})
    expect(seen).toHaveLength(3)
    for (const d of seen) expect(existsSync(d)).toBe(false)
  })
  test('push done but store failed names the ref and the key', async () => {
    const file = setup()
    const run = async (a: string[]) => {
      await good(a)
      rmSync(file)
      mkdirSync(file)
      return 0
    }
    await expect(buildImage(base(file, run))).rejects.toThrow(
      /^pushed .*@sha256:[0-9a-f]{64} but could not store ax.image: /,
    )
  })
})
