// `factory image build` end to end with a fake docker: a fresh FACTORY_HOME for each test.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, '..', 'bin', 'factory')
const HEX = 'b'.repeat(64)
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = (seed = true) => {
  const home = mkdtempSync(join(tmpdir(), 'image-cli-'))
  dirs.push(home)
  const bin = mkdtempSync(join(tmpdir(), 'image-bin-'))
  dirs.push(bin)
  const marker = join(home, 'docker-argv')
  const fake = join(bin, 'docker')
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$@" > "$FAKE_DOCKER_MARKER"
echo noise
prev=
for a in "$@"; do
  if [ "$prev" = --metadata-file ] && [ "\${FAKE_DOCKER_EXIT:-0}" = 0 ]; then
    echo '{"containerimage.digest":"sha256:${HEX}"}' > "$a"
  fi
  prev=$a
done
exit "\${FAKE_DOCKER_EXIT:-0}"
`,
  )
  chmodSync(fake, 0o755)
  const file = join(home, 'settings.json')
  const run = (args: string[], env: Record<string, string> = {}) => {
    const clean = { ...process.env } as Record<string, string | undefined>
    for (const k of Object.keys(clean))
      if (/^(FACTORY_(OUTBOX|FROM|RUN|DEF_NAME|PATROL|AX_.*|KUBECTL|MAX_RUNS)|BEADS_ACTOR)$/.test(k))
        delete clean[k]
    const p = Bun.spawnSync([CLI, ...args], {
      env: {
        ...clean,
        PATH: `${bin}:${process.env.PATH}`,
        FACTORY_HOME: home,
        FACTORY_SELF_UPDATE: '0',
        FACTORY_GC: '0',
        FACTORY_NO_KICK: '1',
        FAKE_DOCKER_MARKER: marker,
        ...env,
      } as Record<string, string>,
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  if (seed) {
    run(['settings', 'set', 'image.registry', 'reg.example/acme'])
    run(['settings', 'set', 'image.builder', 'amd64'])
  }
  return { file, marker, run }
}

describe('factory image build', () => {
  test('success prints only the ref and stores it', () => {
    const { run, file, marker } = setup()
    const r = run(['image', 'build'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(new RegExp(`^reg\\.example/acme/factory-worker:[0-9a-f]+@sha256:${HEX}\\n$`))
    expect(r.out).not.toContain('noise')
    expect(r.err).toContain('noise')
    expect(JSON.parse(readFileSync(file, 'utf8'))['ax.image']).toBe(r.out.trim())
    expect(readFileSync(marker, 'utf8')).toContain('--target worker')
  })
  test('manager stores ax.manager-image', () => {
    const { run, file } = setup()
    const r = run(['image', 'build', '--target', 'manager'])
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))['ax.manager-image']).toBe(r.out.trim())
  })
  test('a failed build keeps settings.json', () => {
    const { run, file } = setup()
    const before = readFileSync(file)
    const r = run(['image', 'build'], { FAKE_DOCKER_EXIT: '1' })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('docker buildx build failed (exit 1)')
    expect(readFileSync(file).equals(before)).toBe(true)
  })
  test('no registry set: no docker call', () => {
    const { run, marker } = setup(false)
    const r = run(['image', 'build'])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('image.registry is not set')
    expect(existsSync(marker)).toBe(false)
  })
  const bad = [
    ['image'],
    ['image', 'push'],
    ['image', 'build', '--target'],
    ['image', 'build', '--target', 'x'],
    ['image', 'build', '--target', 'worker', 'extra'],
    ['image', 'build', '--other'],
  ]
  test.each(bad)('refuses %p with usage', (...args) => {
    const { run, marker } = setup()
    const r = run(args)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('usage: factory image build [--target worker|manager]')
    expect(existsSync(marker)).toBe(false)
  })
  test('a patrol cannot run it', () => {
    const { run, marker } = setup()
    const r = run(['image', 'build'], { FACTORY_PATROL: '1' })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('a patrol cannot run factory image build')
    expect(existsSync(marker)).toBe(false)
  })
  test.each<Record<string, string>>([{ FACTORY_FROM: 'implement' }, { BEADS_ACTOR: 'factory/r1/plan' }])(
    'a worker cannot run it: %p',
    env => {
      const { run, marker } = setup()
      const r = run(['image', 'build'], env)
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('a worker cannot run factory image')
      expect(existsSync(marker)).toBe(false)
    },
  )
  test('help names the command', () => {
    const r = setup().run(['help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('image build [--target worker|manager]')
  })
  test('an env var that hides the stored image gets a warning', () => {
    const { run, file } = setup()
    const r = run(['image', 'build'], { FACTORY_AX_IMAGE: 'old' })
    expect(r.err).toContain(
      'factory: FACTORY_AX_IMAGE is set in the environment and overrides the stored ax.image; unset it to use the new image',
    )
    expect(JSON.parse(readFileSync(file, 'utf8'))['ax.image']).toBe(r.out.trim())
    expect(setup().run(['image', 'build']).err).not.toContain('overrides the stored')
  })
})
