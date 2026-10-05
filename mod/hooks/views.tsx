// The factory console's views. Presentational: register.tsx owns `$`, the data and the actions,
// and hands each view the surface's elements, its data and the actions as closures.
import type { Elements } from 'claude-code'

import type {
  FactoryBacklog,
  FactoryBead,
  FactoryBoard,
  FactoryDetail,
  FactoryDraft,
  FactoryEdge,
  FactoryRun,
  FactoryView,
} from '../types'
import { bar, clockOf, dur, line, sparkline, track } from './view'

/** what every surface the console draws on has; mobile has no Input or Select */
export type UI = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Code'> &
  Partial<Pick<Elements['desktop'], 'Input' | 'Select'>>

export type Actions = {
  /** runs a factory CLI command, toasts its answer and ticks */
  cli: (...args: string[]) => void
  show: (view: FactoryView, run?: string) => void
  draft: (patch: Partial<FactoryDraft>) => void
  decide: (run: string, outcome: string) => void
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
        {live.length === 0 && <Text dimColor>idle</Text>}
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
  const over = board.runs.filter(r => !isLive(r))
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
      {over.length > 0 && rule(p, 'Finished', String(over.length))}
      {over.map(r => (
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
      <Text wrap="wrap">{d.run.goal}</Text>
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

export function mailView(p: Base, board: FactoryBoard) {
  const { Box, Text, Button } = p.ui
  const mail = [...board.mail].reverse()
  return (
    <Box key="mail" flexDirection="column">
      {mail.length === 0 && <Text dimColor>No mail for the manager yet.</Text>}
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
  return <Text dimColor>1-5 views · tab between controls · enter presses · esc back to the prompt</Text>
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
