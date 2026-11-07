import { expect, test } from 'bun:test'
import {
  denyReason,
  GITLAB_PUSH_OPTION_REASON,
  GLAB_QUICK_ACTION_REASON,
  GLAB_TEXT_REASON,
  PUSH_REASON,
} from './worker-hook'

// claude-factory-qn8a.33: GitLab runs a /approve or /merge line in a note or description as a quick action.
const FILES: Record<string, string> = {}
const GATES: Record<string, unknown>[] = [
  {},
  { station: 'implement' },
  { station: 'review' },
  { station: 'release' },
  { station: 'review', reviewer: true },
  { factory: 'ship', station: 'release', mergeAuthority: 'acme/widget' },
]
const READY_GATES = GATES.filter(g => ['review', 'release'].includes(g.station as string))
const ask = (cmd: string, g: Record<string, unknown>) =>
  denyReason(cmd, undefined, undefined, { readFile: (p: string) => FILES[p], ...g })

const DENIED_LINES = [
  '/approve',
  '/merge',
  '/ready',
  '/draft',
  '/wip',
  '/submit_review approve',
  '/APPROVE',
  '  /approve',
  '/approve.',
  '/tmp',
  '​/approve',
  '﻿/merge',
]
const ALLOWED_LINES = [
  '/Users/a/b',
  '/approve/',
  '- /approve',
  'ok /approve',
  'do not /merge',
  '/1',
  'looks good',
]
const q = (s: string) => `'${s}'`

const QA_DENY = [
  ...DENIED_LINES.map(l => `glab mr note 5 -m ${q(l)}`),
  ...DENIED_LINES.map(l => `glab mr note 5 -m ${q('ok\n' + l)}`),
  'glab mr note 5 -m /approve',
  'glab mr note 5 -m /merge',
  'glab mr note 5 -m /ready',
  'glab mr note 5 --message=/approve',
  'glab mr note 5 --message /approve',
  'glab mr note 5 -m=/approve',
  'glab mr note 5 -m/approve',
  'glab mr note create 5 -m /approve',
  'glab mr note update 9 5 -m /merge',
  'glab mr note 5 -m ok -m /approve',
  'glab mr note 5 --unique -m /approve',
  'glab mr create --draft -t x -d /merge',
  'glab mr create --draft -t x --description=/ready',
  'glab mr create --draft -t x -yd /approve',
  'glab mr update 5 -d /ready',
  'glab mr update 5 --description /approve',
]
const ALLOW = [
  ...ALLOWED_LINES.map(l => `glab mr note 5 -m ${q(l)}`),
  ...ALLOWED_LINES.map(l => `glab mr note 5 -m ${q('ok\n' + l)}`),
  'glab mr note 5 -m "looks good"',
  `glab mr note 5 -m 'a $b'`,
  `glab mr note 5 -m 'see /Users/a/b'`,
  'glab mr note list 5',
  'glab mr note resolve abc12345 5',
  'glab mr note 5 --help',
  'glab mr create --draft -t x -d y',
  'glab mr create -t x -m v1.0 -d ok',
]
const TEXT_DENY = [
  'glab mr create --draft -t x -d -',
  'glab mr create --fill',
  'glab mr create --fill -y',
  'glab mr create -fy',
  'glab mr create --fill-commit-body',
  'glab mr create --template a.md',
  'glab mr create --template=a',
  'glab mr create --recover',
  'glab mr note 5 --message="$MSG"',
  'glab mr update 5 --description="$D"',
  'glab mr update 5 --draft --description="$D"',
  'glab mr note 5',
  'glab mr note create 5',
]
const READY_ONLY_ALLOW = ['glab mr update 5 -yd x --draft', 'glab mr update 5 -t Foo -yd --draft']
const READY_TEXT_DENY = [
  'glab mr update 5 --draft --fill',
  'glab mr update 5 --fill -y',
  'glab mr update 5 -f',
  'glab mr update 5 --fill -ya --draft',
]

for (const g of GATES) {
  const name = JSON.stringify(g)
  test.each(QA_DENY)(`denies %j with GLAB_QUICK_ACTION_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_QUICK_ACTION_REASON)
  })
  test.each(TEXT_DENY)(`denies %j with GLAB_TEXT_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_TEXT_REASON)
  })
  test.each(ALLOW)(`allows %j for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBeUndefined()
  })
}
for (const g of READY_GATES) {
  const name = JSON.stringify(g)
  test.each(READY_ONLY_ALLOW)(`allows %j for the ready gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBeUndefined()
  })
  test.each(READY_TEXT_DENY)(`denies %j with GLAB_TEXT_REASON for the ready gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_TEXT_REASON)
  })
}

// raw backstop: a quote that holds a newline or a carriage return
const RAW_DENY = [
  "glab mr note 5 -m 'ok\n/approve'",
  "glab mr note 5 -m 'ok\n  /merge'",
  'glab mr note 5 -m "ok\r/approve"',
  'glab mr view 5\n/approve',
  "glab mr note 5 -m 'ok\\\n' ; echo x\n/ready",
]
const RAW_ALLOW = ["glab mr note 5 -m 'ok\nsee /Users/a'", 'glab mr view 5\n/usr/bin/true']
for (const g of GATES) {
  const name = JSON.stringify(g)
  test.each(RAW_DENY)(`raw backstop denies %j for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_QUICK_ACTION_REASON)
  })
  test.each(RAW_ALLOW)(`raw backstop allows %j for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBeUndefined()
  })
}

// glab api form W: the field text of a note or merge request create call
FILES['n.md'] = 'ok\n/approve\n'
FILES['ok.md'] = 'looks good'
const NOTE = 'projects/1/merge_requests/5/notes'
const API_QA_DENY = [
  `glab api -X POST ${NOTE} -f body=/merge`,
  `glab api -X POST ${NOTE} --raw-field body=/approve`,
  `glab api -X POST ${NOTE} -F body=/ready`,
  `glab api -X POST ${NOTE} --field=body=/approve`,
  `glab api -X POST ${NOTE} -F body=@n.md`,
  'glab api -X POST projects/1/merge_requests -f title=x -f description=/merge',
]
const API_TEXT_DENY = [
  `glab api -X POST ${NOTE} -F body=@-`,
  `glab api -X POST ${NOTE} -F body=@missing.md`,
  `glab api -X POST ${NOTE} -F body=@~/n.md`,
  `printf x > ok.md; glab api -X POST ${NOTE} -F body=@ok.md`,
  `glab api -X POST ${NOTE} -F body=@ok.md && echo done`,
  `bash -c 'glab api -X POST ${NOTE} -F body=@ok.md'`,
]
const API_ALLOW = [
  'glab api --method POST projects/:id/merge_requests/5/notes -F body=@ok.md',
  `glab api --method POST ${NOTE} -F body=@ok.md > out.json`,
  `glab api -X POST ${NOTE} -f body=@n.md`,
  `glab api -X POST ${NOTE} -f body=x`,
  `glab api -X POST ${NOTE} -f body='see /Users/a'`,
]
for (const g of GATES) {
  const name = JSON.stringify(g)
  test.each(API_QA_DENY)(`denies %j with GLAB_QUICK_ACTION_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_QUICK_ACTION_REASON)
  })
  test.each(API_TEXT_DENY)(`denies %j with GLAB_TEXT_REASON for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBe(GLAB_TEXT_REASON)
  })
  test.each(API_ALLOW)(`allows %j for gate ${name}`, cmd => {
    expect(ask(cmd, g)).toBeUndefined()
  })
  test.each([
    `glab api -X POST ${NOTE} -F body=@-`,
    `printf x > ok.md; glab api -X POST ${NOTE} -F body=@ok.md`,
    `glab api -X POST ${NOTE} -F body=@ok.md && echo done`,
    `bash -c 'glab api -X POST ${NOTE} -F body=@ok.md'`,
  ])(`reads no file for %j at gate ${name}`, cmd => {
    // the endpoint operand is read by an older guard; this guard must read no @file path
    const seen: string[] = []
    denyReason(cmd, undefined, undefined, {
      readFile: (p: string) => {
        seen.push(p)
        return 'x'
      },
      ...g,
    })
    expect(seen.filter(p => p === 'ok.md' || p === '-')).toEqual([])
  })
}

// git push options: a merge_request push option can merge an MR or run a quick action
const PUSH_GATES = [{ headOf: () => 'factory/x' }, { headOf: () => 'factory/x', originHead: () => 'main' }]
const PUSH_DENY = [
  'git push -o merge_request.description=/approve origin HEAD',
  'git push -o merge_request.merge_when_pipeline_succeeds origin HEAD',
  'git push -o merge_request.auto_merge origin HEAD',
  'git push -o MERGE_REQUEST.AUTO_MERGE origin HEAD',
  'git push -o mr.auto_merge origin HEAD',
  'git push --push-option=merge_request.auto_merge origin HEAD',
  'git push --push-option merge_request.squash origin HEAD',
  'git push --push-o=merge_request.auto_merge origin HEAD',
  'git push --pu=merge_request.auto_merge origin HEAD',
  'git send-pack --push-option=merge_request.auto_merge origin HEAD',
  'git push -o merge_request.create -o merge_request.merge_when_pipeline_succeeds origin HEAD',
]
const PUSH_ALLOW = [
  'git push origin HEAD',
  'git push -o ci.skip origin HEAD',
  'git push -o merge_request.create -o merge_request.target=main origin HEAD',
  'git push -o merge_request.title=x origin HEAD',
  "git push -o 'merge_request.description=fix bug' origin HEAD",
  'git push -o merge_request.draft origin HEAD',
]
const CONFIG_DENY = [
  'git config push.pushOption merge_request.auto_merge',
  'git config --add push.pushoption ci.skip',
  'git -c push.pushOption=ci.skip push origin HEAD',
  'git --config-env push.pushOption=X push origin HEAD',
  'git --config-env=push.pushOption=X push origin HEAD',
]
for (const g of PUSH_GATES) {
  const gitAsk = (c: string) => denyReason(c, undefined, undefined, g)
  test.each(PUSH_DENY)('denies push option %j with GITLAB_PUSH_OPTION_REASON', cmd => {
    expect(gitAsk(cmd)).toBe(GITLAB_PUSH_OPTION_REASON)
  })
  test.each(PUSH_ALLOW)('allows push option %j', cmd => {
    expect(gitAsk(cmd)).toBeUndefined()
  })
  test.each(CONFIG_DENY)('denies %j with PUSH_REASON', cmd => {
    expect(gitAsk(cmd)).toBe(PUSH_REASON)
  })
  test('allows git config --get push.pushOption', () => {
    expect(gitAsk('git config --get push.pushOption')).toBeUndefined()
  })
}
