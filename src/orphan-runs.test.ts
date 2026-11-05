// orphanRuns: the run view orphanPass builds OrphanCtx from (runs, live runs, decided flag).
import { expect, test } from 'bun:test'
import { orphanRuns } from './cli'

const fake = (state: Record<string, { node: string; outcome?: string; bead?: string }>) =>
  ((id: string) => {
    const s = state[id]
    if (!s) throw new Error('no such run')
    return {
      run: { id, bead: s.bead, repo: '/r' },
      value: s.node,
      c: { log: s.outcome ? [{ outcome: 'x' }, { outcome: s.outcome }] : [] },
    }
  }) as never

test('decided is set only for a run whose last outcome is decision', () => {
  const { runs, live, decided } = orphanRuns(
    ['a', 'b', 'c', 'd', 'e', 'gone'],
    fake({
      a: { node: 'implement', outcome: 'decision', bead: 'b-1' },
      b: { node: 'implement', outcome: 'ready', bead: 'b-2' },
      c: { node: 'done', outcome: 'decision' },
      d: { node: 'implement', outcome: 'approve' },
      e: { node: 'implement' },
    }),
  )
  expect([...runs.keys()]).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect([...decided]).toEqual(['a', 'c'])
  expect(live.map(r => r.id)).toEqual(['a', 'b', 'd', 'e'])
})
