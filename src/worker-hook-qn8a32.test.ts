import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  denyReason,
  DYNAMIC_VERB_REASON,
  GLAB_API_REASON,
  GLAB_APPROVE_REASON,
  GLAB_DYNAMIC_REASON,
  GLAB_VERB_REASON,
  MERGE_REASON,
  READY_REASON,
} from './worker-hook'

// claude-factory-qn8a.32: glab merge and glab ready are gated like their gh twins.
const FILES: Record<string, string> = {
  'f.md': 'looks good',
  'ph.graphql': 'mutation { :branch(input:{}) { errors } }',
  'merge.graphql': 'mutation { mergeRequestAccept(input:{}) { errors } }',
  'merge.json': JSON.stringify({ query: 'mutation { mergeRequestAccept(input:{}) { errors } }' }),
  'q.graphql': 'mutation { a }',
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
  'glab mr create --auto-merge -t x -d y',
  'glab mr create -t x -d y --auto-merge',
  'glab mr create --auto-merge=true -t x -d y',
  'glab mr create --fill --auto-merge',
  'glab mr create --draft --auto-merge -t x -d y',
  'glab mr create --auto-merge --push -t x -d y',
  'glab --auto-merge mr create -t x -d y',
  'glab mr --auto-merge create -t x -d y',
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
  'glab mr -y -- merge 5',
  'glab mr --yes -- merge 5',
  'glab mr -d -- accept 5',
  'glab -y -- mr merge 5',
  'glab mr -d x merge 5',
  'glab mr -t -d merge 5',
  'glab -t -y mr merge 5',
  'glab mr note 5 -m x -- merge',
]
const MERGE_ALLOW = [
  'glab mr view 5',
  'glab mr list',
  'glab mr list --merged',
  'glab mr rebase 5',
  'glab mr view merge-fix',
  'glab mr create --draft -t x -d y',
]

const APPROVE_DENY = ['glab mr approve 5', 'glab mr -d x approve 5', 'glab mr note 5 -m x -- approve']

// every glab api call outside the 3 closed forms: GLAB_API_REASON at every gate
const API_DENY = [
  'glab api -X PUT projects/:id/merge_requests/5/merge',
  'glab api projects/:id/merge_requests/5/merge -f sha=x',
  'glab api --method=PUT projects/a%2Fb/merge_requests/5/merge',
  'glab api -XPUT projects/1/merge_requests/5/merge',
  'glab api -X PUT projects/1/merge_requests/5/merge/',
  'glab api -X PUT projects/1/merge_requests/5/merge#x',
  'glab api -X PUT https://gitlab.example.com/api/v4/projects/1/merge_requests/5/merge',
  'glab api projects/1/merge_requests%2F5%2Fmerge -X PUT',
  'glab api -X PUT projects/1/merge_requests/5/MERGE',
  'glab api -X PUT projects/1/merge_requests/5/merge.json',
  'glab api -X PUT projects/1/merge_requests/5/./merge',
  'glab api -X PUT projects/1/merge_requests/5//merge',
  'glab api -X PUT projects/1/merge_requests/5/x/../merge',
  'glab api -X POST projects/1/merge_requests/5/merge_when_pipeline_succeeds',
  'glab api -X POST projects/1/merge_requests/5/cancel_merge_when_pipeline_succeeds',
  'glab api -X POST projects/1/merge_trains/merge_requests/5',
  'glab api -R x/y -X PUT projects/1/merge_requests/5/merge',
  'glab api >out -X PUT projects/1/merge_requests/5/merge',
  `glab api graphql -f query='mutation { mergeRequestAccept(input:{}) { errors } }'`,
  'glab api graphql -f query=@merge.graphql',
  'glab api graphql --input merge.json',
  `glab api graphql -f query='mutation { mergeRequestSetAutoMerge(input:{}) { errors } }'`,
  'glab api -X PUT projects/:id/merge_requests/5/:branch',
  'glab api -X PUT projects/1/:repo/5/merge',
  'glab api -X PUT projects/1/:repo/5 -f title=Foo',
  'glab api -X POST projects/1/merge_trains/:repo/5',
  'glab api -X PUT projects/1/merge_requests/:branch',
  `glab api graphql -F query='mutation { :branch(input:{}) { errors } }'`,
  'glab api graphql -F query=@ph.graphql',
  `glab api graphql -f query='query { a }' -F v=:branch`,
  'glab api -X PUT projects/1/merge_requests/5 -f title=Foo',
  'glab api projects/1/merge_requests/5 -f title=Foo',
  'glab api -X PUT projects/1/merge_requests/5 --input body.json',
  'glab api -X PUT projects%2F1%2Fmerge_requests%2F5',
  `glab api graphql -f query='mutation { mergeRequestSetDraft(input:{draft:false}) { errors } }'`,
  `glab api graphql -f query='mutation { mergeRequestUpdate(input:{title:"x"}) { errors } }'`,
  'glab api graphql -f query=@draft.graphql',
  'glab api graphql --input draft.json',
  'glab api -X PUT projects/1/merge_requests/5 -f -X=GET',
  'glab api -X PUT projects/1/merge_requests/5 -f title=Foo -f --method=GET',
  'glab api -X PUT projects/1/merge_requests/5 -F -X=GET',
  'glab api -X PUT projects/1/merge_requests/5 --input -X=GET',
  'glab api -X PUT projects/1/merge_requests/5 --input -XGET',
  'glab api -X PUT projects/1/merge_requests/5 --form title=Foo --form -X=GET',
  'glab api -X PUT projects/1/merge_requests/5 -f title=Foo --hostname -XGET',
  'glab api -X PUT projects/1/merge_requests/5/./ -f title=Foo',
  'glab api -X PUT projects/1/merge_requests/5/x/.. -f title=Foo',
  'glab api -X PUT projects/1/merge_requests//5 -f title=Foo',
  'glab api -X GET -X PUT projects/1/merge_requests/5',
  'glab api -X POST projects/1/merge_requests/5/notes -X PUT',
  'glab api -X POST projects/1/merge_requests/5/notes/../merge',
  'glab api -X POST projects/1/MERGE_REQUESTS/5/notes',
  'glab api -X POST projects/1/merge_requests/5/notes -H x:y',
  'glab api -X POST projects/1/merge_requests/5/notes --input b.json',
  `glab api graphql -f query='mutation { a }'`,
  'glab api graphql -F query=@q.graphql',
  'glab api graphql -f query=@q.graphql',
  `glab api graphql -f query='query { a }' -f x=y`,
  'glab api projects/1 projects/2',
  'glab api -- projects/1',
  'glab mr note 5 -m api',
  'glab api -X DELETE projects/1/merge_requests/5/notes/3',
  'glab api -X PUT projects/1/merge_requests/5/notes -f body=x',
  'glab api -R -i projects/1',
  'glab api -XGET --method=GET projects/1',
  'glab api -X POST graphql',
  'glab api -X POST projects/1/merge_requests/5/notes -f body=x -X PUT',
  'glab api --output txt projects/1',
  'glab api -R projects/1',
  'glab api -X',
  'glab api',
]
const API_ALLOW = [
  'glab api projects/1/merge_requests/5',
  'glab api -X GET projects/1/merge_requests/5/:id',
  'glab api projects/1/merge_requests/5/:branch',
  `glab api 'projects/1/merge_requests?state=merged'`,
  'glab api projects/1/merge_trains --paginate',
  'glab api projects/1/merge_requests/5/merge_ref',
  'glab api >out projects/:id/merge_requests/5',
  'glab api -XGET projects/1',
  'glab api --method=GET -i --silent projects/1',
  'glab api --output json -R a/b --hostname gitlab.example.com projects/1',
  'glab api --output=ndjson --repo=a/b projects/1',
  `glab api graphql -f query='query { project(fullPath:"a/b") { mergeRequest(iid:"5") { title } } }'`,
  `glab api graphql --raw-field query='query { a }' --paginate`,
  `glab api graphql --raw-field=query='query { a }'`,
  'glab api --method POST projects/:id/merge_requests/5/notes -F body=@f.md',
  'glab api -X POST projects/1/merge_requests/5/notes -f body=x',
  'glab api -X POST projects/a%2Fb/merge_requests/5/notes -f body=x',
  'glab api -X POST projects/a%2Fb%2Fc/merge_requests/5/notes --field=body=x',
  'glab api -X POST projects/1/merge_requests -f title=Draft:x',
  'glab api -X POST projects/:id/merge_requests/5/unapprove',
  'glab api projects/1/merge_requests/5/notes -f body=x --raw-field=a=b',
]
// a dynamic word that the guard cannot read, at every gate
const DYNAMIC_DENY = [
  'glab mr -d x "$V" 5',
  'glab mr -d x $V 5',
  'glab mr -t -d "$V" 5',
  'glab mr note 5 -m "$MSG"',
  'glab api "projects/$ID/merge_requests"',
  'glab api -R "$R" -X POST projects/1/merge_requests/5/notes',
  'glab mr update 5 -d "$DESC"',
  'glab mr update 5 --title="$T"',
  'glab mr update 5 --ready="$X"',
  'glab api --method="$M" projects/1/merge_requests/5',
  `glab mr update 5 '$F'x`,
  'glab mr view ~/x',
  'glab mr view *',
  'glab mr note 5 --message="$MSG" --message=$MSG',
  'glab mr note 5 --message=$MSG',
  'glab api --output "$F" -X POST projects/1/merge_requests/5/notes',
  'glab api --form "$F" -X POST projects/1/merge_requests/5/notes',
  'glab api --repo "$R" -X POST projects/1/merge_requests/5/notes',
  'glab api -X PUT projects/1/merge_requests/5/merge?squash=true',
  'glab mr update 5 $F',
  'glab mr update 5 -t x -d $D --draft',
  'glab mr update 5 -t $T --draft',
  'glab mr update 5 -t x -l "$L" --wip',
  'glab mr update 5 --fill -a $A --draft',
  'glab mr update 5 -t x -yd $D --draft',
  'glab mr update 5 -t x --reviewer $R --draft',
  `glab api 'projects/1' $X`,
  'glab mr --message="${=X}" 5',
  'glab mr --message="${(s: :)X}" 5',
  'glab mr --message="${(f)X}" 5',
  'glab mr --message="${a[@]}" 5',
  'glab mr --message="$a[@]" 5',
  'glab mr --message="$@" 5',
  'glab mr --message="$*" 5',
  'glab mr --message="${!X}" 5',
  'glab mr --message="${#X}" 5',
  'glab mr --description="${@}" 5',
  'glab mr update 5 --description="$@"',
  'glab mr update 5 --label="${a[@]}"',
]
const DYNAMIC_ALLOW = [`glab mr view 'a b'`, `glab mr note 5 -m 'a $b'`]

for (const g of GATES) {
  const name = JSON.stringify(g)
  test.each(MERGE_DENY)(`denyReason denies %j with MERGE_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(MERGE_REASON)
  })
  test.each(APPROVE_DENY)(`denyReason denies %j with GLAB_APPROVE_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_APPROVE_REASON)
  })
  test.each(API_DENY)(`denyReason denies %j with GLAB_API_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_API_REASON)
  })
  test.each(DYNAMIC_DENY)(`denyReason denies dynamic %j for gate ${name}`, cmd => {
    expect([GLAB_DYNAMIC_REASON, DYNAMIC_VERB_REASON]).toContain(ask(cmd, g) as string)
  })
  test.each([...MERGE_ALLOW, ...API_ALLOW, ...DYNAMIC_ALLOW])(
    `denyReason allows %j for gate ${name}`,
    cmd => {
      expect(ask(cmd, g)).toBeUndefined()
    },
  )
}

// claude-factory-qn8a.32.15: glab passes only as a command and sub word from a closed list, so these get GLAB_VERB_REASON
const MOVED_VERB = [
  'glab -X PUT -i -- api projects/1/merge_requests/5/merge',
  'glab -F query=@merge.graphql api graphql',
  'glab --input merge.json api graphql',
  "glab --raw-field=query='mutation { mergeRequestAccept(input:{}) { errors } }' api graphql",
  'glab -X PUT -f title=Foo -i -- api projects/1/merge_requests/5',
  'glab -X PUT -f title=Foo api projects/1/merge_requests/5',
  'glab -XPUT -ftitle=Foo api projects/1/merge_requests/5',
  'glab --method=PUT --raw-field=title=Foo api projects/1/merge_requests/5',
  'glab -X PUT --input body.json api projects/1/merge_requests/5',
  'glab -X PUT -i -- api projects/1/merge_requests/5',
  'glab mr -R a/b update 5 --ready',
  'glab mr -r -- update 5',
  'glab mr --ready -- update 5',
  'glab mr -f -- update 5',
  'glab -r -- mr update 5',
  'glab -ry mr update 5',
  'glab --ready=true mr update 5',
  'glab --title=Foo mr update 5',
  'glab -tFoo mr update 5',
  'glab -t Foo mr update 5',
  'glab -yf mr update 5',
  'glab -R a/b mr update 5 --draft',
]
const VERB_DENY = [
  'glab mcp serve',
  'glab duo cli',
  'glab -R g/r mcp serve',
  'glab m 5',
  'glab ci run',
  'glab ci retry 7',
  'glab ci view',
  'glab ci cancel pipeline 1',
  'glab release create v1',
  'glab variable set K v',
  'glab schedule run 1',
  'glab stack sync',
  'glab mr close 5',
  'glab mr delete 5',
  'glab repo delete g/r',
  'glab config set host x',
  'glab auth status --show-token',
  'glab token create t',
  'glab -R a/b mr update 5 --draft',
  'glab mcp serve < .scratch/req.json',
  'cat .scratch/req.json | glab mcp serve',
  'glab',
  'glab --version',
  'glab mr -R a/b list',
  'glab mr --help',
  'glab mr',
  'glab issue',
  'glab repo',
  'glab ci',
  ...MOVED_VERB,
]
const VERB_ALLOW = [
  'glab ci list',
  'glab ci get',
  'glab ci trace 7',
  'glab ci status',
  'glab issue list',
  'glab issue view 1',
  'glab issue note 1 -m x',
  'glab repo view',
  'glab version',
  'glab mr diff 5',
  'glab mr checkout 5',
  'glab mr list > out.txt',
  'glab mr view 5 --comments',
]
for (const g of GATES) {
  const name = JSON.stringify(g)
  test.each(VERB_DENY)(`denyReason denies %j with GLAB_VERB_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_VERB_REASON)
  })
  test.each(VERB_ALLOW)(`denyReason allows %j for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBeUndefined()
  })
}

test('run as `bun src/worker-hook.ts`, glab mcp serve is denied (claude-factory-qn8a.32.15)', async () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'glab mcp serve' } })
  const p = Bun.spawn(['bun', join(import.meta.dir, 'worker-hook.ts')], {
    stdin: new Response(input),
    stdout: 'pipe',
    env: { ...process.env, FACTORY_FROM: 'implement' },
  })
  const out = await new Response(p.stdout).text()
  expect(JSON.parse(out.trim()).hookSpecificOutput).toMatchObject({
    permissionDecision: 'deny',
    permissionDecisionReason: GLAB_VERB_REASON,
  })
}, 20_000)

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
  'glab mr update 5 --draft -y -- --ready',
  'glab mr update 5 --draft -t Foo',
  'glab mr update 5 -- --ready',
  'glab mr update 5 --draft --title=x',
]
const READY_ALLOW = [
  'glab mr update 5 --draft',
  'glab mr update 5 --wip',
  'glab mr update 5 -l bug -a me',
  'glab mr update 5 --target-branch main',
  'glab mr update 5 -yd x --draft',
]

for (const g of NOT_READY_GATES) {
  const name = JSON.stringify(g)
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
// claude-factory-qn8a.33: --fill and -f read text the hook cannot see, so a ready gate now gives GLAB_TEXT_REASON (see worker-hook-qn8a33.test.ts)
const READY_TEXT_MOVED = [
  'glab mr update 5 --fill -y',
  'glab mr update 5 -f',
  'glab mr update 5 --fill -ya --draft',
]
for (const g of READY_GATES) {
  const name = JSON.stringify(g)
  test.each(READY_DENY.filter(c => !READY_TEXT_MOVED.includes(c)))(
    `denyReason allows %j for the ready gate ${name}`,
    cmd => {
      expect(ask(cmd, g)).toBeUndefined()
    },
  )
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
