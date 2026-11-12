// The factory view and control panel for the Herdr app (claude-factory-s01d.3), a client of the core.
// The mod never ticks, patrols or takes the manager lease (claude-factory-hpmc.10). It reads one
// `factory snapshot` per beat and runs one factory command per button.
// With "machine" in config.json (claude-factory-hpmc.14) the manager runs there, such as the AX task f-manager.
// Then every exec and file read passes on: machine.
//
// Props { band: true } draw a status band of one line.
// Props { dialog: "interview" } draw the Interview dialog.
// `factory herdr install` writes config.json next to this file: { cli, home, machine? } or, in server mode
// (claude-factory-gogxc.15), { server, cert, key, ca }: each call is one HTTPS call to /v1 by curl.

import { View, div, PathBuilder } from 'gpui-kit'
import { v_flex, h_flex } from 'gpui-base'
import {
  appHome,
  closeOverlay,
  exec,
  nextCommand,
  notify,
  openOverlay,
  props,
  run,
  readTextFile,
  setShared,
  settings,
  shared,
  theme,
} from 'herdr'
import {
  agentsOf,
  headerText,
  answerArgs,
  board,
  interviewItems,
  parseSnapshot,
  line,
  newlyBlocked,
  parseConfig,
  shortId,
  actionWords,
  snapshotWords,
  serverCall,
  snapshotPath,
  actionReq,
  answerReq,
  screenPath,
  GET_CACHE_MS,
  BOARD_MAX_AGE,
  FIRST_MAX_AGE,
  DECISIONS_MS,
  chatArgv,
  chatLabel,
  directJob,
  onOf,
  FLOW_FACTORIES,
  FLOW_LENSES,
  FLOW_WINDOWS,
  flowJobWords,
  flowLayout,
  parseContext,
  parseFlows,
  recentMovers,
} from './view.js'

const TICK_MS = 5_000
/** a call with no answer for this long is free again */
const JOB_LIMIT_MS = 5 * 60_000

const configPath = () => `${appHome()}/mods/factory/config.json`

export default class Factory extends View {
  init(_props, cx) {
    this.cfg = null
    this.getCache = {} // GET path -> { at, r }
    this.jobs = {} // name -> { at, result? }
    this.selected = null
    this.screen = ''
    this.before = {}
    this.tab = 'board' // 'board' | 'flow'
    this.lens = 'live'
    this.flowWindow = '24h'
    this.flowFactory = 'lifecycle'
    this.flow = null // { graph } | { error }
    this.flowCache = {} // 'factory/window' -> { graph }: the last good graph, shown while a new one loads
    this.decisionsAt = 0
    this.beats = 0
    const p = props() ?? {}
    if (p.band || p.dialog) return // only the panel copy polls
    cx.spawn(async cx => {
      const text = await readTextFile(configPath()) // the config is on this machine
      this.cfg = parseConfig(text) // null for a missing or bad file
      cx.notify()
      if (!this.cfg) return
      cx.timer.every(TICK_MS, cx => this.beat(cx))
      this.beat(cx)
    })
    // "factory.interview" (a key in keys.json, or herdr-app do) opens the Interview dialog
    cx.spawn(async cx => {
      for (;;) {
        if ((await nextCommand()) === 'interview') this.openInterview()
        cx.notify()
      }
    })
  }

  openInterview() {
    openOverlay({ mod: 'factory', props: { dialog: 'interview' }, kind: 'dialog', width: 620, height: 480 })
  }

  /** starts a factory command, unless one with that name is in flight. It runs direct, in the foreground. */
  start(name, words, req) {
    const job = this.jobs[name]
    if (job && Date.now() - job.at < JOB_LIMIT_MS) return
    if (this.cfg.server && !req) return // no /v1 route for this call (the Flow tab)
    const mine = (this.jobs[name] = { at: Date.now() })
    const [cmd, args] = req ? serverCall(this.cfg, ...req) : directJob(this.cfg, words)
    // a GET answer is cached for a short time; calls in flight run side by side
    const hit = req?.[0] === 'GET' && this.getCache[req[1]]
    ;(hit && Date.now() - hit.at < GET_CACHE_MS
      ? Promise.resolve(hit.r)
      : exec(cmd, args, onOf(this.cfg)).then(r => {
          if (req?.[0] === 'GET' && r.code === 0) this.getCache[req[1]] = { at: Date.now(), r }
          return r
        })
    )
      .then(r => (mine.result = { code: r.code, out: r.stdout, err: r.stderr }))
      .catch(e => (mine.result = { code: 1, out: '', err: String(e) }))
  }

  /** the result of a finished call, or null while it runs */
  finished(name) {
    const job = this.jobs[name]
    if (!job?.result) return null
    delete this.jobs[name]
    return job.result
  }

  beat(cx) {
    cx.spawn(async cx => {
      const r = this.finished('snapshot')
      if (r) {
        const s = parseSnapshot(r.code, r.out, r.err)
        this.onTick(s.tick)
        if (s.decisions) setShared('factory.decisions', s.decisions) // server mode: one call holds both views
      }
      const d = this.finished('decisions')
      if (d) {
        const s = parseSnapshot(d.code, d.out, d.err)
        if (s.decisions) setShared('factory.decisions', s.decisions)
      }
      const ctxJob = this.finished('context')
      if (ctxJob) setShared('factory.context', parseContext(ctxJob.code, ctxJob.out))
      const fl = this.finished('flows')
      if (fl) {
        this.flow = parseFlows(fl.code, fl.out, fl.err)
        if (this.flow.graph) this.flowCache[this.flowKey()] = this.flow
      }
      // the Flow tab asks for the graph while it is shown
      if (this.tab === 'flow') this.start('flows', flowJobWords(this.flowFactory, this.flowWindow))
      // the first beat takes any cached board; later beats take one at most BOARD_MAX_AGE old
      // the manager's model and context use: one read of its transcript, so each turn shows by the next beat
      const age = this.beats++ ? BOARD_MAX_AGE : FIRST_MAX_AGE
      if (this.cfg.server) {
        this.start('context', null, ['GET', '/v1/manager/context'])
        this.start('snapshot', null, ['GET', snapshotPath(age)])
        return cx.notify()
      }
      this.start('context', snapshotWords('manager.context', BOARD_MAX_AGE))
      this.start('snapshot', snapshotWords('board', age))
      if (Date.now() - this.decisionsAt >= DECISIONS_MS && !this.jobs.decisions) {
        this.decisionsAt = Date.now()
        this.start('decisions', snapshotWords('decisions', this.beats > 1 ? DECISIONS_MS : FIRST_MAX_AGE))
      }
      cx.notify()
    })
  }

  flowKey() {
    return `${this.flowFactory}/${this.flowWindow}`
  }

  onTick(res) {
    const prev = shared('factory') ?? {}
    if (res.error) {
      setShared('factory', { ...prev, error: res.error, staleSince: prev.staleSince ?? Date.now() })
      return
    }
    for (const r of newlyBlocked(res.runs, this.before))
      notify({
        title: `factory: ${r.id}`,
        body: `its ${r.node} worker waits on a prompt in pane ${r.pane}`,
        level: 'warning',
      })
    this.before = agentsOf(res.runs)
    setShared('factory', {
      runs: res.runs,
      halt: res.halt,
      lease: res.lease,
      managerLimited: res.managerLimited ?? null,
      managerCodexAuth: res.managerCodexAuth ?? null,
      at: Date.now(),
    })
  }

  select(r, cx) {
    this.selected = r.id
    this.screen = ''
    cx.notify()
    if (!r.pane) return
    if (this.cfg?.server) {
      const [cmd, args] = serverCall(this.cfg, 'GET', screenPath(r.id))
      cx.spawn(async cx => {
        const p = await exec(cmd, args).catch(() => null)
        this.screen = (p && (p.stdout || p.stderr).trimEnd()) || 'no worker screen' // the pod text as it is
        cx.notify()
      })
      return
    }
    if (this.cfg?.machine) {
      this.screen = 'worker screens are not in remote mode yet (claude-factory-hpmc.10)'
      return
    }
    cx.spawn(async cx => {
      const p = await exec('herdr', [
        'pane',
        'read',
        r.pane,
        '--source',
        'recent-unwrapped',
        '--lines',
        '14',
      ]).catch(() => null)
      this.screen = p && p.code === 0 ? p.stdout.trimEnd() : 'no worker screen'
      cx.notify()
    })
  }

  render(cx) {
    const p = props() ?? {}
    if (p.dialog === 'interview') return this.interview()
    const t = theme()
    const state = shared('factory') ?? {}
    const runs = state.runs ?? []
    const head = headerText(state, shared('factory.context'))
    if (p.band)
      return h_flex()
        .size_full()
        .px(10)
        .items_center()
        .bg(t.chrome)
        .text_size(12)
        .text_color(state.error ? t.blocked : t.muted)
        .child(div().truncate().child(`factory · ${head}`))
    if (!this.cfg)
      return v_flex()
        .size_full()
        .p(14)
        .bg(t.surface)
        .text_size(13)
        .text_color(t.muted)
        .child('No factory config. Run: factory herdr install')
    const items = interviewItems(runs, shared('factory.decisions'))
    const button = (id, label, onClick) =>
      h_flex()
        .id(id)
        .h(26)
        .px(10)
        .items_center()
        .rounded(6)
        .bg(t.raised)
        .text_color(t.foreground)
        .cursor_pointer()
        .hover(s => s.bg(t.hover))
        .on_click(onClick)
        .child(label)
    const color = { gates: t.blocked, stuck: t.blocked, working: t.working, waiting: t.idle }
    const rows = board(runs).flatMap(g => [
      div().pt(8).text_size(11).font_semibold().text_color(t.dim).child(g.rig),
      ...g.states.flatMap(s =>
        s.runs.map(r =>
          h_flex()
            .id(`run-${r.id}`)
            .gap(8)
            .px(6)
            .py(3)
            .rounded(6)
            .cursor_pointer()
            .when(this.selected === r.id, el => el.bg(t.selected))
            .hover(el => el.bg(t.hover))
            .on_click((_e, cx) => this.select(r, cx))
            .child(div().w(8).h(8).rounded_full().bg(color[s.state]))
            .child(div().w(80).text_color(t.foreground).child(shortId(r.id)))
            .child(
              div()
                .w(110)
                .truncate()
                .text_color(t.muted)
                .child(`${r.node}/${r.sub ?? ''}`),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_color(t.dim)
                .child(line(r.goal ?? '', 120)),
            ),
        ),
      ),
    ])
    return (
      v_flex()
        .id('root')
        .size_full()
        .p(10)
        .gap(6)
        .bg(t.surface)
        .text_size(12)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().text_size(14).font_semibold().text_color(t.foreground).child('Factory'))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_color(state.error ? t.blocked : t.muted)
                .child(head),
            ),
        )
        // the buttons wrap to a new line when the panel is narrow, so none is cut off
        .child(
          h_flex()
            .gap(6)
            .flex_wrap()
            .child(button('interview', `Interview (${items.length})`, () => this.openInterview()))
            .children(this.controls(button)),
        )
        .child(this.tabs(t))
        .child(
          this.tab === 'flow'
            ? this.flowTab(t)
            : v_flex()
                .flex_1()
                .min_h(0)
                .overflow_y_scrollbar()
                .children(rows.length ? rows : [div().text_color(t.dim).child('Nothing runs.')]),
        )
        .when(!!this.selected, el =>
          el.child(
            div()
              .h(220)
              .p(8)
              .rounded(6)
              .bg(t.background)
              .overflow_y_scrollbar()
              .font_family(settings().font_family ?? 'JetBrains Mono')
              .text_size(11)
              .text_color(t.foreground)
              .child(this.screen || 'reading the worker screen…'),
          ),
        )
    )
  }

  /** a row of small text buttons; the picked one is marked */
  picker(t, id, names, picked, pick) {
    return h_flex()
      .gap(4)
      .children(
        names.map(n =>
          div()
            .id(`${id}-${n}`)
            .px(8)
            .py(2)
            .rounded(6)
            .cursor_pointer()
            .text_color(n === picked ? t.foreground : t.dim)
            .bg(n === picked ? t.selected : t.surface)
            .hover(s => s.bg(t.hover))
            .on_click((_e, cx) => {
              pick(n)
              cx.notify()
            })
            .child(n),
        ),
      )
  }

  tabs(t) {
    return this.picker(t, 'tab', ['board', 'flow'], this.tab, n => {
      this.tab = n
      this.flow = this.flowCache[this.flowKey()] ?? null
    })
  }

  /** the Flow tab: the graph of the workflow, drawn with native paths */
  flowTab(t) {
    const pick = (id, names, picked, set) => this.picker(t, id, names, picked, set)
    const reset = () => (this.flow = this.flowCache[this.flowKey()] ?? null)
    const bar = h_flex()
      .gap(14)
      .flex_wrap()
      .child(pick('wf', FLOW_FACTORIES, this.flowFactory, n => ((this.flowFactory = n), reset())))
      .child(pick('lens', FLOW_LENSES, this.lens, n => (this.lens = n)))
      .child(pick('win', FLOW_WINDOWS, this.flowWindow, n => ((this.flowWindow = n), reset())))
    const body = !this.flow
      ? div().text_color(t.dim).child('reading the flow…')
      : this.flow.error
        ? div().text_color(t.blocked).child(this.flow.error)
        : this.flowGraph(t, this.flow.graph)
    return v_flex()
      .flex_1()
      .min_h(0)
      .gap(8)
      .child(bar)
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().child(body))
  }

  flowGraph(t, graph) {
    const l = flowLayout(graph, this.lens)
    const movers = new Set(recentMovers(graph))
    const stroke = (e, color) => {
      const b = PathBuilder.stroke(e.width)
      for (const [op, x, y, ax, ay, bx, by] of e.path)
        op === 'M' ? b.move_to(x, y) : b.cubic_bezier_to(x, y, ax, ay, bx, by)
      return window.paint_path(e.dashed ? b.dash_array([5, 4]).build() : b.build(), color)
    }
    const dotColor = n => (n.counts.stuck ? t.blocked : n.counts.waiting ? t.idle : t.working)
    const live = new Map(this.liveRuns().map(r => [r.id, r]))
    const box = n =>
      v_flex()
        .id(`node-${n.id}`)
        .absolute()
        .left(n.x)
        .top(n.y)
        .w(n.w)
        .h(n.h)
        .px(6)
        .py(4)
        .gap(2)
        .rounded(n.gate ? 14 : 6)
        .border(1)
        .border_color(n.legacy ? t.dim : t.border)
        .bg(n.heat ? t.blocked : t.raised)
        .when(n.heat > 0, el => el.opacity(0.35 + 0.65 * n.heat))
        .child(div().truncate().text_size(11).font_semibold().text_color(t.foreground).child(n.label))
        .child(
          h_flex()
            .gap(4)
            .items_center()
            .children(
              n.dots.map(d => {
                const r = live.get(d.run)
                const dot = div()
                  .id(`dot-${d.run}`)
                  .w(9)
                  .h(9)
                  .rounded_full()
                  .cursor_pointer()
                  .bg(dotColor(n))
                  .on_click((_e, cx) => r && this.select(r, cx))
                // a run that moved lately pulses, natively
                return movers.has(d.run) ? dot.loop('opacity', { from: 0.35, to: 1, period: 900 }) : dot
              }),
            )
            .child(n.chip ? div().text_size(10).text_color(t.muted).child(n.chip) : div())
            .child(
              div()
                .flex_1()
                .text_size(10)
                .text_color(t.dim)
                .child(this.lens === 'time' && n.p90 !== null ? `p90 ${Math.round(n.p90 / 1000)}s` : ''),
            ),
        )
    const exits = l.exits.map(x =>
      x.opens
        ? div()
            .id(`exit-${x.from}-${x.outcome}`)
            .cursor_pointer()
            .text_size(11)
            .text_color(t.muted)
            .on_click((_e, cx) => {
              this.flowFactory = x.opens
              this.flow = this.flowCache[this.flowKey()] ?? null
              cx.notify()
            })
            .child(`${x.from} → ${x.outcome}: open ${x.opens}`)
        : div().text_size(11).text_color(t.dim).child(`${x.from} → ${x.outcome}: ${x.to}`),
    )
    return v_flex()
      .gap(8)
      .child(
        div()
          .relative()
          .w(l.width)
          .h(l.height)
          .children(l.edges.map(e => stroke(e, e.back ? t.dim : t.muted)))
          .children(
            l.edges.map(e =>
              div()
                .absolute()
                .left(e.lx - 24)
                .top(e.ly)
                .text_size(10)
                .text_color(t.dim)
                .child(e.label),
            ),
          )
          .children(l.nodes.map(box)),
      )
      .children(exits)
  }

  /** the live runs of the shared board, by id */
  liveRuns() {
    return (shared('factory') ?? {}).runs ?? []
  }

  /** runs one factory command (on the machine of a remote config) and toasts the result */
  act(action, arg) {
    const [cmd, args] = this.cfg.server
      ? serverCall(this.cfg, ...actionReq(action, arg))
      : ['env', [`FACTORY_HOME=${this.cfg.home}`, this.cfg.cli, ...actionWords(action, arg)]]
    exec(cmd, args, onOf(this.cfg))
      .then(r =>
        notify({
          title: `factory ${action}`,
          body: line(r.stdout || r.stderr, 200),
          level: r.code === 0 ? 'info' : 'warning',
        }),
      )
      .catch(e => notify({ title: `factory ${action}`, body: String(e), level: 'warning' }))
  }

  /** the buttons: chat, stop, resume, abort of the selected run, unhold of ax */
  controls(button) {
    return [
      ...(chatArgv(this.cfg)
        ? [
            button('chat', chatLabel(shared('factory')?.managerLimited), () =>
              run('terminal.open', {
                argv: chatArgv(this.cfg, shared('factory')?.managerLimited),
                place: 'tab',
              }),
            ),
          ]
        : []),
      button('stop', 'Stop', () => this.act('stop')),
      button('resume', 'Resume', () => this.act('resume')),
      button('unhold', 'Unhold ax', () => this.act('unhold', 'ax')),
      ...(this.selected ? [button('abort', 'Abort run', () => this.act('abort', this.selected))] : []),
    ]
  }

  /** the Interview dialog: gates and decisions, one button for each answer */
  interview() {
    const t = theme()
    const state = shared('factory') ?? {}
    const items = interviewItems(state.runs ?? [], shared('factory.decisions'))
    const answer = (item, option, cx) =>
      cx.spawn(async cx => {
        const cfg = parseConfig((await readTextFile(configPath())) ?? '')
        if (!cfg) return
        // the person clicks the answer: this click is the confirm step
        const [cmd, args] = cfg.server
          ? serverCall(cfg, ...answerReq(item, option))
          : ['env', [`FACTORY_HOME=${cfg.home}`, cfg.cli, ...answerArgs(item, option)]]
        const r = await exec(cmd, args, onOf(cfg)).catch(e => ({
          code: 1,
          stdout: '',
          stderr: String(e),
        }))
        notify({
          title: r.code === 0 ? `answered ${item.key}` : `could not answer ${item.key}`,
          body: line(r.code === 0 ? option : r.stderr || r.stdout, 200),
          level: r.code === 0 ? 'success' : 'error',
        })
        this.answered = { ...(this.answered ?? {}), [item.key]: r.code === 0 }
        cx.notify()
      })
    const open = items.filter(i => !this.answered?.[i.key])
    return v_flex()
      .id('interview')
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child('Interview'))
          .child(
            h_flex()
              .id('close')
              .px(8)
              .cursor_pointer()
              .text_color(t.dim)
              .on_click(() => closeOverlay(props().overlay))
              .child('Close'),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .gap(12)
          .overflow_y_scrollbar()
          .children(
            open.length
              ? open.map(i =>
                  v_flex()
                    .gap(6)
                    .p(10)
                    .rounded(8)
                    .bg(t.raised)
                    .child(div().font_semibold().text_color(t.foreground).child(`${i.kind}: ${i.title}`))
                    .child(
                      div()
                        .text_color(t.muted)
                        .text_size(12)
                        .child(i.detail || ''),
                    )
                    .child(
                      h_flex()
                        .gap(6)
                        .children(
                          i.options.map((o, n) =>
                            h_flex()
                              .id(`${i.key}-${n}`)
                              .h(26)
                              .px(10)
                              .items_center()
                              .rounded(6)
                              .bg(t.solid)
                              .text_color(t.solid_foreground)
                              .cursor_pointer()
                              .hover(s => s.opacity(0.88))
                              .on_click((_e, cx) => answer(i, o, cx))
                              .child(o),
                          ),
                        ),
                    ),
                )
              : [div().text_color(t.dim).child('Nothing waits on you.')],
          ),
      )
  }
}
