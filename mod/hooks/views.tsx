// The factory console's views. Presentational: register.tsx owns `$`, the data and the actions,
// and hands each view the surface's elements, its data and the actions as closures.
import type { Elements } from 'claude-code'

import type {
  FactoryBacklog,
  FactoryPrs,
  FactoryBead,
  FactoryBoard,
  FactoryDecisions,
  FactoryDetail,
  FactoryDraft,
  FactoryEdge,
  FactoryMail,
  FactoryRun,
  FactoryView,
} from '../types'
import {
  BEAD_TYPES,
  bar,
  beadInterviews,
  byState,
  blockers,
  clockOf,
  counts,
  dur,
  isLive,
  interviews,
  line,
  mailKey,
  mailTabs,
  prName,
  prState,
  progress,
  tiers,
  toggled,
  rigStats,
  shortId,
  sparkline,
  stateOf,
  track,
  withProposals,
  type Interview,
  type TierRow,
} from './view'

/** what every surface the console draws on has; mobile has no Input or Select */
export type UI = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Code'> &
  Partial<Pick<Elements['desktop'], 'Input' | 'Select'>>

export type Actions = {
  /** runs a factory CLI command, toasts its answer and ticks */
  cli: (...args: string[]) => void
  show: (view: FactoryView, run?: string) => void
  /** opens a run's card in place on the board (an id), or closes whichever card is open (null) */
  select: (run: string | null) => void
  draft: (patch: Partial<FactoryDraft>) => void
  decide: (run: string, outcome: string) => void
  /** the person's quick answer to a worker's mail: approve, reject, or what they typed */
  answer: (m: FactoryMail, kind: 'approve' | 'reject' | 'reply') => void
  /** the person's answer to an interview question: one of its options, what they typed, or both */
  interview: (iv: Interview, choice?: string) => void
  jump: (pane: string) => void
  /** picks the backlog's type filter */
  backlogType: (type: string) => void
  /** sweeps every rig's bd for open decisions, into the interview tab's open list */
  sweep: () => void
}

type Base = { ui: UI; act: Actions; width: number; now: number }

export { isLive } from './view'

/** one phrase and one color for where a run stands */
export function standing(r: FactoryRun, now: number) {
  if (!r.node) return r.idle ? { word: 'idle', color: 'gray' } : { word: 'error', color: 'red' }
  if (r.node === 'done') return { word: 'done', color: 'gray' }
  if (r.node === 'aborted') return { word: 'aborted', color: 'gray' }
  if (r.gate) return { word: 'awaiting you', color: 'yellow' }
  if (r.sub === 'stuck') return { word: 'stuck', color: 'red' }
  if (r.sub === 'backoff') return { word: 'retrying soon', color: 'yellow' }
  if (r.sub === 'waiting')
    return { word: r.wakeAt ? `wakes in ${dur(r.wakeAt - now)}` : 'waiting', color: 'blue' }
  if (r.agent === 'blocked') return { word: 'worker blocked', color: 'red' }
  // herdr names the state of an agent it recognizes; any other worker process is just running
  const word = r.agent === 'idle' || r.agent === 'done' ? 'idle' : r.agent === 'unknown' ? 'running' : r.agent
  return { word: word ?? 'starting', color: 'green' }
}

/** an absolute path cut to its last two parts; a repo's own `.factory/x.ts at sha` stays whole */
const shortPath = (path: string) => (path.startsWith('/') ? `…/${path.split('/').slice(-2).join('/')}` : path)

const edgeText = (e: FactoryEdge) =>
  `${e.outcome} → ${e.to}${e.delayMin ? ` after ${dur(e.delayMin * 60_000)}` : ''}${e.defer ? ' (deferred)' : ''}`

const TABS: [FactoryView, string, string][] = [
  ['board', 'Board', '1'],
  ['backlog', 'Backlog', '2'],
  ['mail', 'Mail', '3'],
  ['rigs', 'Rigs', '4'],
  ['prs', 'PRs', '5'],
  ['interview', 'Interview', '6'],
]

/** a column that keeps its width: ids, badges and times never shrink, so free text beside them truncates instead */
function cell(
  { ui }: Base,
  key: string,
  text: string,
  props: { color?: string; dimColor?: boolean; width?: number } = {},
) {
  const { Box, Text } = ui
  const { width, ...paint } = props
  return (
    <Box key={key} flexShrink={0} width={width}>
      <Text {...paint} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
}

/** the row's free text: the one column that shrinks, truncated at the edge */
function rest({ ui }: Base, key: string, text: string, props: { color?: string; dimColor?: boolean } = {}) {
  const { Box, Text } = ui
  return (
    <Box key={key} flexGrow={1} flexShrink={1} minWidth={0}>
      <Text {...props} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
}

function rule({ ui, width }: Base, title: string, note = '') {
  const { Text } = ui
  const head = `── ${title} `
  return (
    <Text>
      <Text bold color="magenta">
        {head}
      </Text>
      <Text dimColor>{note ? `${note} ` : ''}</Text>
      <Text dimColor>{'─'.repeat(Math.max(0, width - head.length - (note ? note.length + 1 : 0)))}</Text>
    </Text>
  )
}

function trail({ ui }: Base, r: FactoryRun) {
  const { Text } = ui
  const stops = track(r.trail ?? [], r.node ?? '')
  return (
    <Text wrap="truncate-start">
      {stops.map((s, i) => (
        <Text color={s.isCurrent ? 'cyan' : 'green'} bold={s.isCurrent} dimColor={!s.isCurrent}>
          {i ? ' › ' : ''}
          {s.isCurrent ? '● ' : ''}
          {s.id}
          {s.runs > 1 ? `×${s.runs}` : ''}
        </Text>
      ))}
    </Text>
  )
}

function gate(p: Base, r: FactoryRun, draft: FactoryDraft, isFocused = false) {
  const { Box, Text, Button, Input } = p.ui
  return (
    <Box key={`gate-${r.id}`} flexDirection="column" marginTop={1}>
      <Text color="yellow" bold wrap="wrap">
        ? {r.gate!.question}
      </Text>
      {Input && (
        <Input
          key={`note-${r.id}`}
          autoFocus={isFocused || undefined}
          placeholder="a note for the next station (optional), then decide"
          value={draft.notes[r.id] ?? ''}
          onInput={v => p.act.draft({ notes: { ...draft.notes, [r.id]: v } })}
          onSubmit={v => p.act.draft({ notes: { ...draft.notes, [r.id]: v } })}
        />
      )}
      <Box gap={1}>
        {r.gate!.outcomes.map((o, i) => (
          <Button
            key={`decide-${r.id}-${o}`}
            label={o}
            variant={i === 0 ? 'primary' : undefined}
            onPress={() => p.act.decide(r.id, o)}
          />
        ))}
      </Box>
    </Box>
  )
}

export function header(p: Base, board: FactoryBoard, history: number[], view: FactoryView) {
  const { Box, Text, Button } = p.ui
  const live = board.runs.filter(isLive)
  const { working, gates, stuck, waiting } = counts(board.runs)
  const stat = (n: number, color: string, label: string) =>
    n > 0 && (
      <Text>
        <Text bold color={color}>
          {String(n)}
        </Text>{' '}
        {label}
      </Text>
    )
  return (
    <Box key="header" flexDirection="column" marginBottom={1}>
      <Box gap={2}>
        <Text bold color="magenta">
          ◆ FACTORY
        </Text>
        <Text color="green">{sparkline(history, Math.min(24, Math.max(8, p.width - 60)), 8)}</Text>
        {stat(working, 'green', 'working')}
        {stat(gates, 'yellow', 'awaiting you')}
        {stat(stuck, 'red', 'stuck')}
        {stat(waiting, 'blue', 'waiting')}
        {live.length === 0 && !board.halt && <Text dimColor>idle</Text>}
        {board.staleSince !== undefined && (
          <Text bold color="red">
            ! stale since {clockOf(board.staleSince)}
          </Text>
        )}
        {board.halt && (
          <Text bold color="yellow">
            {board.halt === 'paused' ? '⏸ paused' : '… stopping'}
          </Text>
        )}
        {board.halt ? (
          <Button key="halt-resume" label="resume" variant="primary" onPress={() => p.act.cli('resume')} />
        ) : (
          live.length > 0 && (
            <Button key="halt-stop" label="stop" dimColor onPress={() => p.act.cli('stop')} />
          )
        )}
      </Box>
      <Box gap={1}>
        {TABS.map(([v, label, key]) => (
          <Button
            key={`tab-${v}`}
            label={label}
            hotkey={key}
            plain
            variant={view === v ? 'primary' : undefined}
            dimColor={view !== v}
            onPress={() => p.act.show(v)}
          />
        ))}
      </Box>
    </Box>
  )
}

/** everything the old Run tab drew for one run, now inside its card: the full goal, the follows
 * line, the edges out of its current station, the error and gate, Steer (mail, station, goto,
 * fork, retry, jump, abort), Tasks, Journal and the Worker peek. `close` (hotkey b) replaces the
 * old tab's `back`, collapsing the card instead of switching tabs. */
function runDetail(p: Base, d: FactoryDetail | null, peek: string, draft: FactoryDraft, id: string) {
  const { Box, Text, Button, Code, Input, Select } = p.ui
  if (!d || d.id !== id)
    return (
      <Box key={`detail-${id}`} flexDirection="column">
        <Text dimColor>loading…</Text>
        <Button key={`close-${id}`} label="close" hotkey="b" dimColor onPress={() => p.act.select(null)} />
      </Box>
    )
  const here = d.stations.find(x => x.id === d.node)
  const tasks = d.tasks ?? []
  const closed = tasks.filter(t => t.status === 'closed').length
  const stations = d.stations.map(x => ({ value: x.id, label: x.gate ? `${x.id} (gate)` : x.id }))
  const target = draft.target || d.node || d.start
  return (
    <Box key={`detail-${id}`} flexDirection="column">
      <Text wrap="wrap">
        {d.run.goal.length > 1200
          ? `${d.run.goal.slice(0, 1200)}… (the rest: bd show ${d.run.bead ?? d.id})`
          : d.run.goal}
      </Text>
      <Text dimColor wrap="truncate-end">
        follows {shortPath(d.run.factory)} · branch {d.run.branch}
      </Text>
      {trail(p, d)}
      {here && (
        <Text dimColor wrap="wrap">
          from {here.id}: {here.next.map(edgeText).join(' · ')}
        </Text>
      )}
      {d.error && (
        <Text color="red" wrap="wrap">
          ! {d.error}
        </Text>
      )}
      {d.gate && gate(p, d, draft, true)}

      {rule(p, 'Steer')}
      {Input && d.isWorking && !d.gate && (
        <Input
          key={`mail-${d.id}`}
          label={`mail ${d.node}`}
          placeholder="a message delivered into the worker's session"
          value={draft.mail}
          onInput={v => p.act.draft({ mail: v })}
          onSubmit={v => {
            p.act.cli('mail', d.id, d.node!, v)
            p.act.draft({ mail: '' })
          }}
        />
      )}
      {Select && (
        <Select
          key={`target-${d.id}`}
          label="station"
          options={[...stations, { value: 'done', label: 'done' }]}
          value={target}
          onSelect={v => p.act.draft({ target: v })}
        />
      )}
      <Box gap={1}>
        {Select && (
          <Button
            key={`goto-${d.id}`}
            label={target === d.node ? `restart ${target}` : `go to ${target}`}
            onPress={() => p.act.cli('goto', d.id, target)}
          />
        )}
        {Select && (
          <Button
            key={`fork-${d.id}`}
            label={`fork at ${target}`}
            onPress={() => target !== 'done' && p.act.cli('fork', d.id, target)}
          />
        )}
        {d.sub === 'stuck' && (
          <Button
            key={`retry-${d.id}`}
            label="retry"
            variant="primary"
            onPress={() => p.act.cli('retry', d.id)}
          />
        )}
        {d.pane && (
          <Button
            key={`jumpto-${d.id}`}
            label="jump to worker"
            hotkey="j"
            onPress={() => p.act.jump(d.pane!)}
          />
        )}
        <Button key={`kill-${d.id}`} label="abort" dimColor onPress={() => p.act.cli('abort', d.id)} />
        <Button key={`close-${d.id}`} label="close" hotkey="b" dimColor onPress={() => p.act.select(null)} />
      </Box>

      {d.tasks && rule(p, 'Tasks', `${closed}/${tasks.length} closed`)}
      {d.tasks && tasks.length > 0 && (
        <Text color="green">{bar(closed, tasks.length, Math.min(40, p.width - 2))}</Text>
      )}
      {tasks
        .filter(t => t.status !== 'closed')
        .slice(0, 8)
        .map(t => (
          <Text wrap="truncate-end">
            <Text color={t.status === 'in_progress' ? 'cyan' : undefined}>
              {t.status === 'in_progress' ? '▶' : '○'}
            </Text>{' '}
            <Text dimColor>{t.id}</Text> {t.title}
          </Text>
        ))}

      {rule(p, 'Journal', `${d.log.length} reports`)}
      {d.log.length === 0 && <Text dimColor>No reports yet.</Text>}
      {[...d.log]
        .reverse()
        .slice(0, 8)
        .map(e => (
          <Box key={`entry-${e.at}-${e.node}`} flexDirection="column">
            <Text>
              <Text dimColor>{clockOf(e.at)} </Text>
              <Text bold>
                {e.node}#{e.attempt}
              </Text>{' '}
              <Text color={e.outcome === 'fail' ? 'red' : 'green'}>{e.outcome}</Text>
            </Text>
            <Text dimColor wrap="wrap">
              {'  '}
              {line(e.summary, 600)}
            </Text>
          </Box>
        ))}
      {d.inbox.length > 0 && (
        <Text color="yellow" wrap="wrap">
          ✉ {d.inbox.length} unread for {d.node}: {line(d.inbox.at(-1)!.text, 200)}
        </Text>
      )}

      {rule(
        p,
        'Worker',
        d.pane ? `${d.pane} · ${standing(d, p.now).word}` : d.isWorking ? 'starting' : 'none now',
      )}
      {peek ? <Code source={peek} wrap="truncate-end" /> : <Text dimColor>No worker output to show.</Text>}
    </Box>
  )
}

/** an open board card: the run's full `runDetail`, with the border's padding taken off its width (A7) */
function card(p: Base, r: FactoryRun, draft: FactoryDraft, detail: FactoryDetail | null, peek: string) {
  const { Box, Text, Button } = p.ui
  const s = standing(r, p.now)
  const timer = r.sub === 'working' && r.since && !r.gate ? ` · ${dur(p.now - r.since)}` : ''
  const tries = r.attempt && r.attempt > 1 ? ` · try ${r.attempt}/${r.attempts}` : ''
  return (
    <Box key={`card-${r.id}`} flexDirection="column" borderStyle="round" borderColor={s.color} paddingX={1}>
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color="magenta">{r.rig ? `${r.rig}  ` : ''}</Text>
          <Text bold>{r.id}</Text>
          <Text color="cyan">{r.bead ? `  ${r.bead}` : ''}</Text>
        </Text>
        <Box gap={1} flexShrink={0}>
          <Text color={s.color}>
            {r.node} · {s.word}
            {tries}
            {timer}
          </Text>
          {/* shrinks it back to its tile; the Steer row's close sits at the bottom of a long card */}
          <Button key={`shrink-${r.id}`} label="-" dimColor onPress={() => p.act.select(null)} />
        </Box>
      </Box>
      {runDetail({ ...p, width: Math.max(1, p.width - 4) }, detail, peek, draft, r.id)}
    </Box>
  )
}

const COLUMNS = {
  gates: { title: '? AWAITING YOU', color: 'yellow' },
  stuck: { title: '! STUCK', color: 'red' },
  working: { title: '● WORKING', color: 'green' },
  waiting: { title: '◷ WAITING', color: 'blue' },
}

/** side by side from here: four columns of at least 29 cells each */
const WIDE = 120

/** the station and how long: time in it, how quiet a stuck one is, when a waiting one wakes */
function stationTime(r: FactoryRun, now: number) {
  const state = stateOf(r)
  const time =
    state === 'stuck' && r.quietMin !== undefined
      ? `quiet ${dur(r.quietMin * 60_000)}`
      : state === 'waiting' && r.wakeAt
        ? `wakes ${clockOf(r.wakeAt)}`
        : r.since
          ? dur(now - r.since)
          : ''
  return [r.node, time].filter(Boolean).join(' ')
}

/** the station and its time, then what else a glance should catch: the try, the last report's age, a usage limit */
function tileFacts(r: FactoryRun, now: number) {
  return [
    stationTime(r, now),
    r.attempt && r.attempt > 1 ? `try ${r.attempt}/${r.attempts}` : '',
    r.last ? `reported ${dur(now - r.last.at)} ago` : '',
    r.limitUntil && r.limitUntil > now ? `limit until ${clockOf(r.limitUntil)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** the one line of why: the gate's question, what stuck it, or where the run last got to */
function why(r: FactoryRun) {
  const last = r.last ? line(r.last.summary, 120) : ''
  if (r.gate) return line(r.gate.question, 120)
  if (stateOf(r) === 'stuck')
    return r.error ? line(r.error, 120) : r.agent === 'blocked' ? 'worker blocked' : last
  return last
}

/** a compact board card `w` cells wide; a gate stays answerable here, its question and buttons in place of the why line */
function tile(p: Base, r: FactoryRun, draft: FactoryDraft, w: number, isOpen: boolean) {
  const { Box, Button } = p.ui
  const q = { ...p, width: w }
  return (
    <Box key={`tile-${r.id}`} flexDirection="column" width={w} marginBottom={1}>
      <Box gap={1}>
        {cell(q, `tile-id-${r.id}`, w >= 60 ? r.id : shortId(r.id), { color: 'cyan' })}
        {r.rig && rest(q, `tile-rig-${r.id}`, r.rig, { color: 'magenta' })}
        {/* the open card below carries the close button */}
        {!isOpen && <Button key={`open-${r.id}`} label="open" onPress={() => p.act.select(r.id)} />}
      </Box>
      <Box gap={1}>
        {r.bead && cell(q, `tile-bead-${r.id}`, r.bead, { color: 'cyan' })}
        {rest(q, `tile-goal-${r.id}`, r.goal ? line(r.goal, 200) : '')}
      </Box>
      {cell(q, `tile-at-${r.id}`, tileFacts(r, p.now), { width: w })}
      {r.gate ? gate(q, r, draft) : cell(q, `tile-why-${r.id}`, why(r), { dimColor: true, width: w })}
    </Box>
  )
}

/** the live runs by state: columns side by side when wide, else stacked sections with the open card in place */
function lanes(
  p: Base,
  runs: FactoryRun[],
  draft: FactoryDraft,
  selected: string | null,
  expanded: (r: FactoryRun) => JSX.Element,
) {
  const { Box, Text } = p.ui
  const groups = byState(runs)
  if (p.width < WIDE)
    return groups
      .filter(g => g.runs.length)
      .map(g => (
        <Box key={`lane-${g.state}`} flexDirection="column">
          {rule(p, COLUMNS[g.state].title, String(g.runs.length))}
          {g.runs.map(r => (r.id === selected ? expanded(r) : tile(p, r, draft, p.width, false)))}
        </Box>
      ))
  // what needs the person goes first and full width, where a gate's question and buttons have room
  const [gates, ...cols] = groups
  const w = Math.floor((p.width - 2) / 3)
  return (
    <Box key="lanes-wide" flexDirection="column">
      {gates!.runs.length > 0 && (
        <Box key={`lane-${gates!.state}`} flexDirection="column">
          {rule(p, COLUMNS.gates.title, String(gates!.runs.length))}
          {gates!.runs.map(r => tile(p, r, draft, p.width, r.id === selected))}
        </Box>
      )}
      <Box key="lanes" gap={1}>
        {cols.map(g => (
          <Box key={`lane-${g.state}`} flexDirection="column" width={w}>
            {cell(p, `lane-head-${g.state}`, `${COLUMNS[g.state].title} (${g.runs.length})`, {
              color: COLUMNS[g.state].color,
              width: w,
            })}
            <Text dimColor>{'─'.repeat(w)}</Text>
            {g.runs.length ? (
              g.runs.map(r => tile(p, r, draft, w, r.id === selected))
            ) : (
              <Text dimColor>none</Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export function boardView(
  p: Base,
  board: FactoryBoard,
  draft: FactoryDraft,
  selected: string | null,
  detail: FactoryDetail | null,
  peek: string,
) {
  const { Box, Text, Button } = p.ui
  const live = board.runs.filter(isLive)
  // newest first; the rest stay until `factory rm`
  const over = board.runs.filter(r => !isLive(r)).sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0))
  if (!board.runs.length)
    return (
      <Box key="board" flexDirection="column">
        <Text dimColor>No runs yet.</Text>
        <Text dimColor>2 shows the backlog each rig feeds; queue or start one from there.</Text>
      </Box>
    )
  const open = live.find(r => r.id === selected)
  // a selected run that isn't live (finished, or opened from elsewhere and since finished) still
  // opens above the Finished rule, even while that list stays collapsed (A5)
  const openOver: FactoryRun | undefined =
    selected && !open
      ? (over.find(r => r.id === selected) ?? (detail?.id === selected ? detail : { id: selected }))
      : undefined
  const expanded = (r: FactoryRun) => card(p, r, draft, detail, peek)
  return (
    <Box key="board" flexDirection="column">
      {lanes(p, live, draft, selected, expanded)}
      {/* side by side, the open card goes below the columns; stacked, `lanes` drew it in place */}
      {open && p.width >= WIDE && expanded(open)}
      {openOver && expanded(openOver)}
      {over.length > 0 && (
        <Box gap={1}>
          {rule({ ...p, width: p.width - 8 }, 'Finished', String(over.length))}
          <Button
            key="finished-toggle"
            label={draft.isFinishedShown ? 'hide' : 'show'}
            dimColor
            onPress={() => p.act.draft({ isFinishedShown: !draft.isFinishedShown })}
          />
        </Box>
      )}
      {draft.isFinishedShown && over.length > 10 && (
        <Text dimColor>the last 10 of {String(over.length)}</Text>
      )}
      {(draft.isFinishedShown ? over.slice(0, 10) : [])
        .filter(r => r.id !== selected)
        .map(r => (
          <Box key={`over-${r.id}`} gap={1}>
            {cell(p, `over-glyph-${r.id}`, r.node === 'done' ? '✓' : r.node ? '✗' : '!', {
              color: standing(r, p.now).color,
            })}
            {cell(p, `over-id-${r.id}`, r.id, { color: 'cyan' })}
            {rest(
              p,
              `over-text-${r.id}`,
              r.error
                ? line(r.error, 120)
                : r.last
                  ? `${r.last.node} ${r.last.outcome}: ${line(r.last.summary, 120)}`
                  : '',
              { dimColor: true },
            )}
            <Button key={`view-${r.id}`} label="open" dimColor onPress={() => p.act.select(r.id)} />
            <Button key={`rm-${r.id}`} label="remove" dimColor onPress={() => p.act.cli('rm', r.id)} />
          </Box>
        ))}
    </Box>
  )
}

function beadRow(
  p: Base,
  repo: { repo: string; factory: string },
  x: TierRow,
  isQueued: boolean,
  row: { tier?: number; idWidth: number; progWidth: number; open: readonly string[] },
) {
  const { Box, Button } = p.ui
  const b = x.bead
  // the tier heading says the priority; a row repeats it only when it differs (a child of another priority)
  const badge = b.priority === row.tier ? '' : b.priority === undefined ? '–' : `P${b.priority}`
  const blocker = blockers(b)
  return (
    <Box key={`bead-${b.id}`} gap={1}>
      {cell(p, `prio-${b.id}`, badge, {
        width: 2,
        color: b.priority !== undefined && b.priority <= 1 ? 'red' : undefined,
        dimColor: b.priority === undefined || b.priority > 1,
      })}
      {cell(p, `id-${b.id}`, `${x.connector}${b.id}`, { color: 'cyan', width: row.idWidth })}
      {rest(p, `title-${b.id}`, `${b.title}${b.type ? `  ${b.type}` : ''}`)}
      {blocker && cell(p, `blocked-${b.id}`, blocker, { color: 'red' })}
      {row.progWidth > 0 && cell(p, `prog-${b.id}`, progress(b), { dimColor: true, width: row.progWidth })}
      {x.kids > 0 ? (
        <Button
          key={`toggle-${b.id}`}
          label={x.isOpen ? '▾' : '▸'}
          plain
          onPress={() => p.act.draft({ backlogOpen: toggled(row.open, b.id) })}
        />
      ) : (
        cell(p, `toggle-${b.id}`, ' ', { width: 1 })
      )}
      {!isQueued && !b.parent && (
        <Button key={`queue-${b.id}`} label="queue" onPress={() => p.act.cli('queue', repo.repo, b.id)} />
      )}
      <Button
        key={`now-${b.id}`}
        label="start now"
        dimColor={!isQueued}
        onPress={() => p.act.cli('start', repo.factory, repo.repo, b.id)}
      />
    </Box>
  )
}

/** one rig's list under a heading: priority tiers, each parent with its children, cut after `limit` rows */
function beadList(
  p: Base,
  r: FactoryBacklog[number],
  list: FactoryBead[],
  type: string,
  isQueued: boolean,
  open: readonly string[],
  limit?: number,
) {
  const { Box, Text } = p.ui
  const t = tiers(list, type, limit, new Set(open))
  const rows = t.tiers.flatMap(g => g.rows)
  // ids padded to the widest, connector included, so every title in the list starts in one column
  const idWidth = Math.max(0, ...rows.map(x => x.connector.length + x.bead.id.length))
  const progWidth = Math.max(0, ...rows.map(x => progress(x.bead).length))
  return (
    <Box key={`list-${r.name}-${isQueued}`} flexDirection="column">
      {t.tiers.map(g => (
        <Box key={`tier-${r.name}-${isQueued}-${g.tier}`} flexDirection="column">
          <Text dimColor> {g.tier}</Text>
          {g.rows.map(x => beadRow(p, r, x, isQueued, { tier: g.priority, idWidth, progWidth, open }))}
        </Box>
      ))}
      {t.more > 0 && <Text dimColor> + {String(t.more)} more</Text>}
    </Box>
  )
}

export function backlogView(p: Base, backlog: FactoryBacklog, type = 'all', draft: FactoryDraft) {
  const { Box, Text, Button } = p.ui
  if (!backlog.length)
    return (
      <Box key="backlog" flexDirection="column">
        <Text dimColor>
          No rigs. `factory rig add {'<name> <repo>'}` turns a repo's beads labeled factory into runs.
        </Text>
      </Box>
    )
  const open = draft.backlogOpen ?? []
  const rigs = draft.backlogRig ? backlog.filter(r => r.name === draft.backlogRig) : backlog
  return (
    <Box key="backlog" flexDirection="column">
      <Box gap={1} marginBottom={1}>
        {['all', ...BEAD_TYPES].map(t => (
          <Button
            key={`backlog-type-${t}`}
            label={t}
            plain
            variant={type === t ? 'primary' : undefined}
            dimColor={type !== t}
            onPress={() => p.act.backlogType(t)}
          />
        ))}
        {draft.backlogRig && (
          <Button
            key="backlog-all-rigs"
            label="all rigs"
            onPress={() => p.act.draft({ backlogRig: undefined })}
          />
        )}
      </Box>
      {rigs.length === 0 && <Text dimColor>No rig named {draft.backlogRig}.</Text>}
      {rigs.map(r => (
        <Box key={`rig-${r.name}`} flexDirection="column" marginBottom={1}>
          {rule(
            p,
            r.name,
            `· busy ${r.busy}${r.maxRuns ? `/${r.maxRuns}` : ''} · ${r.queued.length} queued · ${r.unqueued.length} waiting`,
          )}
          {r.error && <Text color="red">! {r.error}</Text>}
          <Text color="green">will start ({String(tiers(r.queued, type).total)})</Text>
          {r.queued.length === 0 && <Text dimColor> nothing queued</Text>}
          {beadList(p, r, r.queued, type, true, open)}
          <Text color="yellow">waiting for you to queue ({String(tiers(r.unqueued, type).total)})</Text>
          {beadList(p, r, r.unqueued, type, false, open, 15)}
        </Box>
      ))}
    </Box>
  )
}

/** every rig: its cap and how full it is, its goal, where its runs stand, what needs the person */
export function rigsView(p: Base, board: FactoryBoard) {
  const { Box, Text, Button } = p.ui
  const rigs = board.rigs ?? []
  const loose = board.runs.filter(r => isLive(r) && !r.rig)
  if (!rigs.length)
    return (
      <Box key="rigs" flexDirection="column">
        <Text dimColor>
          No rigs. `factory rig add {'<name> <repo>'}` names a repo for the factory to work, with its own cap,
          sweeps and goal.
        </Text>
      </Box>
    )
  return (
    <Box key="rigs" flexDirection="column">
      {rigs.map(g => {
        const s = rigStats(g, board.runs)
        const sweeps =
          g.sweeps === undefined ? 'all sweeps' : g.sweeps.length ? g.sweeps.join(', ') : 'no sweeps'
        return (
          <Box key={`rigs-${g.name}`} flexDirection="column" marginBottom={1}>
            {rule(p, g.name, `${shortPath(g.repo)} · ${shortPath(g.factory)} · ${sweeps}`)}
            <Box gap={1}>
              <Text color={s.room === 0 ? 'yellow' : 'green'}>
                {g.maxRuns ? bar(s.busy, g.maxRuns, Math.min(g.maxRuns, 20)) : '∞'}
              </Text>
              <Text>
                busy {String(s.busy)}
                {g.maxRuns ? `/${g.maxRuns}` : ''}
              </Text>
              <Text dimColor>
                {s.room === 0 ? '· full' : s.room ? `· room for ${s.room}` : '· no cap of its own'}
              </Text>
            </Box>
            {g.goal && <Text wrap="wrap">◎ {g.goal}</Text>}
            {g.linear && (
              <Box key={`rigs-linear-${g.name}`}>
                {g.linearSync?.error ? (
                  <Text color="red" wrap="wrap">{`linear: ${g.linearSync.error}`}</Text>
                ) : (
                  <Text dimColor>
                    linear
                    {g.linearSync
                      ? ` · pulled ${g.linearSync.pulled ?? 0}${g.linearSync.unrouted ? `, unrouted ${g.linearSync.unrouted}` : ''} · ${dur(p.now - g.linearSync.at)} ago`
                      : ''}
                  </Text>
                )}
              </Box>
            )}
            {s.stations.length > 0 ? (
              <Text wrap="wrap">
                {s.stations.map(({ node, n }, i) => (
                  <Text color="cyan">
                    {i ? ' · ' : ''}
                    {node} {String(n)}
                  </Text>
                ))}
              </Text>
            ) : (
              <Text dimColor>no live runs</Text>
            )}
            {s.gates.length > 0 && <Text color="yellow">awaiting you: {s.gates.join(', ')}</Text>}
            {s.stuck.length > 0 && <Text color="red">stuck: {s.stuck.join(', ')}</Text>}
            <Text dimColor>
              finished {String(s.done)}
              {s.aborted ? ` · aborted ${s.aborted}` : ''}
            </Text>
            <Box gap={1}>
              <Button
                key={`rigs-backlog-${g.name}`}
                label="backlog"
                onPress={() => {
                  p.act.draft({ backlogRig: g.name })
                  p.act.show('backlog')
                }}
              />
            </Box>
          </Box>
        )
      })}
      {loose.length > 0 && rule(p, 'outside any rig', String(loose.length))}
      {loose.map(r => (
        <Box key={`rigs-loose-${r.id}`} gap={1}>
          {cell(p, `rigs-loose-id-${r.id}`, r.id, { color: 'cyan' })}
          {rest(p, `rigs-loose-node-${r.id}`, r.node ?? '', { color: standing(r, p.now).color })}
          <Button key={`rigs-open-${r.id}`} label="open" dimColor onPress={() => p.act.select(r.id)} />
        </Box>
      ))}
    </Box>
  )
}

/** the answers a person gives a worker's mail in one keypress, or a gate's own outcomes */
function quickAnswers(
  p: Base,
  m: FactoryMail,
  r: FactoryRun | undefined,
  draft: FactoryDraft,
  isNewest: boolean,
) {
  const { Box, Text, Button, Input } = p.ui
  const key = mailKey(m)
  const done = draft.answered?.[key]
  if (done) return <Text dimColor>✓ you: {line(done, 200)}</Text>
  if (!r || !isLive(r)) return <Text dimColor>the run has ended</Text>
  // a gate's question is answered by deciding it
  if (r.gate && r.node === m.from)
    // one gate, one set of buttons: an earlier message from it points at the newest
    return isNewest ? gate(p, r, draft) : <Text dimColor>answer it at its newest message above</Text>
  const typed = draft.replies?.[key] ?? ''
  return (
    <Box flexDirection="column">
      {Input && (
        <Input
          key={`reply-${key}`}
          placeholder="feedback for the worker (optional with approve or reject)"
          value={typed}
          onInput={v => p.act.draft({ replies: { ...draft.replies, [key]: v } })}
          onSubmit={v => {
            p.act.draft({ replies: { ...draft.replies, [key]: v } })
            if (v.trim()) p.act.answer(m, 'reply')
          }}
        />
      )}
      <Box gap={1}>
        <Button
          key={`approve-${key}`}
          label="approve"
          variant="primary"
          onPress={() => p.act.answer(m, 'approve')}
        />
        <Button key={`reject-${key}`} label="reject" onPress={() => p.act.answer(m, 'reject')} />
        {Input && typed.trim() && (
          <Button key={`send-${key}`} label="send feedback" onPress={() => p.act.answer(m, 'reply')} />
        )}
      </Box>
    </Box>
  )
}

export function mailView(p: Base, board: FactoryBoard, draft: FactoryDraft) {
  const { Box, Text, Button } = p.ui
  const tabs = mailTabs(board.mail, board.runs, draft.answered)
  const tab = draft.mailTab ?? 'open'
  const mail = [...tabs[tab]].reverse()
  // oldest first, so each run and station keeps its newest message's key
  const newest = new Set(new Map(board.mail.map(m => [`${m.run}/${m.from}`, mailKey(m)])).values())
  return (
    <Box key="mail" flexDirection="column">
      <Box gap={1} marginBottom={1}>
        {(['open', 'answered'] as const).map(t => (
          <Button
            key={`mail-tab-${t}`}
            label={`${t === 'open' ? 'not answered' : 'answered'} (${tabs[t].length})`}
            plain
            variant={tab === t ? 'primary' : undefined}
            dimColor={tab !== t}
            onPress={() => p.act.draft({ mailTab: t })}
          />
        ))}
      </Box>
      {mail.length === 0 && (
        <Text dimColor>{tab === 'open' ? 'Nothing waits on your answer.' : 'Nothing answered yet.'}</Text>
      )}
      {mail.map(m => (
        <Box key={`mail-${m.run}-${m.at}`} flexDirection="column" marginBottom={1}>
          <Box gap={1}>
            {cell(p, `mail-at-${m.run}-${m.at}`, clockOf(m.at), { dimColor: true })}
            {cell(p, `mail-run-${m.run}-${m.at}`, m.run, { color: 'cyan' })}
            {rest(p, `mail-from-${m.run}-${m.at}`, m.from, { dimColor: true })}
            <Button
              key={`mail-open-${m.run}-${m.at}`}
              label="open run"
              dimColor
              onPress={() => p.act.select(m.run)}
            />
          </Box>
          <Text wrap="wrap">{line(m.text, 800)}</Text>
          {quickAnswers(
            p,
            m,
            board.runs.find(r => r.id === m.run),
            draft,
            newest.has(mailKey(m)),
          )}
        </Box>
      ))}
    </Box>
  )
}

/** questions for the person from runs that hit a problem only they can settle, and the answers they gave */
export function interviewView(
  p: Base,
  board: FactoryBoard,
  draft: FactoryDraft,
  decisions: FactoryDecisions,
) {
  const { Box, Text, Button, Input } = p.ui
  const answered = Object.fromEntries((draft.interviewed ?? []).map(d => [d.key, d.answer]))
  const open = withProposals(
    [...interviews(board.runs, answered), ...beadInterviews(decisions.rigs, answered)],
    decisions.proposals,
  )
  const done = [...(draft.interviewed ?? [])].reverse()
  const tab = draft.interviewTab ?? 'open'
  return (
    <Box key="interview" flexDirection="column">
      <Box gap={1} marginBottom={1}>
        <Button key="iv-sweep" label="Interview me" variant="primary" onPress={() => p.act.sweep()} />
        <Text dimColor>sweeps every rig's gates, parked or stuck runs, blocked workers and bd decisions</Text>
      </Box>
      <Box gap={1} marginBottom={1}>
        {(['open', 'answered'] as const).map(t => (
          <Button
            key={`iv-tab-${t}`}
            label={`${t === 'open' ? 'questions' : 'answered'} (${t === 'open' ? open.length : done.length})`}
            plain
            variant={tab === t ? 'primary' : undefined}
            dimColor={tab !== t}
            onPress={() => p.act.draft({ interviewTab: t })}
          />
        ))}
      </Box>
      {tab === 'open' &&
        decisions.rigs
          .filter(r => r.error)
          .map(r => (
            <Text key={`iv-err-${r.rig}`} color="red">
              ! {r.rig}: {line(r.error!, 200)}
            </Text>
          ))}
      {tab === 'open' && open.length === 0 && (
        <Text dimColor>No run is stuck or waiting on your direction.</Text>
      )}
      {tab === 'open' &&
        open.map((iv, i) => {
          const typed = draft.replies?.[iv.key] ?? ''
          const run = iv.run ? board.runs.find(r => r.id === iv.run) : undefined
          return (
            <Box key={iv.key} flexDirection="column" marginBottom={1}>
              <Box gap={1}>
                {cell(p, `iv-n-${iv.key}`, `${i + 1}.`, { dimColor: true })}
                {iv.rig && cell(p, `iv-rig-${iv.key}`, iv.rig, { color: 'magenta' })}
                {iv.run && cell(p, `iv-run-${iv.key}`, iv.run, { color: 'cyan' })}
                {iv.bead && cell(p, `iv-bead-${iv.key}`, iv.bead, { color: 'cyan' })}
                {rest(
                  p,
                  `iv-kind-${iv.key}`,
                  `${iv.node ?? iv.kind} · ${iv.kind}${iv.run ? ` ${dur(p.now - iv.at)}` : ''}`,
                  { color: iv.kind === 'stuck' ? 'red' : 'blue' },
                )}
                {iv.run && (
                  <Button
                    key={`iv-open-${iv.key}`}
                    label="open run"
                    dimColor
                    onPress={() => p.act.select(iv.run!)}
                  />
                )}
              </Box>
              {iv.kind === 'gate' ? (
                run && gate(p, run, draft)
              ) : (
                <Box flexDirection="column">
                  <Text color="yellow" bold wrap="wrap">
                    ? {iv.question}
                  </Text>
                  <Text dimColor wrap="wrap">
                    {line(iv.context, 600)}
                  </Text>
                </Box>
              )}
              {iv.kind === 'prompt' &&
                (run?.pane ? (
                  <Button key={`iv-jump-${iv.key}`} label="open pane" onPress={() => p.act.jump(run.pane!)} />
                ) : null)}
              {(iv.kind === 'parked' || iv.kind === 'stuck' || iv.kind === 'bead' || iv.kind === 'owned') && (
                <Box flexDirection="column">
                  {Input && (
                    <Input
                      key={`iv-reply-${iv.key}`}
                      placeholder={
                        iv.options.length
                          ? 'pick an option, add a note, or answer in your words'
                          : 'your answer'
                      }
                      value={typed}
                      onInput={v => p.act.draft({ replies: { ...draft.replies, [iv.key]: v } })}
                      onSubmit={v => {
                        p.act.draft({ replies: { ...draft.replies, [iv.key]: v } })
                        if (v.trim()) p.act.interview(iv)
                      }}
                    />
                  )}
                  <Box gap={1}>
                    {iv.options.map((o, j) => (
                      <Button
                        key={`iv-opt-${iv.key}-${j}`}
                        label={o}
                        variant={j === 0 ? 'primary' : undefined}
                        onPress={() => p.act.interview(iv, o)}
                      />
                    ))}
                    {typed.trim() && (
                      <Button
                        key={`iv-send-${iv.key}`}
                        label="send answer"
                        onPress={() => p.act.interview(iv)}
                      />
                    )}
                    {iv.run && (
                      <Button
                        key={`iv-abort-${iv.key}`}
                        label="abort run"
                        dimColor
                        onPress={() => p.act.cli('abort', iv.run!)}
                      />
                    )}
                  </Box>
                </Box>
              )}
            </Box>
          )
        })}
      {tab === 'answered' && done.length === 0 && <Text dimColor>Nothing answered yet.</Text>}
      {tab === 'answered' &&
        done.map(d => (
          <Box key={`iv-done-${d.key}`} flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              <Text dimColor>{clockOf(d.at)}</Text>
              <Text color="magenta">{d.rig ?? ''}</Text>
              {d.run && <Text bold>{d.run}</Text>}
              {d.bead && <Text bold>{d.bead}</Text>}
              {d.node && <Text color="cyan">{d.node}</Text>}
            </Box>
            <Text wrap="wrap">? {d.question}</Text>
            <Text color="green" wrap="wrap">
              ✓ {d.answer}
            </Text>
          </Box>
        ))}
    </Box>
  )
}

/** the factory's pull requests, grouped by rig then by run: live runs first, then at most 25 ended
 * runs newest first, with "+N earlier runs" past that; merged and closed PRs stay until the run is
 * removed, drafts say so, and a PR only ever mentioned in a report or mail sits on its own dim line */
export function prsView(p: Base, runs: FactoryPrs, board: FactoryBoard) {
  const { Box, Text, Button } = p.ui
  if (!runs.length)
    return (
      <Text key="prs" dimColor>
        Asking GitHub…
      </Text>
    )
  const byRig = new Map<string, FactoryPrs>()
  for (const r of runs) {
    const key = r.rig ?? '(no rig)'
    byRig.set(key, [...(byRig.get(key) ?? []), r])
  }
  return (
    <Box key="prs" flexDirection="column">
      {[...byRig.entries()].map(([rig, rigRuns]) => {
        const live = [...rigRuns.filter(r => !r.ended)].sort((a, b) => b.at - a.at)
        const ended = [...rigRuns.filter(r => r.ended)].sort((a, b) => b.at - a.at)
        const hidden = Math.max(0, ended.length - 25)
        return (
          <Box key={`prs-${rig}`} flexDirection="column" marginBottom={1}>
            {rule(p, rig, String(rigRuns.reduce((n, r) => n + r.prs.length, 0)))}
            {[...live, ...ended.slice(0, 25)].map(r => {
              const own = r.prs.filter(pr => pr.role !== 'mentioned')
              const mentioned = r.prs.filter(pr => pr.role === 'mentioned')
              const live_ = board.runs.find(x => x.id === r.run)
              return (
                <Box key={`prs-run-${r.run}`} flexDirection="column" marginBottom={1}>
                  <Box gap={1}>
                    <Text bold>{r.run}</Text>
                    {r.bead && <Text color="cyan">{r.bead}</Text>}
                    {live_ && isLive(live_) ? (
                      <Button
                        key={`prs-open-${r.run}`}
                        label={`${live_.gate ? 'decide' : live_.node} ›`}
                        dimColor={!live_.gate}
                        variant={live_.gate ? 'primary' : undefined}
                        onPress={() => p.act.select(r.run)}
                      />
                    ) : (
                      <Text dimColor>run ended</Text>
                    )}
                    {r.error && rest(p, `prs-err-${r.run}`, `! ${line(r.error, 120)}`, { color: 'red' })}
                  </Box>
                  {own.length === 0 && <Text dimColor>no pull requests seen</Text>}
                  {own.map(pr => {
                    const state = prState(pr)
                    return (
                      <Box key={`pr-${r.run}-${pr.repo}-${pr.number}`} gap={1}>
                        {cell(p, `pr-n-${r.run}-${pr.repo}-${pr.number}`, prName(pr), {
                          color: 'cyan',
                        })}
                        {cell(
                          p,
                          `pr-state-${r.run}-${pr.repo}-${pr.number}`,
                          `${state.word}${state.checks}`,
                          { color: state.color },
                        )}
                        {cell(p, `pr-role-${r.run}-${pr.repo}-${pr.number}`, pr.role, { dimColor: true })}
                        {rest(p, `pr-title-${r.run}-${pr.repo}-${pr.number}`, pr.title)}
                      </Box>
                    )
                  })}
                  {mentioned.length > 0 && (
                    <Text dimColor wrap="truncate-end">
                      also named: {mentioned.map(prName).join(', ')}
                    </Text>
                  )}
                </Box>
              )
            })}
            {hidden > 0 && <Text dimColor>+{hidden} earlier runs</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

export function footer(p: Base) {
  const { Text } = p.ui
  return <Text dimColor>1-6 views · tab between controls · enter presses · esc back to the prompt</Text>
}

/** the band above the prompt while the console is closed: counts, and the first gate answerable in place */
export function band(p: Base, board: FactoryBoard, draft: FactoryDraft) {
  const { Box, Text, Button } = p.ui
  const live = board.runs.filter(isLive)
  const first = live.find(r => r.gate)
  const n = counts(board.runs)
  return (
    <Box key="band" flexDirection="column">
      <Box gap={1}>
        <Text bold color="magenta">
          ◆
        </Text>
        <Text color="green">{String(n.working)} working</Text>
        {n.gates > 0 && <Text color="yellow">· {String(n.gates)} awaiting you</Text>}
        {n.stuck > 0 && <Text color="red">· {String(n.stuck)} stuck</Text>}
        {n.waiting > 0 && <Text color="blue">· {String(n.waiting)} waiting</Text>}
        <Text dimColor>·</Text>
        <Button key="band-open" label="open console" dimColor onPress={() => p.act.show('board')} />
      </Box>
      {first && (
        <Box gap={1}>
          <Text color="yellow" wrap="truncate-end">
            ? {first.id}: {line(first.gate!.question, Math.max(20, p.width - 40))}
          </Text>
          {first.gate!.outcomes.map(o => (
            <Button key={`band-${first.id}-${o}`} label={o} onPress={() => p.act.decide(first.id, o)} />
          ))}
        </Box>
      )}
    </Box>
  )
}
