import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as hook from './worker-hook'

// claude-factory-qn8a.21: a write to the hook source or to .claude/settings(.local).json turns the guard off.
const H = '/f/acme-factory'
const ROOT = '/w/acme'
const R: string = hook.HOOK_CONTROL_REASON ?? 'missing'
const env = { home: '/h/u', xdg: undefined }
const bash = (cmd: string, cwd = ROOT) => hook.denyReason(cmd, ROOT, undefined, { cwd, hookDir: H })
const file = (p: string, cwd = ROOT) => hook.fileWriteReason(p, cwd, env, ROOT, H)

describe('AC1 Write tool, hook dir', () => {
  test.each([
    `${H}/src/worker-hook.ts`,
    `${H}/src/home-guard.ts`,
    `${H}/src/cut.ts`,
    `${H}/package.json`,
    `${H}/SRC/Worker-Hook.ts`,
    `${H}/src/../src/cut.ts`,
  ])('denies %s', p => expect(file(p)).toBe(R))
  test('denies a symlink in root that points into the hook dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'qn21-'))
    try {
      const hd = join(d, 'fac')
      const rt = join(d, 'root')
      mkdirSync(join(hd, 'src'), { recursive: true })
      mkdirSync(rt)
      writeFileSync(join(hd, 'src', 'worker-hook.ts'), '')
      symlinkSync(hd, join(rt, 'l'))
      expect(hook.fileWriteReason(join(rt, 'l', 'src', 'worker-hook.ts'), rt, env, rt, hd)).toBe(R)
    } finally {
      rmSync(d, { recursive: true })
    }
  })
})

describe('AC2 Write tool, settings', () => {
  test.each([
    `${ROOT}/.claude/settings.local.json`,
    `${ROOT}/.claude/settings.json`,
    '.claude/Settings.Local.json',
    '/x/.claude/settings.json',
    `${ROOT}/.claude`,
  ])('denies %s', p => expect(file(p)).toBe(R))
  test('denies a symlink whose real path ends in .claude/settings.json', () => {
    const d = mkdtempSync(join(tmpdir(), 'qn21-'))
    try {
      mkdirSync(join(d, '.claude'))
      writeFileSync(join(d, '.claude', 'settings.json'), '')
      symlinkSync(join(d, '.claude', 'settings.json'), join(d, 'ln'))
      expect(hook.fileWriteReason(join(d, 'ln'), d, env, d, H)).toBe(R)
    } finally {
      rmSync(d, { recursive: true })
    }
  })
})

describe('AC3 Bash, hook dir', () => {
  test.each([
    `echo x > ${H}/src/worker-hook.ts`,
    `cp .scratch/a.ts ${H}/src/`,
    `sed -i s/a/b/ ${H}/src/worker-hook.ts`,
    `tee ${H}/src/home-guard.ts`,
    `dd if=a of=${H}/src/cut.ts`,
    `cp x ${H}`,
    `ln -s ${H} .scratch/l`,
    `cd ${H} && tee x`,
    `env -C ${H} tee x`,
    `git -C ${H} checkout x`,
    `echo x > ${H}/../acme-factory/src/cut.ts`,
    `tee {${H},/x}/src/cut.ts`,
    `tee ${H}/src/*.ts`,
    `tee '${H}/src/worker-hook.ts'`,
    `tee $D/acme-factory/src/x`,
    'tee $D/worker-hook.ts',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test('denies a brace list over the cap (the qn8a.20 guard gives its own reason)', () =>
    expect(bash('tee {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}')).toBeDefined())
  test('denies a git work tree in the hook dir (ty8y gives its own reason)', () =>
    expect(bash(`git --work-tree=${H} checkout x`)).toBeDefined())
  test('denies a backtick path (an earlier guard gives its own reason)', () =>
    expect(bash('tee `pwd`/src/cut.ts')).toBeDefined())
})

describe('AC4 Bash, settings', () => {
  test.each([
    'echo {} > .claude/settings.local.json',
    'tee .claude/settings.json',
    'cp .scratch/s.json .claude/settings.local.json',
    'cd .claude && tee settings.json',
    'tee $D/settings.local.json',
    'mv .scratch/c .claude',
    'tee .claude/settings.*',
    'cd .claude/skills && tee x',
    'tee ".claude"/settings.json',
    'sed -i s/a/b/ ./.claude//settings.json',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test('denies a bare name when the cwd is .claude', () =>
    expect(bash('echo x > settings.json', `${ROOT}/.claude`)).toBe(R))
})

describe('AC3 Bash, a parent of the hook dir', () => {
  test.each([
    'cp -R .scratch/acme-factory /f/',
    'cp -R .scratch/acme-factory /f',
    'cp -R .scratch/f/. /f/',
    'rsync -a .scratch/f/ /f/',
    'tar -C /f -xf a.tar',
    'unzip a.zip -d /f',
    'mv .scratch/acme-factory /f/',
    'cp -R .scratch/root/. /',
    'cd /f && tar -xf a.tar',
    // round 2 (A): copy or extract commands outside the first list
    'ditto .scratch/f /f',
    'bsdtar -C /f -xf a.tar',
    'gtar -C /f -xf a.tar',
    'pax -rw .scratch/f /f',
    'cpio -pdm /f < list',
    '7z x a.7z -o/f',
    'busybox cp -R .scratch/f/. /f/',
    'gcp -R .scratch/f/. /f/',
    'patch -d /f -p0 < p',
    'find .scratch -exec cp -R {} /f/ \\;',
    'git -C /f clone x acme-factory',
    // (B): a bare / that is not the last word
    'tar -C / -xf a.tar',
    'tar -xf a.tar -C / -v',
    'cp -t / -R .scratch/root/.',
    'mv -t / .scratch/f',
    'install -t / x',
    'cp --target-directory=/ -R .scratch/f/.',
    'rsync -a .scratch/root/ / -v',
    'cp -R .scratch/root/. / -v',
    'unzip -d / a.zip',
    // (C): an expansion in an ancestor position
    'cp -R x/. "$HOME"',
    'cp -R x ${HOME}/',
    'cd "$HOME" && tar -xf a.tar',
    // (D): a cd target the guard does not resolve
    'cd && tar -xf a.tar',
    'cd - && tar -xf a.tar',
    'cd .. && cd .. && cd .. && tar -xf a.tar',
    'cd / && tar -xf a.tar',
    'pushd / && tar -xf a.tar',
    'popd && tar -xf a.tar',
    'pushd / -n && tar -xf a.tar',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test.each(['ls -d /', 'find / -name x', 'cat /f/x', 'cd .scratch && ls', 'cd src', 'cp -R x .scratch/y'])(
    'allows %s',
    c => expect(bash(c)).toBeUndefined(),
  )
  test.each([
    ['cd ..', `${ROOT}/src`],
    ['cd ../..', `${ROOT}/src/a`],
    [`cd ${ROOT}/src/..`, ROOT],
  ])('allows %s when it ends at the root', (c, cwd) => expect(bash(c, cwd)).toBeUndefined())
  test('denies cd .. from the root', () => expect(bash('cd ..', ROOT)).toBe(R))
})

describe('AC7 allowed rows', () => {
  test.each([
    'echo x > .scratch/a.txt',
    'tee .scratch/*',
    'cp src/worker-hook.ts .scratch/b.ts',
    'git checkout -- src/worker-hook.ts',
    'git add src/worker-hook.ts',
    'git show origin/main:src/worker-hook.ts',
    `cat ${H}/src/worker-hook.ts`,
    `grep x ${H}/src/cut.ts`,
    'echo x > .vscode/settings.json',
    'echo x > settings.json',
    'ls .claude',
    'cat .claude/settings.json',
    'bun test src/worker-hook.test.ts',
    "bd comment acme-1 'settings.local.json guard'",
    'tee .claude/skills/x/SKILL.md',
  ])('allows %s', c => expect(bash(c)).toBeUndefined())
  test('allows a Write to the root copy of the hook source and a scratch settings.json', () => {
    expect(file(`${ROOT}/src/worker-hook.ts`)).toBeUndefined()
    expect(file(`${ROOT}/.scratch/settings.json`)).toBeUndefined()
    expect(file(`${ROOT}/.claude/skills/x/SKILL.md`)).toBeUndefined()
  })
})

test('reasonName names the reason', () => expect(hook.reasonName(R)).toBe('HOOK_CONTROL_REASON'))

describe('AC6 deny log and AC5 bun flags', () => {
  const HOOK = join(import.meta.dir, 'worker-hook.ts')
  test('a spawned hook with a hostile bunfig and .env in its cwd still denies, and logs the reason name', () => {
    const home = mkdtempSync(join(tmpdir(), 'qn21h-'))
    const cwd = mkdtempSync(join(tmpdir(), 'qn21c-'))
    try {
      mkdirSync(join(home, 'runs', 'r1'), { recursive: true })
      writeFileSync(join(cwd, 'pre.ts'), 'process.exit(0)\n')
      writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./pre.ts"]\n')
      writeFileSync(join(cwd, '.env'), 'FACTORY_HOME=/nonexistent\n')
      const e: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PROJECT_DIR: cwd,
        FACTORY_HOME: home,
        FACTORY_RUN: 'r1',
        FACTORY_FROM: 'implement',
        FACTORY_OUTBOX: undefined,
        FACTORY_SELF_UPDATE: '0',
      }
      const go = (input: unknown) =>
        Bun.spawnSync(['bun', '--no-env-file', '--config=/dev/null', HOOK, '--harness', 'claude'], {
          cwd,
          stdin: Buffer.from(JSON.stringify(input)),
          env: e,
        }).stdout.toString()
      const b = go({ tool_name: 'Bash', cwd, tool_input: { command: 'tee .claude/settings.json' } })
      expect(JSON.parse(b).hookSpecificOutput.permissionDecision).toBe('deny')
      const w = go({
        tool_name: 'Write',
        cwd,
        tool_input: { file_path: join(cwd, '.claude', 'settings.local.json') },
      })
      expect(JSON.parse(w).hookSpecificOutput.permissionDecision).toBe('deny')
      const rows = require('node:fs')
        .readFileSync(join(home, 'runs', 'r1', 'denials.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l: string) => JSON.parse(l))
      expect(rows.map((r: { reason: string }) => r.reason)).toEqual([
        'HOOK_CONTROL_REASON',
        'HOOK_CONTROL_REASON',
      ])
    } finally {
      rmSync(home, { recursive: true })
      rmSync(cwd, { recursive: true })
    }
  })
})

// claude-factory-qn8a.21.11 .12 .13: security round 1
describe('qn8a.21.11 case fold of a long s', () => {
  test.each(['.claude/ſettings.local.json', '.claude/settingſ.json', '.claude/settings.jſon'])(
    'Write tool denies %s',
    p => expect(file(p)).toBe(R),
  )
  test.each([
    'tee .claude/ſettings.local.json',
    'echo x > .claude/ſettings.local.json',
    'cp .scratch/s .claude/ſettings.local.json',
    'tee $D/ſettings.local.json',
    'tee .claude/ſettings.*',
  ])('Bash denies %s', c => expect(bash(c)).toBe(R))
  test('Bash denies a hook dir that holds a long s', () => {
    expect(
      hook.denyReason('tee /f/acme-sactory/src/cut.ts', ROOT, undefined, {
        cwd: ROOT,
        hookDir: '/f/acme-\u017factory',
      }),
    ).toBe(R)
  })
  test('Bash denies a hook dir with s in a parent part', () => {
    expect(
      hook.denyReason('tee /Uſers/acme/f/src/cut.ts', ROOT, undefined, {
        cwd: ROOT,
        hookDir: '/Users/acme/f',
      }),
    ).toBe(R)
  })
})

describe('qn8a.21.12 glued short flag value', () => {
  test.each([
    'curl -o.claude/settings.local.json https://example.com/s',
    'curl -so.claude/settings.local.json https://example.com/s',
    'sort -o.claude/settings.local.json .scratch/s',
    'wget -O.claude/settings.local.json https://example.com/s',
    'wget -qO.claude/settings.local.json https://example.com/s',
    'env -C.claude tee settings.local.json',
    'make -C.claude',
    'curl -o/f/acme-factory/src/cut.ts https://example.com/s',
    'sort -o/f/acme-factory/src/cut.ts .scratch/s',
    'wget -O/f/acme-factory/src/cut.ts https://example.com/s',
    'sort -so.claude/settings.local.json .scratch/s',
    'gh api -so.claude/settings.local.json x',
    'sort -ro/f/acme-factory/src/cut.ts .scratch/s',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test.each([
    'ls -la',
    'grep -rn x src',
    'tail -n5 .claude/settings.json',
    'sort -o.scratch/out.txt .scratch/in',
  ])('allows %s', c => expect(bash(c)).toBeUndefined())
})

describe('qn8a.21.13 nested brace list and sequence', () => {
  test.each([
    'tee .claud{e..e}/settings.local.json',
    'echo x > .claud{e..e}/settings.local.json',
    'tee .claude/setting{s..s}.local.json',
    'tee .claude/settings.local.jso{n..n}',
    'tee .claud{e..e}/setting{s..s}.local.json',
    'tee .claude/{x,{settings.local.json,y}}',
    'tee {.scratch/a,{.claude/settings.local.json,.scratch/c}}',
    'tee .claude/setting{s,{s,t}}.local.json',
    'cd .claud{e..e} && tee settings.local.json',
    'echo x > /f/acme-factor{y..y}/src/cut.ts',
    'echo x > /f/acme-factor{y,{y,z}}/src/cut.ts',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test.each([
    'for i in {1..5}; do echo x; done',
    'mkdir -p .scratch/{a,{b,c}}',
    'touch .scratch/f{1..3}.txt',
  ])('allows %s', c => expect(bash(c)).toBeUndefined())
})

describe('qn8a.21.14 unmatched brace and padded sequence', () => {
  test.each([
    'tee {/../.claude/settings.local.jso{n,}',
    'tee x{/../.claude/settings.local.json{a,}',
    'tee {/../.claude/settings.local.jso{n..n}',
    'tee x{/../.claud{e..e}/settings.local.json',
    'tee x{/../.claude/{settings.local.json,y}',
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test.each(['echo x > /f/acme-{001..001}/src/cut.ts', 'echo x > /f/acme-{-01..1}/src/cut.ts'])(
    'denies %s with a padded hook dir',
    c => expect(hook.denyReason(c, ROOT, undefined, { cwd: ROOT, hookDir: '/f/acme-001' })).toBe(R),
  )
  test.each(['touch .scratch/f{01..03}.txt', 'mkdir -p .scratch/{a,b}', 'cp .scratch/a{,.bak}'])(
    'allows %s',
    c => expect(bash(c)).toBeUndefined(),
  )
  test.each([
    "tee '/f/{,}/../acme-factory/src/worker-hook.ts'",
    "tee '/f/acme-factory/{,}/../src/worker-hook.ts'",
    'tee "/f/acme-factory/{,}/../src/worker-hook.ts"',
    'tee /f/acme-factory/\\{,\\}/../src/worker-hook.ts',
    "echo x > '/f/acme-factory/{,}/../src/cut.ts'",
    "cp a '/f/acme-factory/{,}/../src/cut.ts'",
  ])('qn8a.21.16 denies the literal quoted brace %s', c => expect(bash(c)).toBe(R))
  test('expandBraces unit rows', () => {
    expect(hook.expandBraces('{a{b,c}')).toEqual(['{ab', '{ac'])
    expect(hook.expandBraces('{001..003}')).toEqual(['001', '002', '003'])
    expect(hook.expandBraces('{08..10}')).toEqual(['08', '09', '10'])
    expect(hook.expandBraces('{-01..1}')).toBeUndefined()
  })
})

describe('qn8a.21.15 glued flag value after any flag char', () => {
  const u = 'https://example.com/s'
  test.each([
    `curl -4o.claude/settings.local.json ${u}`,
    `curl -#o.claude/settings.local.json ${u}`,
    `wget -4O.claude/settings.local.json ${u}`,
    `curl -sSfLkvRo.claude/settings.local.json ${u}`,
    `curl -4o/f/acme-factory/src/cut.ts ${u}`,
    'curl -s4o.claude/settings.local.json file:///etc/hosts',
    `curl -${'a'.repeat(1024)} ${u}`,
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test.each([
    'tail -n5 .claude/settings.json',
    'ls -la',
    'grep -rn x src',
    'git log -n5',
    'curl -sSfLo .scratch/a https://example.com/s',
    `curl -${'a'.repeat(1022)} https://example.com/s`,
  ])('allows %s', c => expect(bash(c)).toBeUndefined())
  test('denies a one-char tail that is the cwd', () => {
    expect(bash('curl -so. https://example.com/s', `${ROOT}/.claude`)).toBe(R)
  })
})

describe('qn8a.21.17 work bound', () => {
  test.each([
    'x -' + '{'.repeat(1010) + '{1..64}',
    'true -' + '{'.repeat(1040) + '{1..64}; git push origin HEAD:main',
    'tee ' + '{'.repeat(8000) + '{1..64}',
    'curl -' + 'a'.repeat(1000) + '{1..64} https://example.com/s',
    Array.from({ length: 7 }, () => 'tee ' + '{'.repeat(900) + '{1..64}').join('; '),
    'echo ' + "'{'{1..64} ".repeat(740) + '; git push origin HEAD:main',
    'echo ' + '\\{{1..64} '.repeat(810) + '; git push origin HEAD:main',
  ])('answers fast and does not allow %#', cmd => {
    const t = Date.now()
    const r = bash(cmd)
    expect(Date.now() - t).toBeLessThan(1000)
    expect(r).toBeDefined()
  })
  test('a short brace list still allows', () =>
    expect(bash('mkdir -p .scratch/{a,b}; touch f{01..03}.txt')).toBeUndefined())
})

describe('qn8a.21.18 a brace list that expands to a flag word', () => {
  const S = '.claude/settings.local.json'
  const U = 'https://example.com/s'
  test.each([
    `curl {-s,-o${S}} ${U}`,
    `curl {-o${S},-s} ${U}`,
    `curl {-o,-s} ${S} ${U}`,
    `git diff {--output,-p} ${S}`,
    `curl {-s,-so${S}} ${U}`,
    `wget {-q,-O${S}} ${U}`,
    `sort {-u,-o${S}} x`,
    `curl {-s,-o${H}/src/cut.ts} ${U}`,
    `make {-C.claude,-s}`,
    `dd {if=x,of=${S}}`,
    `dd if=x o{f,f}=${S}`,
    `dd if=x {of,of}=${S}`,
    `curl {--output=${S},-s} ${U}`,
    `curl --out{put,put}=${S} ${U}`,
    `curl {-s,--output=${H}/src/cut.ts} ${U}`,
    `git diff {--output=${S},-p}`,
    `git diff {-p,--output=${S}}`,
    `gh api x {--jq=.,-o${S}}`,
    `bd export {-q,-o${S}}`,
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test.each(['curl {-s,-o.scratch/a} https://example.com/s', 'ls {-l,-a}'])('allows %s', c =>
    expect(bash(c)).toBeUndefined(),
  )
})

describe('qn8a.21.19 a quoted or escaped brace inside a list', () => {
  const S = 'settings.local.json'
  test.each([
    `tee .claude/{${S},'{'}`,
    `tee .claude/{${S},'}'}`,
    `tee .claude/{${S},"}"}`,
    `tee .claude/{${S},}}`,
    `tee .claude/{'}',${S}}`,
    `tee .claude/settings.local.jso{n,'}'}`,
    `tee {.claude,'{'}/${S}`,
    `tee .claude/{${S},'{',x}`,
    `tee .claude/{x,{${S},'}'}}`,
    `cd {.claude,'}'}`,
    `curl -o.claude/{${S},'}'} https://example.com/s`,
  ])('denies %s', c => expect(bash(c)).toBe(R))
  test.each([
    `jq '{a:1}' x.json`,
    `awk '{print $1}' x`,
    `find . -name '*.ts' -exec cp {} .scratch/ \\;`,
    `git commit -m 'fix {a,b}'`,
    `cp x .scratch/{a,b}`,
    // bash and zsh keep an unclosed list as text: the file name is not settings.local.json
    `tee .claude/{settings.local.json,{}`,
  ])('allows %s', c => expect(bash(c)).toBeUndefined())
})

describe('qn8a.122 bounded worker cache copy', () => {
  const MC = '/node_modules/@huggingface/transformers/.cache'
  type Fx = { root: string; hd: string }
  const A: Fx = { root: '/workspace/w/repo', hd: '/opt/factory' }
  const B: Fx = { root: ROOT, hd: H }
  const run = (c: string, f = B) => hook.denyReason(c, f.root, undefined, { cwd: f.root, hookDir: f.hd })
  const cp = (f: Fx) => `cp -R ${f.hd}${MC} ${f.root}${MC}`
  const S = `${H}${MC}`
  const D = `${ROOT}${MC}`

  test.each([
    [cp(A), A],
    [cp(B), B],
    [`cp -R '${A.hd}${MC}' '${A.root}${MC}'`, A],
    [`cp -R "${B.hd}${MC}" "${B.root}${MC}"`, B],
    [`\\${cp(A)}`, A],
    [`'cp' -R ${B.hd}${MC} ${B.root}${MC}`, B],
    [`(${cp(B)})`, B],
    [`${cp(B)} &`, B],
  ])('allows the cache copy %s', (c, f) => expect(run(c, f)).toBeUndefined())

  test.each([
    `cp -R ${D} ${S}`,
    `cp -R ${H}/src ${D}`,
    `cp -R ${H}/node_modules ${D}`,
    `cp -R ${S}`,
    `cp -R ${S} ${D} x`,
    `cp ${S} ${D}`,
    `cp -t ${D} ${S}`,
    `cp -R -t ${D} ${S}`,
    `cp -R --target-directory ${D} ${S}`,
    `cp -R --target-directory=${D} ${S}`,
    `cp -T ${S} ${D}`,
    `cp -R -T ${S} ${D}`,
    `cp -R --backup ${S} ${D}`,
    `cp -R -- ${S} ${D}`,
    `cp -RL ${S} ${D}`,
    `cp -r ${S} ${D}`,
    `cp -a ${S} ${D}`,
    `mv ${S} ${D}`,
    `ln -s ${S} ${D}`,
    `rsync -a ${S} ${D}`,
    `gcp -R ${S} ${D}`,
    `busybox cp -R ${S} ${D}`,
    `env cp -R ${S} ${D}`,
    `command cp -R ${S} ${D}`,
    `/bin/cp -R ${S} ${D}`,
    `sudo cp -R ${S} ${D}`,
    `cp -R ${H}/node_modules/{@huggingface/transformers/.cache,x} ${D}`,
    `cp -R ${H}/node_modules/@huggingface/transformers/.c$X ${D}`,
    `cp -R $(echo ${S}) ${D}`,
    `cp -R ${H}/node_modules/@huggingface/../@huggingface/transformers/.cache ${D}`,
    `cp -R ${S}/ ${D}`,
    `cp -R ${H}/node_modules/@HuggingFace/transformers/.cache ${D}`,
    `cp -R ${S} ${D}/`,
    `cp -R ${S} ${D}*`,
    `cp -R ${S} ${ROOT}${MC}/../../../.claude`,
    `cp -R ${S} ${ROOT}${MC}/../../../../.git`,
    `cp -R ${S} /w/other${MC}`,
    `cp -R ${S} node_modules/@huggingface/transformers/.cache`,
    `${cp(B)} && tee ${H}/src/cut.ts`,
    `${cp(B)}; cp -R ${S} ${H}/src`,
    `${cp(B)} | tee ${H}/package.json`,
    `${cp(B)} > ${H}/src/cut.ts`,
    `${cp(B)} 2>&1`,
    `alias cp='echo'; ${cp(B)}`,
  ])('denies %s', c => expect(run(c)).toBeDefined())

  test('denies a root with a trailing slash', () =>
    expect(
      hook.denyReason(`cp -R ${H}${MC} ${ROOT}/${MC}`, `${ROOT}/`, undefined, { cwd: ROOT, hookDir: H }),
    ).toBeDefined())
  test('denies a root with a space', () =>
    expect(run(`cp -R ${H}${MC} /w/a b${MC}`, { root: '/w/a b', hd: H })).toBeDefined())
  test.each([
    ['/w/../acme', H],
    ['/w/./acme', H],
  ])('denies a dot component in root %s with hookDir %s', (r, h) =>
    expect(run(`cp -R ${h}${MC} ${r}${MC}`, { root: r, hd: h })).toBeDefined(),
  )
  test('denies a hookDir with a plus', () =>
    expect(run(`cp -R /f/a+b${MC} ${D}`, { root: ROOT, hd: '/f/a+b' })).toBeDefined())
  test('keeps allowing the cache copy when root equals hookDir', () =>
    expect(run(`cp -R ${H}${MC} ${H}${MC}`, { root: H, hd: H })).toBeUndefined())
  test('keeps allowing ordinary rows', () => {
    expect(run(`cp -R x .scratch/y`)).toBeUndefined()
    expect(run(`cat ${H}/src/worker-hook.ts`)).toBeUndefined()
  })

  test.each(['parent', 'leaf'])('denies a %s symlink from the destination into the hook source', kind => {
    const d = mkdtempSync(join(tmpdir(), 'qn122-'))
    try {
      const hd = join(d, 'fac')
      const rt = join(d, 'root')
      mkdirSync(join(hd, 'src'), { recursive: true })
      mkdirSync(join(hd, 'node_modules', '@huggingface', 'transformers', '.cache'), { recursive: true })
      const par = join(rt, 'node_modules', '@huggingface')
      mkdirSync(kind === 'parent' ? join(rt, 'node_modules') : join(par, 'transformers'), { recursive: true })
      if (kind === 'parent') symlinkSync(join(hd, 'src'), par)
      else symlinkSync(join(hd, 'src'), join(par, 'transformers', '.cache'))
      const c = `cp -R ${hd}${MC} ${rt}${MC}`
      expect(hook.denyReason(c, rt, undefined, { cwd: rt, hookDir: hd })).toBeDefined()
    } finally {
      rmSync(d, { recursive: true })
    }
  })

  const prot = (f: Fx) => [
    f.hd,
    '/opt',
    `${f.hd}/src`,
    `${f.hd}/node_modules`,
    `${f.hd}/node_modules/@huggingface`,
    `${f.hd}/package.json`,
    `${f.root}/.claude`,
    `${f.root}/.claude/settings.json`,
    `${f.root}/.claude/settings.local.json`,
    `${f.root}/.cursor`,
    `${f.root}/.cursor/hooks.json`,
    `${f.root}/.grok`,
    `${f.root}/.git`,
    `${f.root}/.git/config`,
    `${f.hd}/shell-snapshots`,
    `${f.hd}/rigs.json`,
    `${f.hd}/worker-settings.json`,
    `${f.hd}/inbox.jsonl`,
    `${f.hd}/state.json`,
  ]
  test.each(prot(A))('still denies a cache source copy into %s', p =>
    expect(run(`cp -R ${A.hd}${MC} ${p}`, A)).toBeDefined(),
  )
})
