// The factory manager for the Herdr app (claude-factory-s01d.3), a second local UI beside the Claude mod.
// The panel copy ticks and patrols, and holds the local manager lease.
// With "machine" in config.json (claude-factory-hpmc.14) the manager runs there, such as the AX task f-manager.
// Then every exec and file read passes on: machine. The mod never ticks, patrols or takes the lease.
//
// Props { band: true } draw a status band of one line.
// Props { dialog: "interview" } draw the Interview dialog.
// `factory herdr install` writes config.json next to this file: { cli, home, machine? }.

import { View, div } from 'gpui-kit'
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
  answerArgs,
  board,
  interviewItems,
  line,
  newlyBlocked,
  parseConfig,
  parseTick,
  shortId,
  statusText,
  actionWords,
  beatJobs,
  chatArgv,
  directJob,
  onOf,
} from './view.js'

const TICK_MS = 5_000
/** a job with no answer for this long is free again */
const JOB_LIMIT_MS = 20 * 60_000

// One detached job: exec has a 30 s limit, and a tick or a patrol can run longer.
// Arguments: $1 cli, $2 home, $3 holder, $4 job name, $5 seq, then the factory words.
// The job writes <home>/herdr/<name>.out and .err, then "<seq> <exit code>" to .done.
const JOB = `cli=$1 home=$2 holder=$3 name=$4 seq=$5; shift 5; dir="$home/herdr"; mkdir -p "$dir"
( FACTORY_HOME="$home" FACTORY_LEASE_HOLDER="$holder" FACTORY_LEASE_KIND=herdr "$cli" "$@" >"$dir/$name.out.tmp" 2>"$dir/$name.err"
  code=$?; mv "$dir/$name.out.tmp" "$dir/$name.out"; echo "$seq $code" >"$dir/$name.done" ) </dev/null >/dev/null 2>&1 &`

const configPath = () => `${appHome()}/mods/factory/config.json`

export default class Factory extends View {
  init(_props, cx) {
    this.cfg = null
    this.jobs = {} // name -> { seq, at }
    this.ran = {} // name -> last start time
    this.seq = Date.now()
    this.selected = null
    this.screen = ''
    this.before = {}
    this.mailSeen = 0
    const p = props() ?? {}
    if (p.band || p.dialog) return // only the panel copy ticks
    try {
      this.holder = localStorage.getItem('holder')
      if (!this.holder) {
        this.holder = `herdr:${Math.random().toString(36).slice(2, 10)}`
        localStorage.setItem('holder', this.holder)
      }
    } catch {
      this.holder = `herdr:${Math.random().toString(36).slice(2, 10)}`
    }
    cx.spawn(async cx => {
      const text = await readTextFile(configPath()) // the config is on this machine
      try {
        this.cfg = parseConfig(text)
      } catch {
        this.cfg = null
      }
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

  /** starts a detached factory command, unless one with that name runs */
  start(name, words) {
    const job = this.jobs[name]
    if (job && Date.now() - job.at < JOB_LIMIT_MS) return
    const seq = String(++this.seq)
    this.jobs[name] = { seq, at: Date.now() }
    this.ran[name] = Date.now()
    // hc exec kills every process the command leaves behind, so a remote job runs direct and keeps its output
    if (this.cfg.machine) {
      const [cmd, args] = directJob(this.cfg, words)
      const mine = this.jobs[name]
      exec(cmd, args, onOf(this.cfg))
        .then(r => (mine.result = { code: r.code, out: r.stdout, err: r.stderr }))
        .catch(e => (mine.result = { code: 1, out: '', err: String(e) }))
      return
    }
    exec(
      'sh',
      ['-c', JOB, 'sh', this.cfg.cli, this.cfg.home, this.holder, name, seq, ...words],
      onOf(this.cfg),
    ).catch(() => {
      delete this.jobs[name]
    })
  }

  /** the result of a finished job, or null while it runs */
  async finished(name) {
    const job = this.jobs[name]
    if (!job) return null
    if (this.cfg.machine) {
      if (!job.result) return null
      delete this.jobs[name]
      return job.result
    }
    const dir = `${this.cfg.home}/herdr`
    const at = onOf(this.cfg)
    const done = ((await readTextFile(`${dir}/${name}.done`, at)) ?? '').trim().split(' ')
    if (done[0] !== job.seq) return null
    delete this.jobs[name]
    return {
      code: Number(done[1]),
      out: (await readTextFile(`${dir}/${name}.out`, at)) ?? '',
      err: (await readTextFile(`${dir}/${name}.err`, at)) ?? '',
    }
  }

  beat(cx) {
    cx.spawn(async cx => {
      const tick = await this.finished(this.cfg.machine ? 'board' : 'tick')
      if (tick) this.onTick(parseTick(tick.code, tick.out, tick.err))
      const dec = await this.finished('decisions')
      if (dec && dec.code === 0) {
        try {
          setShared('factory.decisions', JSON.parse(dec.out))
        } catch {}
      }
      for (const name of ['patrol', 'brief', 'review', 'pm']) {
        const r = await this.finished(name)
        if (r && r.code !== 0)
          notify({ title: `factory ${name}`, body: line(r.err || r.out, 200), level: 'warning' })
        else if (r && name === 'patrol' && r.out.trim() && r.out.trim() !== 'nothing due')
          notify({ title: 'factory patrol', body: line(r.out.split('\n')[0], 200), level: 'info' })
      }
      for (const j of beatJobs(this.cfg, shared('factory') ?? {}, this.ran, Date.now()))
        this.start(j.name, j.words)
      cx.notify()
    })
  }

  onTick(res) {
    if (res.busy) return
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
    if (res.manager.length)
      notify({ title: 'factory', body: `${res.manager.length} message(s) for the manager`, level: 'info' })
    setShared('factory', {
      runs: res.runs,
      halt: res.halt,
      readOnly: res.readOnly,
      at: Date.now(),
      mail: [...(prev.mail ?? []), ...res.manager].slice(-50),
    })
  }

  select(r, cx) {
    this.selected = r.id
    this.screen = ''
    cx.notify()
    if (!r.pane) return
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
    const head = state.readOnly
      ? `read-only: ${state.readOnly}`
      : state.error
        ? `tick failed: ${state.error}`
        : statusText(runs) || 'no live runs'
    if (p.band)
      return h_flex()
        .size_full()
        .px(10)
        .items_center()
        .bg(t.chrome)
        .text_size(12)
        .text_color(state.readOnly || state.error ? t.blocked : t.muted)
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
                .text_color(state.readOnly || state.error ? t.blocked : t.muted)
                .child(head),
            ),
        )
        // the buttons wrap to a new line when the panel is narrow, so none is cut off
        .child(
          h_flex()
            .gap(6)
            .flex_wrap()
            .child(button('interview', `Interview (${items.length})`, () => this.openInterview()))
            .children(this.cfg.machine ? this.controls(button) : []),
        )
        .child(
          v_flex()
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

  /** runs one factory command on the machine of a remote config and toasts the result */
  act(action, arg) {
    exec('env', [`FACTORY_HOME=${this.cfg.home}`, this.cfg.cli, ...actionWords(action, arg)], onOf(this.cfg))
      .then(r =>
        notify({
          title: `factory ${action}`,
          body: line(r.stdout || r.stderr, 200),
          level: r.code === 0 ? 'info' : 'warning',
        }),
      )
      .catch(e => notify({ title: `factory ${action}`, body: String(e), level: 'warning' }))
  }

  /** the buttons of a remote config: chat, stop, resume, abort of the selected run, unhold of ax */
  controls(button) {
    return [
      button('chat', 'Manager chat', () => run('terminal.open', { argv: chatArgv(this.cfg), place: 'tab' })),
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
        const r = await exec(
          'env',
          [`FACTORY_HOME=${cfg.home}`, cfg.cli, ...answerArgs(item, option)],
          onOf(cfg),
        ).catch(e => ({
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
