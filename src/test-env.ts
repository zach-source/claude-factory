// claude-factory-3c4w: bun test preload.
// A factory worker runs the tests with worker markers in its env. Then bin/factory refuses manager-only verbs.
// This file clears the markers one time. A test that needs a marker sets it in the env of its own spawn.
// ponytail: this clears process.env only. A test that builds its env from another source must strip the markers.
for (const k of [
  'FACTORY_FROM',
  'FACTORY_RUN',
  'FACTORY_DEF_NAME',
  'BEADS_ACTOR',
  'FACTORY_OUTBOX',
  'FACTORY_PATROL',
])
  delete process.env[k]
