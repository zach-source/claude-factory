/**
 * This is a Claude Code PreToolUse hook for Bash.
 * It denies `rm -r` and `rm -rf`, in any spelling or wrapper.
 * It also denies a chain of commands that holds both a `cd` and an `rm`.
 * It gives a reason immediately. The worker reads the reason and continues.
 * The worker does not wait 2 minutes for Claude Code's own permission prompt.
 *
 * The prompt-only fix of claude-factory-9wu (src/worker-system.md) was not enough.
 * Two workers stopped at the prompt after PR #38 merged: lifecycle-mva1ki70a9 and lifecycle-mva7smkfhf.
 *
 * This hook only denies.
 * It never approves a command that Claude Code's own prompt would refuse.
 * claude-factory-9wu rejected another design as a safety regression: a hook that approves `rm -rf`.
 * If a parse error occurs, the hook fails open. It prints nothing. Claude Code's own prompt stays the backstop.
 */

export const REASON =
  'The factory denies this command: do not run rm -r or rm -rf, and do not chain cd with rm. ' +
  'Leave .scratch as is, use a new subfolder (for example .scratch/<name>-2): git ignores .scratch/. ' +
  'Use absolute paths or git -C <dir> in place of cd. Do not retry this command.'

// wrapper commands whose own name we skip to find the command they run
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'env', 'nice', 'nohup', 'time'])

/** the basename of a command word: drops a leading backslash (`\rm`) and any path (`/bin/rm`) */
function baseWord(w: string): string {
  const s = w.replace(/^\\/, '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

/**
 * Splits a command string into segments (shell words), on &&, ||, ;, |, &, a newline, ( ), $( and a
 * backtick, honoring single quotes (literal), double quotes (backslash escapes \\ \" \$ \` and a
 * newline) and a backslash escape outside quotes. A segment stays one shell word per space; a quoted
 * span with spaces inside stays one word, so a quoted argument such as "rm -rf x" is never split into
 * separate rm/-rf/x words.
 */
function segments(cmd: string): string[][] {
  const segs: string[][] = []
  let cur: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (hasWord) cur.push(word)
    word = ''
    hasWord = false
  }
  const endSeg = () => {
    endWord()
    segs.push(cur)
    cur = []
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
      hasWord = true
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && '"\\$`\n'.includes(cmd[i + 1] ?? '')) word += cmd[++i]
      else word += c
      hasWord = true
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      hasWord = true
      continue
    }
    if (c === '\\' && i + 1 < cmd.length) {
      word += cmd[++i]
      hasWord = true
      continue
    }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) {
      endSeg()
      i++
      continue
    }
    if (';|&\n()`'.includes(c)) {
      endSeg()
      continue
    }
    if (/\s/.test(c)) {
      endWord()
      continue
    }
    word += c
    hasWord = true
  }
  endSeg()
  return segs.filter(s => s.length > 0)
}

/** true when `w` is a short-flag cluster (e.g. `-rf`) or a long flag (`--recursive`) that means recursive */
function recursiveFlag(w: string): boolean {
  if (w === '--recursive' || w.startsWith('--recursive=')) return true
  if (w.startsWith('--')) return false
  if (w.startsWith('-') && w.length > 1) return /[rR]/.test(w.slice(1))
  return false
}

/** true when `words` (the rm command and its args) ask for a recursive delete, stopping flag scanning at `--` or the first non-flag word */
function isRecursiveRm(words: string[]): boolean {
  for (const w of words.slice(1)) {
    if (w === '--') return false
    if (w.startsWith('-')) {
      if (recursiveFlag(w)) return true
      continue
    }
    return false
  }
  return false
}

/** `words` with any leading VAR=val, wrapper (sudo, env, time...), `timeout <n>` or `xargs [flags]` stripped */
function realCommand(words: string[]): string[] {
  let w = words
  for (;;) {
    if (!w.length) return w
    const head = w[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      w = w.slice(1)
      continue
    }
    const b = baseWord(head)
    if (WRAPPERS.has(b)) {
      w = w.slice(1)
      continue
    }
    if (b === 'timeout') {
      w = w.slice(1)
      if (/^[\d.]+[smhd]?$/.test(w[0] ?? '')) w = w.slice(1)
      continue
    }
    if (b === 'xargs') {
      w = w.slice(1)
      while (w.length && w[0]!.startsWith('-')) w = w.slice(1)
      continue
    }
    return w
  }
}

/** the reason to deny `command`, or undefined to let Claude Code's own prompt decide */
export function denyReason(command: string): string | undefined {
  if (!command) return undefined
  let hasRm = false
  let hasCd = false
  for (const words of segments(command)) {
    const cmd = realCommand(words)
    if (!cmd.length) continue
    const b = baseWord(cmd[0]!)
    if (b === 'rm') {
      if (isRecursiveRm(cmd)) return REASON
      hasRm = true
    } else if (b === 'cd') {
      hasCd = true
    } else if (b === 'sh' || b === 'bash' || b === 'zsh' || b === 'dash') {
      const ci = cmd.indexOf('-c')
      if (ci >= 0 && cmd[ci + 1] !== undefined) {
        const r = denyReason(cmd[ci + 1]!)
        if (r) return r
      }
    } else if (b === 'find') {
      for (let i = 0; i < cmd.length; i++) {
        if (cmd[i] !== '-exec' && cmd[i] !== '-execdir') continue
        const rest = cmd.slice(i + 1)
        if (rest.length && baseWord(rest[0]!) === 'rm' && isRecursiveRm(rest)) return REASON
      }
    }
  }
  return hasRm && hasCd ? REASON : undefined
}

async function main() {
  const text = await Bun.stdin.text()
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return
  }
  const i = input as { tool_name?: string; tool_input?: { command?: string } }
  if (i?.tool_name !== 'Bash') return
  const reason = denyReason(i.tool_input?.command ?? '')
  if (!reason) return
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}

if (import.meta.main) await main()
