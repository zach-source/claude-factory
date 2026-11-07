import { expect, test } from 'bun:test'
import { denyReason, FACTORY_FROM_REASON, FACTORY_RUN_REASON } from './worker-hook.ts'

const T = 'src/cli.ts tick'
const DENY = [
  'env -i PATH=/usr/bin bun src/cli.ts report run-b 3 approve x',
  'env -i PATH=/usr/bin bun src/cli.ts mail run-b manager x',
  'env -i bun src/cli.ts say hi',
  `env -i bun ${T}`,
  'env -i bun src/cli.ts rig set x --max 2',
  'env -i bun src/cli.ts memory compact',
  'env -i bun src/cli.ts dream',
  `env -i bun run ${T}`,
  'env -i bun /abs/src/cli.ts tick',
  'env -i bun ./src/cli.ts tick',
  `env -i /home/u/.bun/bin/bun ${T}`,
  `env -i BUN ${T}`,
  'env -i node dist/cli.js tick',
  'env -i nodejs dist/cli.js tick',
  'env -i factory mail r1 implement x',
  'env -i bunx x',
  'env -i npx x',
  'env -i npm x',
  'env -i pnpm x',
  'env -i yarn x',
  'env -i deno x',
  'env -i tsx x',
  'env -i ts-node x',
  `env - bun ${T}`,
  `env --ignore-environment bun ${T}`,
  `env --ig bun ${T}`,
  `env -iu FOO bun ${T}`,
  `env -S"-i bun ${T}"`,
  `nice env -i bun ${T}`,
  `env -i nice bun ${T}`,
  `env -i bash -c "bun ${T}"`,
  'env -i eval "node x.js"',
  `env -i \\\nbun ${T}`,
  'env -i PATH=/usr/bin bun test src',
  'env -i grep -rn bun src',
]
const ALLOW = [
  'env -i ls',
  'env -i PATH=/usr/bin ls',
  'env -i',
  'env -i "$PY" -c x',
  `env FOO=1 bun ${T}`,
  'env -u OTHER bun test',
  'bun test src',
]

for (const c of DENY) {
  test(`denies ${JSON.stringify(c)}`, () => {
    expect(denyReason(c)).toBe(FACTORY_FROM_REASON)
  })
}
for (const c of ALLOW) {
  test(`allows ${JSON.stringify(c)}`, () => {
    expect(denyReason(c)).toBeUndefined()
  })
}
test('env -u FACTORY_RUN bun still denies', () => {
  expect(denyReason(`env -u FACTORY_RUN bun ${T}`)).toBe(FACTORY_RUN_REASON)
})
