// AX caps a Task's env list. ax.ts manifest() packs the extra vars into one JSON object in FACTORY_VM_ENV.
// This must be the first import of cli.ts. It runs the process again with the vars in its real env,
// because Bun.spawnSync without an env option uses the START env of the process.
const raw = process.env.FACTORY_VM_ENV
if (raw !== undefined) {
  let packed: Record<string, string> | undefined
  try {
    const v: unknown = JSON.parse(raw)
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.entries(v).every(([k, x]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof x === 'string')
    )
      packed = v as Record<string, string>
  } catch {}
  if (!packed) {
    console.error('FACTORY_VM_ENV is not a JSON object of NAME: "string" pairs')
    process.exit(1)
  }
  const { FACTORY_VM_ENV: _, ...rest } = process.env
  const r = Bun.spawnSync(process.argv, {
    env: { ...rest, ...packed },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(r.exitCode ?? 1)
}
