// claude-factory-3c4w: bun test preload.
// A factory worker runs the tests with worker markers in its env. Then bin/factory refuses manager-only verbs.
// This file clears the markers one time. A test that needs a marker sets it in the env of its own spawn.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// ponytail: this clears process.env only. A test that builds its env from another source must strip the markers.
for (const k of [
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'BEADS_ACTOR',
  'FACTORY_OUTBOX',
  'FACTORY_PATROL',
  'FACTORY_OTLP_ENDPOINT',
  'FACTORY_AX_OTLP_ENDPOINT',
])
  delete process.env[k]
// claude-factory-8v8z: no test reaches the host's real herdr. A path with no binary acts as CI does (herdr not installed).
// A test that needs a fake herdr sets FACTORY_HERDR in the env of its own spawn.
for (const k of Object.keys(process.env)) if (k.startsWith('HERDR_')) delete process.env[k]
process.env['FACTORY_HERDR'] = join(tmpdir(), 'factory-test-no-herdr')
