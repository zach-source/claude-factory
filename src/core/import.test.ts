// AC5: importing src/core starts no tick and no CLI. The static rule fails closed. The runtime rule imports each file alone.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..')
const files = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []
  })
const core = files(import.meta.dir)

const resolveImport = (from: string, spec: string): string => {
  const base = resolve(dirname(from), spec)
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')])
    if (existsSync(c) && statSync(c).isFile()) return c
  throw new Error(`${from}: import ${spec} does not resolve to a file`)
}

/** every file that `start` reaches through its value imports */
const reach = (start: string[]): Set<string> => {
  const seen = new Set<string>()
  const t = new Bun.Transpiler({ loader: 'ts' })
  const walk = (f: string) => {
    if (seen.has(f)) return
    seen.add(f)
    for (const i of t.scanImports(readFileSync(f, 'utf8')))
      if (i.path.startsWith('.')) walk(resolveImport(f, i.path))
  }
  start.forEach(walk)
  return seen
}

test('src/core reaches no cli.ts, server.ts or server-api.ts by a value import', () => {
  expect(core.length).toBeGreaterThan(8)
  const seen = reach(core)
  for (const bad of ['cli.ts', 'server.ts', 'server-api.ts']) expect(seen.has(join(SRC, bad))).toBe(false)
})

test('each src/core file imports alone with no output and no file written', async () => {
  const fh = mkdtempSync(join(tmpdir(), 'imp-fh-'))
  const hh = mkdtempSync(join(tmpdir(), 'imp-hh-'))
  for (const f of core) {
    const p = Bun.spawn([process.execPath, '-e', `await import(${JSON.stringify(f)})`], {
      // bun keeps its own transpiler cache under HOME; switch it off so a file in HOME is ours
      env: {
        PATH: process.env.PATH ?? '',
        FACTORY_HOME: fh,
        HOME: hh,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    })
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    expect({ f, code, out, err }).toEqual({ f, code: 0, out: '', err: '' })
  }
  expect(readdirSync(fh)).toEqual([])
  expect(readdirSync(hh)).toEqual([])
})
