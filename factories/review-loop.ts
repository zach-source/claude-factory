import type { Factory } from '../src/machine'

// implement <-> review until the reviewer approves; Sonnet builds, Opus reviews
export default {
  name: 'review-loop',
  start: 'implement',
  // a rig's --param and FACTORY_<NAME> override these
  params: { claude: 'claude-smart --new --no-channels', exec_model: 'claude-sonnet-5[1m]' },
  nodes: {
    implement: {
      prompt: `Implement the goal. Write a failing test first, make it pass, run the project's
formatter and linters, and commit. If your inbox holds review feedback, address every point.`,
      next: { ready: 'review' },
      agent: `{claude} --dangerously-skip-permissions --model '{exec_model}'`,
    },
    review: {
      prompt: `Review this branch's commits against the goal: correctness, tests, simplicity.
Change no code yourself. Report "approve" if it is ready to merge, otherwise
"changes" with a numbered list of exactly what to fix.`,
      next: { approve: 'done', changes: 'implement' },
    },
  },
} satisfies Factory
