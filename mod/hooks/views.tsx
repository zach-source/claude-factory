// The factory console's views. Presentational: register.tsx owns `$`, the data and the actions,
// and hands each view the surface's elements, its data and the actions as closures.
import type { Elements } from 'claude-code'

import type {
  FactoryBacklog,
  FactoryPrs,
  FactoryBead,
  FactoryBoard,
  FactoryDetail,
  FactoryDraft,
  FactoryEdge,
  FactoryMail,
  FactoryRun,
  FactoryView,
} from '../types'
import { bar, clockOf, dur, line, mailKey, mailTabs, prNeed, rigStats, sparkline, track } from './view'

/** what every surface the console draws on has; mobile has no Input or Select */
export type UI = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Code'> &
  Partial<Pick<Elements['desktop'], 'Input' | 'Select'>>

export type Actions = {
  /** runs a factory CLI command, toasts its answer and ticks */
  cli: (...args: string[]) => void
  show: (view: FactoryView, run?: string) => void
  draft: (patch: Partial<FactoryDraft>) => void
  decide: (run: string, outcome: string) => void
  /** the person's quick answer to a worker's mail: approve, reject, or what they typed */
  answer: (m: FactoryMail, kind: 'approve' | 'reject' | 'reply') => void
  start: () => void
  jump: (pane: string) => void
}

type Base = { ui: UI; act: Actions; width: number; now: number }

export const isLive = (r: FactoryRun) => !!r.node && r.node !== 'done' && r.node !== 'aborted'

/** one phrase and one color for where a run stands */
export function standing(r: FactoryRun, now: number) {
  if (!r.node) return { word: 'error', color: 'red' }
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

/** gates and trouble first, then work in flight, then what waits on a timer */
const urgency = (r: FactoryRun) =>
  r.gate ? 0 : r.sub === 'stuck' || r.agent === 'blocked' ? 1 : r.sub === 'waiting' ? 3 : 2

/** an absolute path cut to its last two parts; a repo's own `.factory/x.ts at sha` stays whole */
const shortPath = (path: string) => (path.startsWith('/') ? `…/${path.split('/').slice(-2).join('/')}` : path)

const edgeText = (e: FactoryEdge) =>
  `${e.outcome} → ${e.to}${e.delayMin ? ` after ${dur(e.delayMin * 60_000)}` : ''}${e.defer ? ' (deferred)' : ''}`

const TABS: [FactoryView, string, string][] = [
  ['board', 'Board', '1'],
  ['run', 'Run', '2'],
  ['backlog', 'Backlog', '3'],
  ['mail', 'Mail', '4'],
  ['new', 'New run', '5'],
  ['rigs', 'Rigs', '6'],
  ['prs', 'PRs', '7'],
]

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
  const count = (f: (r: FactoryRun) => boolean) => live.filter(f).length
  const gates = count(r => !!r.gate)
  const stuck = count(r => r.sub === 'stuck' || r.agent === 'blocked')
  const waiting = count(r => r.sub === 'waiting')
  const working = live.length - gates - stuck - waiting
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

function card(p: Base, r: FactoryRun, draft: FactoryDraft) {
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
        <Text color={s.color}>
          {r.node} · {s.word}
          {tries}
          {timer}
        </Text>
      </Box>
      {r.goal && <Text wrap="truncate-end">{line(r.goal, 300)}</Text>}
      {trail(p, r)}
      {r.last && (
        <Text dimColor wrap="truncate-end">
          └ {r.last.node} {r.last.outcome}: {line(r.last.summary, 300)}
        </Text>
      )}
      {r.error && (
        <Text color="red" wrap="truncate-end">
          ! {line(r.error, 300)}
        </Text>
      )}
      {r.gate && gate(p, r, draft)}
      <Box gap={1}>
        <Button key={`open-${r.id}`} label="open" onPress={() => p.act.show('run', r.id)} />
        {r.pane && (
          <Button key={`jump-${r.id}`} label="jump to worker" dimColor onPress={() => p.act.jump(r.pane!)} />
        )}
        {r.sub === 'stuck' && (
          <Button
            key={`retry-${r.id}`}
            label="retry"
            variant="primary"
            onPress={() => p.act.cli('retry', r.id)}
          />
        )}
        <Button key={`abort-${r.id}`} label="abort" dimColor onPress={() => p.act.cli('abort', r.id)} />
      </Box>
    </Box>
  )
}

export function boardView(p: Base, board: FactoryBoard, draft: FactoryDraft) {
  const { Box, Text, Button } = p.ui
  const live = board.runs.filter(isLive).sort((a, b) => urgency(a) - urgency(b))
  // newest first; the rest stay until `factory rm`
  const over = board.runs.filter(r => !isLive(r)).sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0))
  if (!board.runs.length)
    return (
      <Box key="board" flexDirection="column">
        <Text dimColor>No runs yet.</Text>
        <Text dimColor>5 starts one; 3 shows the backlog each rig feeds.</Text>
      </Box>
    )
  return (
    <Box key="board" flexDirection="column">
      {live.map(r => card(p, r, draft))}
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
      {(draft.isFinishedShown ? over.slice(0, 10) : []).map(r => (
        <Box key={`over-${r.id}`} gap={1}>
          <Text color={standing(r, p.now).color}>{r.node === 'done' ? '✓' : r.node ? '✗' : '!'}</Text>
          <Text bold>{r.id}</Text>
          <Text dimColor wrap="truncate-end">
            {r.error
              ? line(r.error, 120)
              : r.last
                ? `${r.last.node} ${r.last.outcome}: ${line(r.last.summary, 120)}`
                : ''}
          </Text>
          <Button key={`view-${r.id}`} label="open" dimColor onPress={() => p.act.show('run', r.id)} />
          <Button key={`rm-${r.id}`} label="remove" dimColor onPress={() => p.act.cli('rm', r.id)} />
        </Box>
      ))}
    </Box>
  )
}

export function runView(p: Base, d: FactoryDetail | null, peek: string, draft: FactoryDraft) {
  const { Box, Text, Button, Code, Input, Select } = p.ui
  if (!d)
    return (
      <Box key="run" flexDirection="column">
        <Text dimColor>No run open: press open on a card in the board (1).</Text>
      </Box>
    )
  const s = standing(d, p.now)
  const here = d.stations.find(x => x.id === d.node)
  const tasks = d.tasks ?? []
  const closed = tasks.filter(t => t.status === 'closed').length
  const stations = d.stations.map(x => ({ value: x.id, label: x.gate ? `${x.id} (gate)` : x.id }))
  const target = draft.target || d.node || d.start
  return (
    <Box key="run" flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{d.id}</Text>
          <Text color="cyan">{d.bead ? `  ${d.bead}` : ''}</Text>
        </Text>
        <Text color={s.color}>
          {d.node} · {s.word}
          {d.attempt && d.attempt > 1 ? ` · try ${d.attempt}/${d.attempts}` : ''}
        </Text>
      </Box>
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
        <Button key="back" label="back" hotkey="b" dimColor onPress={() => p.act.show('board')} />
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

      {rule(p, 'Worker', d.pane ? `${d.pane} · ${s.word}` : d.isWorking ? 'starting' : 'none now')}
      {peek ? <Code source={peek} wrap="truncate-end" /> : <Text dimColor>No worker output to show.</Text>}
    </Box>
  )
}

function beadRow(p: Base, repo: { repo: string; factory: string }, b: FactoryBead, isQueued: boolean) {
  const { Box, Text, Button } = p.ui
  return (
    <Box key={`bead-${b.id}`} gap={1}>
      <Text
        color={b.priority !== undefined && b.priority <= 1 ? 'red' : undefined}
        dimColor={(b.priority ?? 2) > 1}
      >
        P{String(b.priority ?? 2)}
      </Text>
      <Text color="cyan">{b.id}</Text>
      <Box flexGrow={1}>
        <Text wrap="truncate-end">
          {b.title}
          <Text dimColor>{b.type ? `  ${b.type}` : ''}</Text>
        </Text>
      </Box>
      {!isQueued && (
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

export function backlogView(p: Base, backlog: FactoryBacklog) {
  const { Box, Text } = p.ui
  if (!backlog.length)
    return (
      <Box key="backlog" flexDirection="column">
        <Text dimColor>
          No rigs. `factory rig add {'<name> <repo>'}` turns a repo's beads labeled factory into runs.
        </Text>
      </Box>
    )
  return (
    <Box key="backlog" flexDirection="column">
      {backlog.map(r => (
        <Box key={`rig-${r.name}`} flexDirection="column" marginBottom={1}>
          {rule(
            p,
            r.name,
            `${shortPath(r.repo)} · ${shortPath(r.factory)} · busy ${r.busy}${r.maxRuns ? `/${r.maxRuns}` : ''}`,
          )}
          {r.goal && <Text wrap="wrap">◎ {r.goal}</Text>}
          {r.error && <Text color="red">! {r.error}</Text>}
          <Text color="green">will start ({String(r.queued.length)})</Text>
          {r.queued.length === 0 && <Text dimColor> nothing queued</Text>}
          {r.queued.map(b => beadRow(p, r, b, true))}
          <Text color="yellow">waiting for you to queue ({String(r.unqueued.length)})</Text>
          {r.unqueued.slice(0, 15).map(b => beadRow(p, r, b, false))}
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
              <Button key={`rigs-backlog-${g.name}`} label="backlog" onPress={() => p.act.show('backlog')} />
              <Button
                key={`rigs-new-${g.name}`}
                label="new run here"
                dimColor
                onPress={() => {
                  p.act.draft({ repo: g.name })
                  p.act.show('new')
                }}
              />
            </Box>
          </Box>
        )
      })}
      {loose.length > 0 && rule(p, 'outside any rig', String(loose.length))}
      {loose.map(r => (
        <Box key={`rigs-loose-${r.id}`} gap={1}>
          <Text bold>{r.id}</Text>
          <Text color={standing(r, p.now).color}>{r.node}</Text>
          <Button key={`rigs-open-${r.id}`} label="open" dimColor onPress={() => p.act.show('run', r.id)} />
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
            <Text dimColor>{clockOf(m.at)}</Text>
            <Text bold>{m.run}</Text>
            <Text color="cyan">{m.from}</Text>
            <Button
              key={`mail-open-${m.run}-${m.at}`}
              label="open run"
              dimColor
              onPress={() => p.act.show('run', m.run)}
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

/** the factory's open pull requests by rig, each with what it waits on and where its run stands */
export function prsView(p: Base, rigs: FactoryPrs, board: FactoryBoard) {
  const { Box, Text, Button } = p.ui
  if (!rigs.length)
    return (
      <Text key="prs" dimColor>
        Asking GitHub…
      </Text>
    )
  return (
    <Box key="prs" flexDirection="column">
      {rigs.map(rig => (
        <Box key={`prs-${rig.rig}`} flexDirection="column" marginBottom={1}>
          {rule(p, rig.rig, String(rig.prs.length))}
          {rig.error && <Text color="red">! {line(rig.error, 200)}</Text>}
          {!rig.error && rig.prs.length === 0 && <Text dimColor>no open pull requests from runs</Text>}
          {rig.prs.map(pr => {
            const need = prNeed(pr)
            const r = board.runs.find(x => x.id === pr.run)
            return (
              <Box key={`pr-${rig.rig}-${pr.number}`} flexDirection="column">
                <Box gap={1}>
                  <Text bold>#{String(pr.number)}</Text>
                  <Text color={need.color}>{need.word}</Text>
                  <Text wrap="truncate-end">{pr.title}</Text>
                </Box>
                <Box gap={1}>
                  <Text dimColor>{pr.url}</Text>
                  {r && isLive(r) ? (
                    <Button
                      key={`pr-open-${pr.run}`}
                      label={`${r.gate ? 'decide' : r.node} ›`}
                      dimColor={!r.gate}
                      variant={r.gate ? 'primary' : undefined}
                      onPress={() => p.act.show('run', r.id)}
                    />
                  ) : (
                    <Text dimColor>run {r ? 'ended' : 'removed'}</Text>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

export function newView(p: Base, draft: FactoryDraft, cwd: string) {
  const { Box, Text, Button, Input } = p.ui
  if (!Input)
    return (
      <Box key="new" flexDirection="column">
        <Text dimColor>Start runs from a terminal or desktop session.</Text>
      </Box>
    )
  return (
    <Box key="new" flexDirection="column" gap={1}>
      <Input
        key="new-repo"
        label="rig or repo"
        placeholder={cwd}
        value={draft.repo}
        onInput={v => p.act.draft({ repo: v })}
        onSubmit={v => p.act.draft({ repo: v })}
      />
      <Input
        key="new-factory"
        label="factory"
        placeholder="lifecycle (or lifecycle@station)"
        value={draft.factory}
        onInput={v => p.act.draft({ factory: v })}
        onSubmit={v => p.act.draft({ factory: v })}
      />
      <Input
        key="new-goal"
        label="goal"
        placeholder="what to build, fix or improve; or a bead id"
        value={draft.goal}
        onInput={v => p.act.draft({ goal: v })}
        onSubmit={v => {
          p.act.draft({ goal: v })
          p.act.start()
        }}
      />
      <Box gap={1}>
        <Button key="new-start" label="start run" variant="primary" onPress={() => p.act.start()} />
        <Text dimColor>a run gets its own worktree, branch and bead</Text>
      </Box>
    </Box>
  )
}

export function footer(p: Base) {
  const { Text } = p.ui
  return <Text dimColor>1-7 views · tab between controls · enter presses · esc back to the prompt</Text>
}

/** the band above the prompt while the console is closed: counts, and the first gate answerable in place */
export function band(p: Base, board: FactoryBoard, draft: FactoryDraft) {
  const { Box, Text, Button } = p.ui
  const live = board.runs.filter(isLive)
  const first = live.find(r => r.gate)
  const stuck = live.filter(r => r.sub === 'stuck' || r.agent === 'blocked').length
  return (
    <Box key="band" flexDirection="column">
      <Box gap={1}>
        <Text bold color="magenta">
          ◆
        </Text>
        <Text>
          {String(live.length)} run{live.length === 1 ? '' : 's'}
        </Text>
        {first && <Text color="yellow">· {String(live.filter(r => r.gate).length)} awaiting you</Text>}
        {stuck > 0 && <Text color="red">· {String(stuck)} stuck</Text>}
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
