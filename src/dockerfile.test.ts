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
