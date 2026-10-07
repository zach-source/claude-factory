import type { Factory } from '../src/machine'

// FACTORY_CLAUDE swaps the Claude Code command (default claude-smart)
const CLAUDE = process.env.FACTORY_CLAUDE?.trim() || 'claude-smart --new --no-channels'

// implement <-> review until the reviewer approves; Sonnet builds, Opus reviews
export default {
  name: 'review-loop',
  start: 'implement',
  nodes: {
    implement: {
      prompt: `Implement the goal. Write a failing test first, make it pass, run the project's
formatter and linters, and commit. If your inbox holds review feedback, address every point.`,
      next: { ready: 'review' },
      agent: `${CLAUDE} --dangerously-skip-permissions --model 'claude-sonnet-5[1m]'`,
    },
    review: {
      prompt: `Review this branch's commits against the goal: correctness, tests, simplicity.
Change no code yourself. Report "approve" if it is ready to merge, otherwise
"changes" with a numbered list of exactly what to fix.`,
      next: { approve: 'done', changes: 'implement' },
    },
  },
} satisfies Factory
