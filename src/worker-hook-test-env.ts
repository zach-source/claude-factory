// claude-factory-twu4: a hook child that inherits these vars appends fake deny rows to the live
// run denials.jsonl and outbox. A hook test file calls this once: it strips the vars and restores them after the file.
import { afterAll } from 'bun:test'

const LIVE_RUN_VARS = ['FACTORY_HOME', 'FACTORY_RUN', 'FACTORY_OUTBOX', 'FACTORY_DENY_LOG']

export function stripLiveRunVars(): void {
  const saved = LIVE_RUN_VARS.map(k => [k, process.env[k]] as const)
  for (const k of LIVE_RUN_VARS) delete process.env[k]
  afterAll(() => {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v
  })
}
