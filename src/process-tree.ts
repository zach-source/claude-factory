// A build may start a new process session, outside the terminal's process group.
type Process = { pid: number; parent: number; state: string; started: string }

function snapshot(): Process[] {
  const p = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,stat=,lstart='], { timeout: 1000 })
  if (p.exitCode !== 0) throw new Error('cannot inspect worker processes before closing its pane')
  return p.stdout
    .toString()
    .trim()
    .split('\n')
    .map(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
      if (!m) throw new Error('invalid process snapshot; worker cleanup held')
      return { pid: Number(m[1]), parent: Number(m[2]), state: m[3]!, started: m[4]! }
    })
}

function children(root: number, rows: Process[]) {
  const owned = new Set([root])
  for (const parent of owned) for (const p of rows) if (p.parent === parent) owned.add(p.pid)
  return rows.filter(p => p.pid !== root && owned.has(p.pid) && !p.state.startsWith('Z'))
}

const live = (owned: Process[], rows = snapshot()) =>
  owned.filter(p => rows.some(r => r.pid === p.pid && r.started === p.started && !r.state.startsWith('Z')))

function signal(owned: Process[], name: NodeJS.Signals) {
  for (const p of live(owned)) {
    try {
      process.kill(p.pid, name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    }
  }
}

function waitForExit(owned: Process[], until: number) {
  while (live(owned).length && Date.now() < until) Bun.sleepSync(25)
  return live(owned)
}

/** Stop only descendants positively observed under this pane's shell, including detached children. */
export function stopChildren(shell: number) {
  if (!Number.isInteger(shell) || shell <= 1 || shell === process.pid)
    throw new Error('invalid worker shell pid; cleanup held')
  const rows = snapshot()
  const root = rows.find(p => p.pid === shell)
  if (!root) throw new Error('worker shell disappeared before its children could be inspected')
  if (children(shell, rows).some(p => p.pid === process.pid))
    throw new Error('cannot close the pane running this factory command')
  const owned: Process[] = []
  signal([root], 'SIGSTOP')
  try {
    // Freeze parents before collecting again, so a launch in progress is captured too.
    for (let pass = 0; ; pass++) {
      const current = snapshot()
      if (!live([root], current).length)
        throw new Error('worker shell changed during cleanup; replacement held')
      const added = children(shell, current).filter(
        p => !owned.some(o => o.pid === p.pid && o.started === p.started),
      )
      if (!added.length) break
      if (pass === 10) throw new Error('worker process tree did not settle; cleanup held')
      owned.push(...added)
      signal(added, 'SIGSTOP')
    }
    signal(owned.toReversed(), 'SIGTERM')
    signal(owned, 'SIGCONT')
    const remaining = waitForExit(owned, Date.now() + 1000)
    signal(remaining, 'SIGKILL')
    if (waitForExit(remaining, Date.now() + 1000).length)
      throw new Error('worker children remain alive; pane replacement held')
  } finally {
    signal([...owned, root], 'SIGCONT')
  }
}
