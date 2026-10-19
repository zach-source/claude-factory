import { expect, test } from 'bun:test'
import {
  ghNotes,
  isChangeRequest,
  isPerson,
  watchDecide,
  type DecideInput,
  type Note,
  type WatchedPr,
} from './watch'

const URL = 'https://github.com/acme/widget/pull/1'
const PARKED = Date.parse('2026-10-11T10:00:00Z')
const min = (m: number) => PARKED + m * 60_000
const iso = (m: number) => new Date(min(m)).toISOString()
const pr = (over: Partial<WatchedPr> = {}): WatchedPr => ({
  url: URL,
  state: 'OPEN',
  updatedAt: iso(-60),
  headRefOid: 'aaaaaaa1',
  notes: [],
  ...over,
})
const note = (over: Partial<Note> = {}): Note => ({
  at: min(5),
  person: true,
  changesRequested: false,
  body: 'looks odd',
  ...over,
})
const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  prs: [pr()],
  failed: false,
  parkedAt: PARKED,
  now: min(30),
  wakeAt: min(480),
  plainMin: 60,
  isPreLaunch: false,
  seen: { heads: { [URL]: 'aaaaaaa1' } },
  canHold: true,
  canChange: true,
  ...over,
})
const kind = (i: Partial<DecideInput>) => watchDecide(input(i))?.kind

test('isPerson: only a repository member who is not a bot', () => {
  expect(isPerson('zach', 'OWNER')).toBe(true)
  expect(isPerson('dev', 'COLLABORATOR')).toBe(true)
  expect(isPerson('github-actions', 'NONE')).toBe(false)
  expect(isPerson('github-actions', 'MEMBER')).toBe(false)
  expect(isPerson('dependabot[bot]', 'MEMBER')).toBe(false)
  expect(isPerson('zach', 'OWNER', true)).toBe(false)
  expect(isPerson('stranger', 'NONE')).toBe(false)
  expect(isPerson('stranger', 'CONTRIBUTOR')).toBe(false)
  expect(isPerson('project_9_bot_x', 'MEMBER')).toBe(false)
  expect(isPerson(undefined, 'OWNER')).toBe(false)
})

test('ghNotes maps reviews and comments and skips malformed entries', () => {
  const owner = { login: 'zach' }
  const notes = ghNotes({
    reviews: [
      {
        author: owner,
        authorAssociation: 'OWNER',
        state: 'CHANGES_REQUESTED',
        body: 'no',
        submittedAt: iso(5),
      },
      null,
      { author: owner, authorAssociation: 'OWNER', state: 'APPROVED', body: '' },
    ],
    comments: [
      { author: { login: 'github-actions' }, authorAssociation: 'NONE', body: 'CI', createdAt: iso(6) },
    ],
  })
  expect(notes).toHaveLength(2)
  expect(notes[0]).toMatchObject({ person: true, changesRequested: true, body: 'no' })
  expect(notes[1]).toMatchObject({ person: false, changesRequested: false })
  expect(ghNotes({ reviews: 'x' })).toEqual([])
})

test('isChangeRequest: a person review CHANGES_REQUESTED or a /changes first line; never a bot', () => {
  expect(isChangeRequest(note({ changesRequested: true }))).toBe(true)
  expect(isChangeRequest(note({ body: '/Changes fix the name' }))).toBe(true)
  expect(isChangeRequest(note({ body: 'ok\n/changes later' }))).toBe(false)
  expect(isChangeRequest(note({ body: '/changes', person: false }))).toBe(false)
  expect(isChangeRequest(note({ body: '/changesx' }))).toBe(false)
  expect(isChangeRequest(note({ changesRequested: true, person: false }))).toBe(false)
})

test('AC1: noise does not wake, route or re-park an open pull request', () => {
  // an updatedAt bump alone (CI status, label)
  expect(watchDecide(input({ prs: [pr({ updatedAt: iso(10) })] }))).toBeNull()
  // bot comment, bot review, bot /changes
  for (const n of [
    note({ person: false }),
    note({ person: false, changesRequested: true }),
    note({ person: false, body: '/changes x' }),
  ])
    expect(watchDecide(input({ prs: [pr({ notes: [n] })] }))).toBeNull()
  // a person note from before the park
  expect(watchDecide(input({ prs: [pr({ notes: [note({ at: min(-5) })] })] }))).toBeNull()
})

test('AC2: a head change, a merge, a close with no hold, or a person note wakes', () => {
  expect(watchDecide(input({ prs: [pr({ headRefOid: 'bbbbbbb2' })] }))).toMatchObject({
    kind: 'wake',
    text: expect.stringContaining('new head commit bbbbbbb'),
  })
  const merged = pr({ state: 'MERGED', mergedAt: iso(5), updatedAt: iso(5) })
  expect(watchDecide(input({ prs: [merged] }))).toMatchObject({
    kind: 'wake',
    text: expect.stringContaining('it is merged'),
  })
  const closed = pr({ state: 'CLOSED', closedAt: iso(5) })
  expect(watchDecide(input({ canHold: false, prs: [closed] }))).toMatchObject({
    kind: 'wake',
    text: expect.stringContaining('it is closed'),
  })
  expect(watchDecide(input({ prs: [pr({ notes: [note()] })] }))).toMatchObject({
    kind: 'wake',
    text: expect.stringContaining('a person reviewed or commented'),
  })
  // no baseline yet: the first view only records it
  expect(watchDecide(input({ seen: undefined, prs: [pr({ headRefOid: 'bbbbbbb2' })] }))).toBeNull()
})

test('AC2: a pre-launch park on an already merged pull request wakes at once', () => {
  const merged = pr({ state: 'MERGED', mergedAt: iso(-30), updatedAt: iso(-30) })
  expect(watchDecide(input({ isPreLaunch: true, now: min(1), prs: [merged] }))).toMatchObject({
    kind: 'wake',
    text: expect.stringContaining('None of'),
  })
})

test('AC3: closed unmerged after the park routes hold with the latest person comment as the reason', () => {
  const closed = pr({
    state: 'CLOSED',
    closedAt: iso(5),
    notes: [
      note({ at: min(3), body: 'old reason' }),
      note({ at: min(4), body: 'superseded by #9' }),
      note({ at: min(4.5), body: 'bot says', person: false }),
    ],
  })
  const d = watchDecide(input({ prs: [closed] }))
  expect(d).toMatchObject({ kind: 'hold', url: URL })
  expect((d as { text: string }).text).toContain('superseded by #9')
  expect((d as { text: string }).text).toContain(iso(5))
  const before = pr({ state: 'CLOSED', closedAt: iso(-5), updatedAt: iso(-5) })
  // closed before a worker park: no route
  expect(kind({ prs: [before] })).toBeUndefined()
  // pre-launch: closed before the park still holds
  expect(kind({ isPreLaunch: true, prs: [before] })).toBe('hold')
  // already routed this park: no second route
  expect(kind({ seen: { heads: {}, routed: true }, prs: [closed] })).not.toBe('hold')
  // a view failed: no route
  expect(kind({ failed: true, prs: [closed] })).not.toBe('hold')
  // one of two is merged: not all closed
  const merged = pr({ url: URL + '2', state: 'MERGED', mergedAt: iso(-9) })
  expect(kind({ prs: [closed, merged] })).not.toBe('hold')
})

test('AC4: a person change request on an open pull request routes changes; a bot one does nothing', () => {
  const d = watchDecide(
    input({
      prs: [
        pr({
          notes: [
            note({ changesRequested: true, body: 'rename it' }),
            note({ body: '/changes ' + 'x'.repeat(3000) }),
            note({ body: 'free text, not a request' }),
          ],
        }),
      ],
    }),
  )
  expect(d).toMatchObject({ kind: 'changes', url: URL })
  const bodies = (d as { bodies: string[] }).bodies
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toBe('rename it')
  expect(bodies[1]!.length).toBe(2000)
  const asked = pr({ notes: [note({ changesRequested: true })] })
  // no changes outcome: a person note wakes a worker
  expect(kind({ canChange: false, prs: [asked] })).toBe('wake')
  // a view failed: no route, the worker reads it
  expect(kind({ failed: true, prs: [asked] })).toBe('wake')
  // a free-text person comment wakes a worker; it is not routed
  expect(kind({ prs: [pr({ notes: [note()] })] })).toBe('wake')
  // changes before the park do not route
  expect(kind({ prs: [pr({ notes: [note({ at: min(-1), changesRequested: true })] })] })).toBeUndefined()
})

test('AC5: unchanged open pull requests re-park near the timer and wait far from it', () => {
  expect(watchDecide(input({ now: min(480) }))).toEqual({ kind: 'repark', wakeAt: min(480) + 480 * 60_000 })
  expect(kind({ now: min(471) })).toBe('repark')
  expect(kind({ now: min(469) })).toBeUndefined()
  // re-park posted but the tick did not apply it yet
  expect(kind({ now: min(481), seen: { heads: {}, reparkedUntil: min(960) } })).toBeUndefined()
  // a failed view: the old timer starts the worker
  expect(kind({ now: min(480), failed: true })).toBeUndefined()
})

test('AC7: a pull request merged before a worker park never re-parks; the plain timer wakes it', () => {
  const merged = pr({ state: 'MERGED', mergedAt: iso(-60), updatedAt: iso(-60) })
  expect(kind({ now: min(30), prs: [merged] })).toBeUndefined()
  expect(kind({ now: min(470), prs: [merged] })).toBe('wake')
  // an updatedAt bump no longer wakes it
  expect(kind({ now: min(30), prs: [{ ...merged, updatedAt: iso(20) }] })).toBeUndefined()
  expect(kind({ prs: [] })).toBeUndefined()
})
