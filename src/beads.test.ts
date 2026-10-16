import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backlogOf, beads, dispatchable, goalOf, isOwned, linearSourced, stationOf, type Bead } from './beads'

const bead = (id: string, extra: Partial<Bead> = {}): Bead => ({ id, title: `title ${id}`, ...extra })

test('only top-level beads no run holds are dispatched, up to the room left', () => {
  const ready = [
    ...[bead('fx-1'), bead('fx-1.1', { parent: 'fx-1' }), bead('fx-2'), bead('fx-5', { assignee: 'zach' })],
    ...[bead('fx-3'), bead('fx-4')],
  ]
  expect(dispatchable(ready, new Set(['fx-2']), 2).map(b => b.id)).toEqual(['fx-1', 'fx-3'])
  expect(dispatchable(ready, new Set(), 0)).toEqual([])
  expect(dispatchable(ready, new Set(), -3)).toEqual([])
})

test("the backlog counts each parent's closed children and marks open blockers, from the three listings", () => {
  const all = [
    bead('ap-1', { status: 'open' }),
    bead('ap-1.1', { status: 'closed', parent: 'ap-1' }),
    bead('ap-1.2', { status: 'open', parent: 'ap-1' }),
    bead('ap-1.3', { status: 'open', parent: 'ap-1' }),
    bead('ap-2', { status: 'open' }),
    bead('ap-3', { status: 'open' }),
  ]
  const ready = [
    bead('ap-1', { labels: ['factory'] }),
    bead('ap-1.2', { labels: ['factory'], parent: 'ap-1' }),
  ]
  const blocked = [
    // blocked by a closed bead and an open one: only the open one is shown
    bead('ap-1.3', { parent: 'ap-1', labels: ['factory'], status: 'open', blocked_by: ['ap-1.2', 'ap-1.1'] }),
    bead('ap-3', { status: 'open', blocked_by: ['ap-2'] }),
    bead('ap-4', { status: 'open', assignee: 'zach', blocked_by: ['ap-2'] }),
  ]
  const out = backlogOf(ready, [bead('ap-2')], blocked, all)
  expect(out.queued.map(b => b.id)).toEqual(['ap-1', 'ap-1.2', 'ap-1.3'])
  expect(out.queued[0]!.children).toEqual({ done: 1, total: 3 })
  expect(out.queued[2]!.blockedBy).toEqual(['ap-1.2'])
  expect(out.unqueued.map(b => [b.id, b.blockedBy])).toEqual([
    ['ap-2', undefined],
    ['ap-3', ['ap-2']],
  ])
  expect(out.unqueued[0]!.children).toBeUndefined()
})

test('a labeled top-level bead that is blocked still waits in the queue, with its blocker', () => {
  const blocked = [bead('ap-9', { labels: ['factory'], blocked_by: ['ap-8'] })]
  const out = backlogOf([], [], blocked, [bead('ap-8', { status: 'open' }), bead('ap-9', { status: 'open' })])
  expect(out.queued.map(b => [b.id, b.blockedBy])).toEqual([['ap-9', ['ap-8']]])
  expect(out.unqueued).toEqual([])
})

test('a bead becomes a goal and may name its station', () => {
  const b = bead('fx-9', {
    description: 'GET /health',
    acceptance_criteria: 'returns 200',
    labels: ['factory', 'station:incident'],
  })
  expect(goalOf(b)).toBe('fx-9: title fx-9\n\nGET /health\n\nAcceptance: returns 200')
  expect(stationOf(b)).toBe('incident')
  expect(stationOf(bead('fx-8', { labels: ['factory'] }))).toBeUndefined()
  expect(goalOf(bead('fx-7'))).toBe('fx-7: title fx-7')
})

test('a station label from a Linear pull never picks the start station (claude-factory-b6c.27)', () => {
  const pulled = bead('fx-10', {
    labels: ['factory', 'station:deploy'],
    external_ref: 'https://linear.app/acme/issue/STI-1',
  })
  expect(linearSourced(pulled)).toBe(true)
  expect(stationOf(pulled)).toBeUndefined() // a Linear-side label must not steer the start station
  const byHand = bead('fx-11', { labels: ['factory', 'station:deploy'] })
  expect(linearSourced(byHand)).toBe(false)
  expect(stationOf(byHand)).toBe('deploy') // a person's own label still works
})

test("a bead carrying its owner's decisions is theirs, not the factory's", () => {
  expect(isOwned(bead('fx-1', { metadata: { owner_decisions: { pilot: {} } } }))).toBe(true)
  expect(isOwned(bead('fx-2', { metadata: { speckit: {} } }))).toBe(false)
  expect(isOwned(bead('fx-3'))).toBe(false)
})

test('a heartbeat bd cannot make keeps the claim: lost only to a named other assignee', () => {
  const bin = join(tmpdir(), `fake-bd-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  // heartbeat and claim always fail; show answers with $SHOW, or fails when it is unset
  const script =
    '#!/bin/sh\ncase "$1" in show) [ -n "$SHOW" ] && echo "$SHOW" && exit 0;; esac\necho locked >&2; exit 1\n'
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory/run-1')
    delete process.env.SHOW
    expect(() => b.heartbeat('fx-1')).toThrow('bd unavailable')
    process.env.SHOW = '[{"id":"fx-1","assignee":"factory/run-1"}]'
    expect(b.heartbeat('fx-1')).toBe(true)
    process.env.SHOW = '[{"id":"fx-1","assignee":"someone-else"}]'
    expect(b.heartbeat('fx-1')).toBe(false)
  } finally {
    process.env.PATH = path
    delete process.env.SHOW
  }
})

test('human and owned: bd null means no human beads, and owned keeps unassigned beads carrying owner decisions', () => {
  const bin = join(tmpdir(), `fake-bd-human-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    'case "$1 $2" in',
    '"human list") echo "$HUMAN_JSON";;',
    '"ready --json") echo "$READY_JSON";;',
    '*) echo unexpected "$*" >&2; exit 1;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory')
    process.env.HUMAN_JSON = 'null'
    expect(b.human()).toEqual([])
    process.env.HUMAN_JSON = '[{"id":"fx-1","title":"t"}]'
    expect(b.human()).toEqual([{ id: 'fx-1', title: 't' }])

    process.env.READY_JSON = JSON.stringify([
      bead('fx-2', { metadata: { owner_decisions: {} } }),
      bead('fx-3', { metadata: { owner_decisions: {} }, assignee: 'someone' }),
      bead('fx-4'),
    ])
    expect(b.owned().map(x => x.id)).toEqual(['fx-2'])
  } finally {
    process.env.PATH = path
    delete process.env.HUMAN_JSON
    delete process.env.READY_JSON
  }
})

test('respond answers a human-flagged bead through bd human respond', () => {
  const bin = join(tmpdir(), `fake-bd-respond-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls')
  writeFileSync(join(bin, 'bd'), `#!/bin/sh\necho "$*" >> ${log}\n`)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory/person')
    b.respond('fx-7', 'go with postgres')
    expect(readFileSync(log, 'utf8').trim()).toBe(
      'human respond fx-7 -r go with postgres --actor factory/person',
    )
  } finally {
    process.env.PATH = path
  }
})

test('lookup tells a genuine "not found" from any other bd show failure, which it throws instead of swallowing', () => {
  const bin = join(tmpdir(), `fake-bd-lookup-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  // SHOW_MODE: found | notfound (bd's real not-found JSON on stdout, exit 1) | timeout (no JSON, exit 1) |
  // query-timeout (bd 1.3.0's query-time failure: the *same* not-found JSON on stdout as notfound, but
  // exit 1 with stderr "Error fetching <id>: <err>" instead of "Issue <id> not found") |
  // store-missing (bd 1.3.0's store-open failure: the shared server is up but this rig's own database is
  // not there; empty stdout, exit 1, stderr "Error: failed to open database: database ... not found on
  // Dolt server at ..." -- "not found" appears in that stderr too, so a lookup must not mistake it for a
  // genuine not-found)
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    'show)',
    '  case "$SHOW_MODE" in',
    `    found) printf '%s' '[{"id":"fx-1","title":"t"}]'; exit 0;;`,
    `    notfound) echo "Issue $2 not found" >&2; printf '%s' '{"error":"no issues found matching the provided IDs"}'; exit 1;;`,
    '    timeout) echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1;;',
    `    query-timeout) echo "Error fetching $2: dial tcp 127.0.0.1:3308: i/o timeout" >&2; printf '%s' '{"error":"no issues found matching the provided IDs"}'; exit 1;;`,
    `    store-missing) echo 'Error: failed to open database: database "zz" not found on Dolt server at 127.0.0.1:3308' >&2; exit 1;;`,
    '  esac;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory')
    process.env.SHOW_MODE = 'found'
    expect(b.lookup('fx-1')).toEqual({ id: 'fx-1', title: 't' })
    process.env.SHOW_MODE = 'notfound'
    expect(b.lookup('fx-9')).toBeNull()
    process.env.SHOW_MODE = 'timeout'
    expect(() => b.lookup('fx-9')).toThrow('bd show fx-9')
    expect(() => b.lookup('fx-9')).toThrow(/i\/o timeout/)
    process.env.SHOW_MODE = 'query-timeout'
    expect(() => b.lookup('fx-9')).toThrow('bd show fx-9')
    expect(() => b.lookup('fx-9')).toThrow(/i\/o timeout/)
    process.env.SHOW_MODE = 'store-missing'
    expect(() => b.lookup('fx-9')).toThrow('bd show fx-9')
    expect(() => b.lookup('fx-9')).toThrow(/database "zz" not found/)
  } finally {
    process.env.PATH = path
    delete process.env.SHOW_MODE
  }
})

test('prefixStrict throws instead of answering "" when bd config get fails', () => {
  const bin = join(tmpdir(), `fake-bd-prefix-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    'case "$1 $2" in',
    `"config get") if [ "$OK" = 1 ]; then printf '%s' 'acme'; else echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1; fi;;`,
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory')
    process.env.OK = '1'
    expect(b.prefixStrict()).toBe('acme')
    delete process.env.OK
    expect(() => b.prefixStrict()).toThrow(/i\/o timeout/)
  } finally {
    process.env.PATH = path
    delete process.env.OK
  }
})

test('create checks a timed-out create against its metadata token before one retry, never a silent duplicate', () => {
  const bin = join(tmpdir(), `fake-bd-create-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls')
  const mode = join(bin, 'mode')
  // CREATE_MODE: ok | landed | absent-then-ok | absent-always | list-fails
  const script = [
    '#!/bin/sh',
    `echo "$*" >> ${log}`,
    'case "$1" in',
    'create)',
    '  case "$(cat ' + mode + ')" in',
    '    ok) echo new-1; exit 0;;',
    '    landed) echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1;;',
    '    absent-then-ok)',
    '      if [ -f ' + bin + '/retried ]; then echo new-2; exit 0',
    '      else touch ' + bin + '/retried; echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1',
    '      fi;;',
    '    absent-always) echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1;;',
    '    list-fails) echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1;;',
    '  esac;;',
    'list)',
    '  case "$(cat ' + mode + ')" in',
    '    landed) printf \'%s\' \'[{"id":"landed-1"}]\'; exit 0;;',
    '    list-fails) echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1;;',
    "    *) printf '%s' '[]'; exit 0;;",
    '  esac;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory')
    const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    const createCalls = () => calls().filter(l => l.startsWith('create '))

    writeFileSync(mode, 'ok')
    writeFileSync(log, '')
    expect(b.create('t', 'd')).toBe('new-1')
    expect(createCalls().length).toBe(1)

    writeFileSync(mode, 'landed')
    writeFileSync(log, '')
    expect(b.create('t', 'd')).toBe('landed-1')
    expect(createCalls().length).toBe(1) // found via the metadata check: no retry

    writeFileSync(mode, 'absent-then-ok')
    writeFileSync(log, '')
    expect(b.create('t', 'd')).toBe('new-2')
    expect(createCalls().length).toBe(2) // absent: retried exactly once

    writeFileSync(mode, 'absent-always')
    writeFileSync(log, '')
    expect(() => b.create('t', 'd')).toThrow('bd create')
    expect(createCalls().length).toBe(2) // bounded: one retry, not more

    writeFileSync(mode, 'list-fails')
    writeFileSync(log, '')
    expect(() => b.create('t', 'd')).toThrow(/it may have landed/)
    expect(createCalls().length).toBe(1) // the check itself failed: no retry attempted
  } finally {
    process.env.PATH = path
    rmSync(join(bin, 'retried'), { force: true })
  }
})

test('a rejected bead stays open, out of the queue, saying who rejected it, when and why; queuing takes it back', () => {
  const bin = join(tmpdir(), `fake-bd-reject-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls')
  writeFileSync(join(bin, 'bd'), `#!/bin/sh\necho "$*" >> ${log}\n`)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory/run-1')
    b.reject('fx-1', 'run-1/triage', 'already tracked by fx-2')
    b.queue('fx-1')
    const [unclaim, update, queue] = readFileSync(log, 'utf8').trim().split('\n')
    expect(unclaim).toBe('unclaim fx-1 --actor factory/run-1')
    expect(update).toStartWith(
      'update fx-1 --remove-label factory --add-label rejected --set-metadata rejected_by=run-1/triage',
    )
    expect(update).toMatch(
      /--set-metadata rejected_at=\d{4}-\d\d-\d\dT[^ ]+ --set-metadata reject_reason=already tracked by fx-2 /,
    )
    // nothing closes it: still open and ready for a person
    expect(readFileSync(log, 'utf8')).not.toContain('close')
    expect(queue).toBe('update fx-1 --add-label factory --remove-label rejected --actor factory/run-1')
  } finally {
    process.env.PATH = path
  }
})

test('hasMetadata reads the metadata-field listing, true only when bd answers a non-empty array', () => {
  const bin = join(tmpdir(), `fake-bd-hasmeta-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls')
  const mode = join(bin, 'mode')
  const script = [
    '#!/bin/sh',
    `echo "$*" >> ${log}`,
    'case "$1 $2" in',
    '"list --all")',
    '  case "$(cat ' + mode + ')" in',
    '    hit) printf \'%s\' \'[{"id":"fx-9"}]\'; exit 0;;',
    "    miss) printf '%s' 'null'; exit 0;;",
    '    fail) echo "dial tcp 127.0.0.1:3308: i/o timeout" >&2; exit 1;;',
    '  esac;;',
    'esac',
  ].join('\n')
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory')

    writeFileSync(mode, 'hit')
    writeFileSync(log, '')
    expect(b.hasMetadata('pm_finding', 'starved-epic:a:fx-1')).toBe(true)
    expect(readFileSync(log, 'utf8').trim()).toBe(
      'list --all --metadata-field pm_finding=starved-epic:a:fx-1 --json -n 2 --actor factory',
    )

    writeFileSync(mode, 'miss')
    expect(b.hasMetadata('pm_finding', 'starved-epic:a:fx-1')).toBe(false)

    writeFileSync(mode, 'fail')
    expect(() => b.hasMetadata('pm_finding', 'starved-epic:a:fx-1')).toThrow(/bd list --metadata-field/)
  } finally {
    process.env.PATH = path
  }
})

test('fileFinding creates with the pm_finding metadata and no factory label; human adds the human label', () => {
  const bin = join(tmpdir(), `fake-bd-filefinding-${process.pid}`)
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls')
  const script = ['#!/bin/sh', `echo "$*" >> ${log}`, 'case "$1" in', '  create) echo new-1;;', 'esac'].join(
    '\n',
  )
  writeFileSync(join(bin, 'bd'), script)
  chmodSync(join(bin, 'bd'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const b = beads(tmpdir(), 'factory')

    writeFileSync(log, '')
    expect(b.fileFinding('t', 'd', 'epic-done-open:a:fx-1')).toBe('new-1')
    const unlabeled = readFileSync(log, 'utf8').trim()
    expect(unlabeled).toBe('create t -d d --metadata {"pm_finding":"epic-done-open:a:fx-1"} --actor factory')
    expect(unlabeled).not.toContain('-l factory')
    expect(unlabeled).not.toContain('-l human')

    writeFileSync(log, '')
    b.fileFinding('t2', 'd2', 'starved-epic:a:fx-2', { human: true })
    expect(readFileSync(log, 'utf8').trim()).toBe(
      'create t2 -d d2 --metadata {"pm_finding":"starved-epic:a:fx-2"} -l human --actor factory',
    )
  } finally {
    process.env.PATH = path
  }
})
