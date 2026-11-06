import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { denyReason, GLAB_APPROVE_REASON, MERGE_REASON, READY_REASON } from './worker-hook'

// claude-factory-qn8a.32: glab merge and glab ready are gated like their gh twins.
const FILES: Record<string, string> = {
  'ph.graphql': 'mutation { :branch(input:{}) { errors } }',
  'merge.graphql': 'mutation { mergeRequestAccept(input:{}) { errors } }',
  'merge.json': JSON.stringify({ query: 'mutation { mergeRequestAccept(input:{}) { errors } }' }),
  'draft.graphql': 'mutation { mergeRequestSetDraft(input:{draft:false}) { errors } }',
  'draft.json': JSON.stringify({
    query: 'mutation { mergeRequestSetDraft(input:{draft:false}) { errors } }',
  }),
}
const GATES: Record<string, unknown>[] = [
  {},
  { station: 'implement' },
  { station: 'review' },
  { station: 'release' },
  { station: 'review', reviewer: true },
  { factory: 'ship', station: 'release', mergeAuthority: 'acme/widget' },
]
const READY_GATES = GATES.filter(g => ['review', 'release'].includes(g.station as string))
const NOT_READY_GATES = GATES.filter(g => !READY_GATES.includes(g))
const ask = (cmd: string, g: Record<string, unknown>) =>
  denyReason(cmd, undefined, undefined, { readFile: (p: string) => FILES[p], ...g })

const MERGE_DENY = [
  'glab mr merge 5',
  'glab mr merge',
  'glab mr accept 5',
  'glab mr merge 5 --auto-merge=false -y',
  'glab mr merge 5 --sha abc -s -d',
  'glab mr -R a/b merge 5',
  'glab mr --repo=a/b accept 5',
  'glab -R a/b mr merge 5',
  '/usr/bin/glab mr merge 5',
  '\\glab mr merge 5',
  'env glab mr merge 5',
  'command glab mr merge 5',
  'bash -c "glab mr merge 5"',
  'true && glab mr merge 5',
  'glab mr merge \\\n5',
  'glab mr merge 5 >out',
  'glab mr note 5 -m merge',
  'glab api -X PUT projects/:id/merge_requests/5/merge',
  'glab api projects/:id/merge_requests/5/merge -f sha=x',
  'glab api --method=PUT projects/a%2Fb/merge_requests/5/merge',
  'glab api -XPUT projects/1/merge_requests/5/merge',
  'glab api -X PUT projects/1/merge_requests/5/merge/',
  'glab api -X PUT projects/1/merge_requests/5/merge#x',
  'glab api -X PUT projects/1/merge_requests/5/merge?squash=true',
  'glab api -X PUT https://gitlab.example.com/api/v4/projects/1/merge_requests/5/merge',
  'glab api projects/1/merge_requests%2F5%2Fmerge -X PUT',
  'glab api -X PUT projects/1/merge_requests/5/MERGE',
  'glab api -X PUT projects/1/merge_requests/5/merge.json',
  'glab api -X PUT projects/1/merge_requests/5/./merge',
  'glab api -X PUT projects/1/merge_requests/5//merge',
  'glab api -X PUT projects/1/merge_requests/5/x/../merge',
  'glab api -X POST projects/1/merge_requests/5/merge_when_pipeline_succeeds',
  'glab api -X POST projects/1/merge_trains/merge_requests/5',
  'glab api -R x/y -X PUT projects/1/merge_requests/5/merge',
  'glab api >out -X PUT projects/1/merge_requests/5/merge',
  `glab api graphql -f query='mutation { mergeRequestAccept(input:{}) { errors } }'`,
  'glab api graphql -f query=@merge.graphql',
  'glab api graphql --input merge.json',
  `glab api graphql -f query='mutation { mergeRequestSetAutoMerge(input:{}) { errors } }'`,

  'glab mr -y -- merge 5',
  'glab mr --yes -- merge 5',
  'glab mr -d -- accept 5',
  'glab -y -- mr merge 5',
  'glab -X PUT -i -- api projects/1/merge_requests/5/merge',
  `glab -F query=@merge.graphql api graphql`,
  'glab --input merge.json api graphql',
  `glab --raw-field=query='mutation { mergeRequestAccept(input:{}) { errors } }' api graphql`,
  'glab api -X PUT projects/:id/merge_requests/5/:branch',
  'glab api -X PUT projects/1/:repo/5/merge',
  'glab api -X PUT projects/1/:repo/5 -f title=Foo',
  'glab api -X POST projects/1/merge_trains/:repo/5',
  'glab api -X PUT projects/1/merge_requests/:branch',
  `glab api graphql -F query='mutation { :branch(input:{}) { errors } }'`,
  'glab api graphql -F query=@ph.graphql',
]
const MERGE_ALLOW = [
  'glab mr view 5',
  'glab mr list',
  'glab mr note 5 -m x -- merge',
  'glab mr rebase 5',
  'glab mr view merge-fix',
  'glab mr create --draft -t x -d y',
  'glab api projects/1/merge_requests/5/merge_ref',
  'glab api -X POST projects/1/merge_requests/5/cancel_merge_when_pipeline_succeeds',
  'glab api projects/1/merge_requests/5',
  'glab api projects/1/merge_requests?state=merged',
  'glab api projects/1/merge_trains',
  `glab api graphql -f query='query { project(fullPath:"a/b") { mergeRequest(iid:"5") { mergeable } } }'`,
]

for (const g of GATES) {
  const name = JSON.stringify(g)
  test.each(MERGE_DENY)(`denyReason denies %j with MERGE_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(MERGE_REASON)
  })
  test.each(MERGE_ALLOW)(`denyReason allows %j for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBeUndefined()
  })
}

test('an unreadable glab graphql text still denies with GLAB_APPROVE_REASON', () => {
  expect(ask('glab api graphql -f query=@missing.graphql', {})).toBe(GLAB_APPROVE_REASON)
})

test('run as `bun src/worker-hook.ts`, glab mr merge is denied (claude-factory-qn8a.32)', async () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'glab mr merge 5' } })
  const p = Bun.spawn(['bun', join(import.meta.dir, 'worker-hook.ts')], {
    stdin: new Response(input),
    stdout: 'pipe',
    env: { ...process.env, FACTORY_FROM: 'implement' },
  })
  const out = await new Response(p.stdout).text()
  expect(JSON.parse(out.trim()).hookSpecificOutput).toMatchObject({
    permissionDecision: 'deny',
    permissionDecisionReason: MERGE_REASON,
  })
}, 20_000)

const READY_DENY = [
  'glab mr update 5 --ready',
  'glab mr update 5 -r',
  'glab mr update -r',
  'glab mr update 5 -ry',
  'glab mr update 5 --ready=true',
  'glab mr update 5 --ready=false',
  'glab mr update 5 -t Foo',
  'glab mr update 5 --title=Foo',
  'glab mr update 5 -tFoo',
  'glab mr update 5 --fill -y',
  'glab mr update 5 -f',
  'glab mr update 5 --draft --ready',
  'glab mr update 5 --draft=false',
  'glab mr update 5 --wip=false',
  'glab mr -R a/b update 5 --ready',
  'glab mr update 5 $F',
  'glab mr update 5 -t x -d $D --draft',
  'glab mr update 5 -t $T --draft',
  'glab mr update 5 -t x -l "$L" --wip',
  'glab mr update 5 --fill -a $A --draft',
  'glab mr update 5 -t x -yd $D --draft',
  'glab mr update 5 -t x --reviewer $R --draft',
  'glab api -X PUT projects/1/merge_requests/5/./ -f title=Foo',
  'glab api -X PUT projects/1/merge_requests/5/x/.. -f title=Foo',
  'glab api -X PUT projects/1/merge_requests//5 -f title=Foo',
  'glab mr update 5 -t --draft',
  'glab mr update 5 --title --draft',
  'glab mr update 5 -t --wip',
  `glab mr update 5 -t "--draft"`,
  'glab mr update 5 --draft -t -- --ready',
  'glab mr update 5 -yt --draft',
  'glab mr update 5 -t Foo -yd --draft',
  'glab mr update 5 -t Foo -yl --wip',
  'glab mr update 5 --fill -ya --draft',
  'glab mr update 5 -t Foo -yR --draft',
  'glab mr update 5 -yd -- --ready',
  'glab mr update 5 -yl -- -r',
  'glab mr update 5 --ready \\\n',
  'bash -c "glab mr update 5 -r"',
  'glab api -X PUT projects/1/merge_requests/5 -f title=Foo',
  'glab api projects/1/merge_requests/5 -f title=Foo',
  'glab api -X PUT projects/1/merge_requests/5 --input body.json',
  'glab api -X PUT projects%2F1%2Fmerge_requests%2F5',
  `glab api graphql -f query='mutation { mergeRequestSetDraft(input:{draft:false}) { errors } }'`,
  `glab api graphql -f query='mutation { mergeRequestUpdate(input:{title:"x"}) { errors } }'`,
  'glab api graphql -f query=@draft.graphql',
  'glab api graphql --input draft.json',
  'glab mr -r -- update 5',
  'glab mr --ready -- update 5',
  'glab mr -f -- update 5',
  'glab -r -- mr update 5',
  'glab -X PUT -f title=Foo -i -- api projects/1/merge_requests/5',
  'glab -ry mr update 5',
  'glab --ready=true mr update 5',
  'glab --title=Foo mr update 5',
  'glab -tFoo mr update 5',
  'glab -t Foo mr update 5',
  'glab -yf mr update 5',
  'glab -X PUT -f title=Foo api projects/1/merge_requests/5',
  'glab -XPUT -ftitle=Foo api projects/1/merge_requests/5',
  'glab --method=PUT --raw-field=title=Foo api projects/1/merge_requests/5',
  'glab -X PUT --input body.json api projects/1/merge_requests/5',
  'glab api -X PUT projects/1/merge_requests/5 -f -X=GET',
  'glab api -X PUT projects/1/merge_requests/5 -f title=Foo -f --method=GET',
  'glab api -X PUT projects/1/merge_requests/5 -F -X=GET',
  'glab api -X PUT projects/1/merge_requests/5 --input -X=GET',
  'glab api -X PUT projects/1/merge_requests/5 --input -XGET',
  'glab api -X PUT projects/1/merge_requests/5 --form title=Foo --form -X=GET',
  'glab api -X PUT projects/1/merge_requests/5 -f title=Foo --hostname -XGET',
]
const READY_ALLOW = [
  'glab mr update 5 --draft',
  'glab mr update 5 --wip',
  'glab mr update 5 --draft -t Foo',
  'glab mr update 5 -d "$DESC"',
  'glab mr update 5 --description="$D"',
  'glab mr update 5 -l bug -a me',
  'glab mr update 5 -- --ready',
  'glab mr update 5 --draft -t Foo',
  'glab -R a/b mr update 5 --draft',
  'glab api -X GET projects/1/merge_requests/5/:id',
  'glab api projects/1/merge_requests/5/:branch',
  'glab mr update 5 --target-branch main',
  'glab api projects/1/merge_requests/5',
  'glab api -X GET projects/1/merge_requests/5',
  'glab api -X POST projects/1/merge_requests -f title=Draft:x',
  'glab api -X POST projects/1/merge_requests/5/notes -f body=x',
  `glab api graphql -f query='query { project(fullPath:"a/b") { mergeRequest(iid:"5") { title } } }'`,
]

for (const g of NOT_READY_GATES) {
  const name = JSON.stringify(g)
  test(`denyReason denies a query string on the merge request path for gate ${name}`, () => {
    expect(ask(`glab api -X PUT 'projects/1/merge_requests/5?title=Foo'`, g)).toBe(READY_REASON)
  })
  test.each(READY_DENY)(`denyReason denies %j with READY_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(READY_REASON)
  })
}
for (const g of GATES) {
  const name = JSON.stringify(g)
  test.each(READY_ALLOW)(`denyReason allows %j for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBeUndefined()
  })
}
for (const g of READY_GATES) {
  const name = JSON.stringify(g)
  test.each(READY_DENY)(`denyReason allows %j for the ready gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBeUndefined()
  })
}

test('run as `bun src/worker-hook.ts`, glab mr update --ready is denied (claude-factory-qn8a.32)', async () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'glab mr update 5 --ready' } })
  const p = Bun.spawn(['bun', join(import.meta.dir, 'worker-hook.ts')], {
    stdin: new Response(input),
    stdout: 'pipe',
    env: { ...process.env, FACTORY_FROM: 'implement' },
  })
  const out = await new Response(p.stdout).text()
  expect(JSON.parse(out.trim()).hookSpecificOutput).toMatchObject({
    permissionDecision: 'deny',
    permissionDecisionReason: READY_REASON,
  })
}, 20_000)
