// The manager session: ticks every factory run, draws the board, and hands
// manager mail to this session's model. All state lives with the factory CLI
// (../bin/factory); this module only drives and shows it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FactoryBoard, FactoryMail, FactoryRun } from '../types'

const PANE = 'factory'
const TICK_MS = 5000
const board = atom({ plugin: 'factory', key: 'board' } as const, { runs: [], mail: [] } as FactoryBoard)
const isLive = (r: FactoryRun) => r.node !== undefined && r.node !== 'done' && r.node !== 'aborted'

const manual = (cli: string) => `## Software factory manager
This session is the manager of herdr software factories. Each run is an xstate machine over a graph of stations; every station is worked by its own Claude session in a herdr tab of the run's git worktree, and the outcome it reports routes the run along the graph. Messages starting "[factory]" come from that runtime: a stuck station, a worker's question, a gate awaiting a decision, a finished run.
Quarterback with the factory CLI through Bash:
- \`${cli} status [run]\`: every run, or one run's full journal
- \`${cli} mail <run> <station> "<text>"\`: answer or steer a worker (delivered into its session)
- \`${cli} retry <run>\` (a stuck station), \`${cli} goto <run> <station|done>\` (also skips a timed wait), \`${cli} abort <run>\`, \`${cli} fork <run> <station> "<note>"\`, \`${cli} rm <run>\` (finished runs)
- \`${cli} start <factory>[@station] <repo> "<goal>"\`: factories are files in ${cli.replace(/bin\/factory$/, 'factories/')}; lifecycle covers build, release, incidents, optimization, refactoring and the monitor, maintain and improve sweeps
- \`herdr pane read <pane> --source recent --lines 80\`: see what a worker is doing
Gates are the person's decisions, never yours: when a gate awaits, show them the question and the evidence, and run \`${cli} decide <run> <outcome> "<note>"\` only with the outcome they chose (they confirm it again in a dialog). Answer worker questions yourself when the goal settles them; ask the person when it does not. Never approve a worker's permission prompt for them.`

// runtime handles only: a hot reload starts them over, which ensureTicking allows for
const rt = {
  cli: '',
  timer: undefined as { cancel: () => void } | undefined,
  isTicking: false,
  isAutopilot: true,
  agents: new Map<string, string | null | undefined>(),
}

async function factory($: EngineInterface, args: string[]) {
  const r = await $.process.run([rt.cli, ...args], { timeoutMs: 120_000 })
  return { isOk: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() }
}

async function tick($: EngineInterface) {
  if (rt.isTicking) return
  rt.isTicking = true
  try {
    const { isOk, out } = await factory($, ['tick'])
    if (!isOk) return $.ui.status(`factory: ${out.split('\n')[0]?.slice(0, 80)}`)
    const res = JSON.parse(out) as { busy?: true; runs: FactoryRun[]; manager: FactoryMail[] }
    if (res.busy) return
    await update($, board, b => ({ runs: res.runs, mail: [...b.mail, ...res.manager].slice(-20) }))

    const live = res.runs.filter(isLive)
    const stuck = live.filter(r => r.sub === 'stuck').length
    const gates = live.filter(r => r.gate).length
    const notes = [stuck && `${stuck} stuck`, gates && `${gates} awaiting you`].filter(Boolean)
    $.ui.status(live.length ? `factory: ${[`${live.length} running`, ...notes].join(', ')}` : undefined)
    for (const r of res.runs) {
      if (r.agent === 'blocked' && rt.agents.get(r.id) !== 'blocked')
        $.ui.toast(`factory: ${r.id} ${r.node} worker is waiting on a prompt in pane ${r.pane}`)
      rt.agents.set(r.id, r.agent)
    }

    if (res.manager.length) {
      const lines = res.manager.map(m => `- ${m.run} / ${m.from}: ${m.text}`)
      $.ui.toast(`factory: ${res.manager.length} message(s) for the manager`)
      // not awaited: it resolves only once the session is idle and the turn starts
      if (rt.isAutopilot)
        void $.prompt.submit({ text: `[factory] mail for the manager:\n${lines.join('\n')}` }).catch(() => {})
    }
  } catch (err) {
    $.ui.status(`factory: ${String(err).slice(0, 80)}`)
  } finally {
    rt.isTicking = false
  }
}

async function ensureTicking($: EngineInterface) {
  if (rt.timer) return
  const root = await $.fs.stat($.plugin.root, { resolve: true })
  rt.cli = `${root.realPath ?? $.plugin.root}/../bin/factory`
  rt.timer = $.clock.every(TICK_MS, () => void tick($))
  void tick($)
}

async function act($: EngineInterface, ...args: string[]) {
  const { out } = await factory($, args)
  $.ui.toast(out || `${args.join(' ')}: queued`)
  await tick($)
}

export const register: Register = (on, options) => {
  rt.isAutopilot = options.autopilot !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'factory',
      description:
        'Factory dashboard; or a factory command (start, status, decide, mail, retry, goto, fork, abort, rm)',
      argumentHint: '[start|status|decide|mail|retry|goto|fork|abort|rm ...]',
    })
    await ensureTicking($)
    return next(e)
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    await ensureTicking($) // a hot reload drops the timer
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    if (!args.length) {
      await $.ui.open({ id: PANE, title: 'Factory' })
      return { text: 'Factory pane opened.' }
    }
    const { out } = await factory($, args)
    void tick($)
    return { text: out || 'ok' }
  })

  // a gate is the person's call: the model may run decide only after they confirm it here
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!/\bfactory\s+decide\b/.test(e.command)) return next(e)
    const question = `The manager model wants to decide a factory gate: ${e.command.slice(0, 300)}. Allow it?`
    const answer = await $.ui.ask(question, ['Allow', 'Deny']).catch(() => 'Deny')
    return answer === 'Allow'
      ? next(e)
      : { deny: 'The person did not confirm this gate decision. Ask them which outcome they want.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!rt.cli) return composed
    return {
      sections: [...composed.sections, { id: 'factory:manager', text: manual(rt.cli), scope: 'session' }],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { runs, mail } = await read($, board)

    return (
      <Box flexDirection="column">
        {runs.length === 0 && <Text dimColor>No runs. /factory start lifecycle {'<repo> <goal>'}</Text>}
        {runs.map(r => (
          <Box key={r.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text
                bold
                color={r.sub === 'stuck' || r.error ? 'red' : isLive(r) ? 'green' : undefined}
                dimColor={!isLive(r)}
              >
                {r.id}
              </Text>
              <Text>
                {'  '}
                {r.sub ? `${r.node} › ${r.sub}` : r.node}
                {r.attempt ? `  try ${r.attempt}/${r.attempts}` : ''}
              </Text>
              <Text dimColor>{r.pane || r.agent ? `  ${r.pane ?? ''} ${r.agent ?? ''}` : ''} </Text>
              {r.sub === 'stuck' && (
                <Button key={`retry-${r.id}`} label="retry" onPress={() => act($, 'retry', r.id)} />
              )}
              {isLive(r) && (
                <Button key={`abort-${r.id}`} label="abort" dimColor onPress={() => act($, 'abort', r.id)} />
              )}
            </Box>
            {r.goal && (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {r.goal}
              </Text>
            )}
            {r.gate && (
              <Box flexDirection="column">
                <Text color="yellow">
                  {'  ? '}
                  {r.gate.question}
                </Text>
                <Box>
                  <Text>{'    '}</Text>
                  {r.gate.outcomes.map((outcome, i) => (
                    <Button
                      key={`${r.id}-${outcome}`}
                      label={outcome}
                      variant={i === 0 ? 'primary' : undefined}
                      onPress={() => act($, 'decide', r.id, outcome)}
                    />
                  ))}
                </Box>
              </Box>
            )}
            {r.error && (
              <Text color="red" wrap="truncate-end">
                {'  ! '}
                {r.error}
              </Text>
            )}
            {r.last && (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {r.last.node} {r.last.outcome}: {r.last.summary.replace(/\s+/g, ' ')}
              </Text>
            )}
          </Box>
        ))}
        {mail.length > 0 && <Text bold>Manager mail</Text>}
        {mail.slice(-5).map(m => (
          <Text key={`${m.run}-${m.at}`} wrap="truncate-end">
            {m.run} / {m.from}: {m.text.replace(/\s+/g, ' ')}
          </Text>
        ))}
      </Box>
    )
  })
}
