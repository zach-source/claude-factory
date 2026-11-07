import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VM_PLUGINS } from './harness'

// 8b0ebf2: src/sidebar.ts imported ../mod, the worker stage did not copy mod, and every AX worker failed to start
const ROOT = join(import.meta.dir, '..')

// Bun drops a type-only import at runtime, so it needs no file in the image
const srcImports = () => {
  const imported = new Set<string>()
  for (const f of readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue
    const text = readFileSync(join(ROOT, 'src', f), 'utf8')
    for (const m of text.matchAll(/^import (?!type )[^'"]*from '\.\.\/([\w-]+)\//gm)) imported.add(m[1]!)
  }
  return imported
}

test('the worker image copies every top-level directory that src imports', () => {
  const docker = readFileSync(join(ROOT, 'Dockerfile.worker'), 'utf8')
  const worker = docker.slice(docker.indexOf(' AS worker'), docker.indexOf(' AS manager'))
  const copied = new Set([...worker.matchAll(/^COPY (?!--)(\S+) /gm)].map(m => m[1]))
  const imported = srcImports()
  expect([...imported].filter(d => !copied.has(d))).toEqual([])
  expect(imported.has('mod')).toBe(true)
})

test('each plugin dir of VM_PLUGINS has a COPY line in the worker stage, and EGM is pinned to a commit', () => {
  const docker = readFileSync(join(ROOT, 'Dockerfile.worker'), 'utf8')
  const worker = docker.slice(docker.indexOf(' AS worker'), docker.indexOf(' AS manager'))
  for (const dir of Object.values(VM_PLUGINS))
    expect(worker).toMatch(new RegExp(`^COPY --from=\\w+ \\S+ ${dir}$`, 'm'))
  expect(docker).toMatch(/^ARG EGM_COMMIT=[0-9a-f]{40}$/m)
})

const serverFile = () => readFileSync(join(ROOT, 'Dockerfile.server'), 'utf8')
const serverStage = () => serverFile().slice(serverFile().lastIndexOf('\nFROM oven/bun:'))

test('the server image uses the Bun version that CI pins', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const pins = [...new Set([...ci.matchAll(/bun-version:\s*['"]?([\d.]+)['"]?/g)].map(m => m[1]))]
  expect(pins).toEqual(['1.3.13'])
  expect(serverFile()).toMatch(new RegExp(`^FROM oven/bun:${pins[0]}-debian$`, 'm'))
})

test('the server image installs and smokes each tool', () => {
  const stage = serverStage()
  const smoke = [
    'bun --version',
    'claude --version',
    'git --version',
    'gh --version',
    'bd version',
    'dolt version',
    'ax version',
    'kubectl version --client',
  ]
  const line = stage.replace(/\\\n/g, ' ').match(/^RUN (bun --version .*)$/m)?.[1] ?? ''
  expect(line.split('&&').map(c => c.trim().replace(/\s+/g, ' '))).toEqual(smoke)
  for (const a of ['CLAUDE_CODE_VERSION', 'GH_VERSION', 'BD_VERSION', 'DOLT_VERSION', 'KUBECTL_VERSION'])
    expect(stage).toMatch(new RegExp(`^ARG ${a}=\\S+$`, 'm'))
  expect(serverFile()).toMatch(/^ARG AX_CLI_COMMIT=\S+$/m)
  expect(serverFile()).not.toMatch(/:latest|releases\/latest/)
})

test('the server image copies every top-level directory that src imports', () => {
  const copied = new Set([...serverStage().matchAll(/^COPY (?!--)(\S+) /gm)].map(m => m[1]))
  const imported = srcImports()
  expect([...imported].filter(d => !copied.has(d))).toEqual([])
  expect(imported.has('mod')).toBe(true)
})

test('the server image fetches the embedding model as root, before USER bun', () => {
  const stage = serverStage()
  const fetch = stage.indexOf('RUN bun -e "await (await import(\'./src/memory.ts\')).fetchModel()"')
  expect(fetch).toBeGreaterThan(stage.indexOf('COPY src src'))
  expect(fetch).toBeLessThan(stage.indexOf('\nUSER bun'))
})

test('the worker image pins codex unified_exec off, since write_stdin skips the deny hook (claude-factory-fzm3)', () => {
  const docker = readFileSync(join(ROOT, 'Dockerfile.worker'), 'utf8')
  const worker = docker.slice(docker.indexOf(' AS worker'), docker.indexOf(' AS manager'))
  expect(worker).toContain("printf '[features]\\nunified_exec = false\\n' > /etc/codex/requirements.toml")
  expect(worker).toContain('chmod 0644 /etc/codex/requirements.toml')
  expect(worker.indexOf('/etc/codex/requirements.toml')).toBeGreaterThan(worker.indexOf('@openai/codex@'))
})

// 823x: nix-shell -p read the base image's channel (go1.23) while the pin held go 1.26
const workerStage = () => {
  const docker = readFileSync(join(ROOT, 'Dockerfile.worker'), 'utf8')
  return docker.slice(docker.indexOf(' AS worker'), docker.indexOf(' AS manager'))
}

test('the worker image pins nixpkgs at the rev with a current Go (claude-factory-823x)', () => {
  const docker = readFileSync(join(ROOT, 'Dockerfile.worker'), 'utf8')
  expect(docker).toContain('ARG NIXPKGS_REV=1c89083e451e891152365b799595cf7790a43325')
  expect(docker).not.toContain('6510408d')
})

test('the nixpkgs prefetch pins the content by narHash, not only the rev (claude-factory-zgaa)', () => {
  const worker = workerStage()
  expect(worker).toMatch(/^ARG NIXPKGS_NARHASH=sha256-[A-Za-z0-9%]+$/m)
  expect(worker).toContain('nixpkgs/${NIXPKGS_REV}?narHash=${NIXPKGS_NARHASH} --out-link')
})

test('the worker NIX_PATH resolves nixpkgs to the pin, never a channel (claude-factory-823x)', () => {
  const worker = workerStage()
  expect(worker).toMatch(/^ENV NIX_PATH=nixpkgs=\/nix\/var\/nix\/gcroots\/nixpkgs-pin$/m)
  expect(worker).toContain('--out-link /nix/var/nix/gcroots/nixpkgs-pin')
  expect(worker).toContain('nixpkgs "path:$p"')
  expect(worker).not.toMatch(/channel|nixos-\d|nixpkgs-unstable/)
})

test('the worker image installs gitleaks and jq and smokes them (claude-factory-823x)', () => {
  const worker = workerStage()
  expect(worker).toContain('nixpkgs#gitleaks nixpkgs#jq')
  expect(worker).toContain('gitleaks version && jq --version')
  expect(worker).not.toMatch(/nixpkgs#go\b/)
})
