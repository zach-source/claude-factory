import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmQuiet } from '../home-guard'
import { SERVER_VERBS, serverBashReason } from './guards'

test('the server accepts each listed factory verb', () => {
  const verbs = [
    'status',
    'mail',
    'poke',
    'retry',
    'goto',
    'abort',
    'fork',
    'rm',
    'start',
    'queue',
    'backlog',
    'waiting',
    'home',
    'memory',
    'rig',
    'file-elsewhere',
  ]
  expect([...SERVER_VERBS].sort()).toEqual(verbs.sort())
  const cwd = mkdtempSync(join(tmpdir(), 'server-verbs-'))
  try {
    for (const verb of verbs) {
      const args =
        verb === 'memory'
          ? "search 'x y'"
          : verb === 'rig'
            ? 'list'
            : verb === 'start'
              ? "lifecycle@plan widget 'goal'"
              : verb === 'queue'
                ? 'widget'
                : 'r1'
      const command = `factory ${verb} ${args}`
      expect(
        serverBashReason(command, cwd, '/cli', () => ({ decision: 'allow' })),
        command,
      ).toBeUndefined()
    }
  } finally {
    rmQuiet(cwd, { recursive: true, force: true })
  }
})
