import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 8b0ebf2: src/sidebar.ts imported ../mod, the worker stage did not copy mod, and every AX worker failed to start
const ROOT = join(import.meta.dir, '..')

test('the worker image copies every top-level directory that src imports', () => {
  const docker = readFileSync(join(ROOT, 'Dockerfile.worker'), 'utf8')
  const worker = docker.slice(docker.indexOf(' AS worker'), docker.indexOf(' AS manager'))
  const copied = new Set([...worker.matchAll(/^COPY (?!--)(\S+) /gm)].map(m => m[1]))
  const imported = new Set<string>()
  for (const f of readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue
    const text = readFileSync(join(ROOT, 'src', f), 'utf8')
    // Bun drops a type-only import at runtime, so it needs no file in the image
    for (const m of text.matchAll(/^import (?!type )[^'"]*from '\.\.\/([\w-]+)\//gm)) imported.add(m[1]!)
  }
  expect([...imported].filter(d => !copied.has(d))).toEqual([])
  expect(imported.has('mod')).toBe(true)
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

test('the worker NIX_PATH resolves nixpkgs to the pin, never a channel (claude-factory-823x)', () => {
  const worker = workerStage()
  expect(worker).toMatch(/^ENV NIX_PATH=nixpkgs=flake:nixpkgs$/m)
  expect(worker).not.toMatch(/channel|nixos-\d|nixpkgs-unstable/)
})

test('the worker image installs gitleaks and jq and smokes them (claude-factory-823x)', () => {
  const worker = workerStage()
  expect(worker).toContain('nixpkgs#gitleaks nixpkgs#jq')
  expect(worker).toContain('gitleaks version && jq --version')
  expect(worker).not.toMatch(/nixpkgs#go\b/)
})
