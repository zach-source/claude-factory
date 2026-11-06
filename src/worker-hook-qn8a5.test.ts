// claude-factory-qn8a.5: redirects, brace groups, here-documents and zsh forms must not hide the command word.
import { expect, test } from 'bun:test'
import {
  denyReason,
  FACTORY_CONTROL_REASON,
  FUNSUB_REASON,
  HEREDOC_REASON,
  MERGE_REASON,
  PUSH_REASON,
  REASON,
} from './worker-hook.ts'

const G = {
  headOf: () => 'factory/x',
  ghAliases: () => new Map<string, string>(),
  gitAliases: () => new Map<string, string>(),
}
const ask = (c: string, root = '/root/repo') => denyReason(c, root, ['x'], G)

// T1: instances that already deny on origin/main. Each row pins the verdict.
const PINNED: [string, string][] = [
  ['wy40', '$X -u root =(cat f) ../x'],
  ['wy40', '$X -u root >(cat f) ../x'],
  ['0om8', '{fd}>f rm -rf /'],
  ['0om8', '{fd}>/dev/null rm -rf /'],
  ['0om8', '{fd}<f rm -rf /'],
  ['0om8', '{fd}>>f rm -rf /'],
  ['0om8', '{fd}>&- rm -rf /'],
  ['0om8', '>&- rm -rf /'],
  ['0om8', '2>&- rm -rf /'],
  ['9bal', 'set -- rm -r ./d; "$@"'],
  ['9bal', 'set -- rm -r ./d\n"$@"'],
  ['9bal', 'set -- rm; $1 -r ./d'],
  ['9bal', 'set -- "rm -rf /"; $1'],
  ['9bal', "set -- ' push origin HEAD:main'; git$1"],
  ['9bal', "set -- ' push origin HEAD:main'; git${1}"],
  ['9bal', "set -- ' push origin HEAD:main'; git$@"],
  ['9bal', "set -- ' push origin HEAD:main'; git$*"],
  ['3s1w', "rm$(case a in a) printf ' ';; esac)-rf /"],
  ['3s1w', "rm$(printf ' ' #\n)-rf /"],
  ['iyca', 'sudo -n rm -rf /'],
  ['iyca', 'sudo -E rm -rf /'],
  ['iyca', '{ rm -rf /; }'],
  ['9qvg', 'repeat 1 2>&1 rm -rf /'],
  ['9qvg', 'repeat 1 <f rm -rf /'],
  ['9qvg', 'repeat 1 >f rm -rf /'],
  ['9qvg', 'repeat 1 2>f rm -rf /'],
  ['9qvg', 'repeat 1 { 2>/dev/null rm -rf / }'],
  ['9qvg', 'repeat 1 {2>&1 rm -rf / }'],
  ['dvpe', '{rm -rf / }'],
  ['dvpe', '{rm -rf /; }'],
  ['dvpe', 'true && {rm -rf / }'],
  ['dvpe', 'for x (a) {rm -rf / }'],
  ['dvpe', 'for x in a; {rm -rf / }'],
  ['dvpe', 'case a in a) {rm -rf / };; esac'],
  ['6sz8', '=rm -rf /'],
  ['6sz8', 'sudo =rm -rf /'],
  ['upag', '"d"=1/rm -r ./d'],
  ['upag', "'d'=1/rm -r ./d"],
  ['upag', 'd"="1/rm -r ./d'],
  ['upag', 'd\\=1/rm -r ./d'],
  ['upag', '"d=1"/rm -r ./d'],
  ['upag', 'A=1 "d"=1/rm -r ./d'],
  ['fmeu', '{ rm -rf /; }'],
  ['fmeu', '{ A=x rm -rf /; }'],
  ['fmeu', '{ A+=x rm -rf /; }'],
  ['fmeu', '{ é=1/rm -r ./d; }'],
  ['7evi', 'rm =ls'],
  ['tyz6', '- rm -r ./d'],
  ['tyz6', 'A+=x - rm -r ./d'],
  ['tyz6', '- $G $V origin main'],
  ['tyz6', 'A=1; - rm -r ./d'],
  ['4a4o', 'rm>/dev/null -rf /'],
  ['4a4o', 'gh>/dev/null pr merge 1'],
  ['4a4o', '>f rm -rf /'],
  ['4a4o', '> f rm -rf /'],
  ['4a4o', 'true &>/dev/null rm -rf /'],
  ['4a4o', 'git push>f origin main'],
  ['4a4o', 'gh pr>f merge 1'],
  ['4a4o', 'sudo>f rm -rf /'],
]
for (const [id, c] of PINNED)
  test(`${id} denies ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBeTruthy()
  })

// ymvm: the zsh force-clobber redirect with a space. The home guard reads HOME.
for (const c of [
  'echo x >! ~/.gitconfig',
  'echo x >>! ~/.gitconfig',
  'echo x >! ~/.gitc*',
  'echo x >!~/.gitc*',
])
  test(`ymvm denies ${c}`, () => {
    const home = process.env.HOME
    process.env.HOME = '/Users/widget'
    try {
      expect(ask(c, '/Users/widget/r/acme/widget')).toBeTruthy()
    } finally {
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    }
  })

for (const c of [
  'echo {a,b}',
  'find . -exec ls {} +',
  'rm a=b',
  'rm ./=x',
  'A=1 ls',
  'echo "d"=1',
  'ls >f',
  'git log >f',
  'gh api x > f',
  '{ echo x; }',
  'echo hi >! f',
  'set -- a b; echo "$@"',
  'echo a$(date)b',
  'ls a$(case a in a) printf x;; esac)b',
])
  test(`allows ${c}`, () => {
    expect(ask(c)).toBeUndefined()
  })

// KNOWN GAP (claude-factory-9bal): a lone positional head allows. It is the same rule as a lone
// $X head: in a one-segment command nothing sets the list, and a fresh Bash tool shell has an empty one.
// `ls; "$@"` and every `set -- ...; "$@"` row deny (see PINNED).
for (const c of ['"$@"', '$@', '${@}', '"${@}"', '$1', '${1}'])
  test(`known gap 9bal allows ${c}`, () => {
    expect(ask(c)).toBeUndefined()
  })

// KNOWN GAP (claude-factory-3sgg): a here-document or $(( << )) with a quote and more text
// after it denies. These are fail-closed false denies. An exact here-doc parser failed 8 rounds
// (claude-factory-wmsr.4 to .30), so they stay.
for (const c of [
  "cat <<'EOF' > f\nit's\nEOF\ngit add f",
  "cat > notes.md <<'EOF'\n# it's a title\nEOF\nls",
  'x=$((1<<2))\necho $x',
])
  test(`known gap 3sgg denies ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBe(HEREDOC_REASON)
  })

// T3 (F2): the glued zsh `&!` separator. The `!` belongs to the separator, not to the next word.
for (const [c, want] of [
  ['echo a &!rm -rf /', REASON],
  ['echo a&!rm -rf /', REASON],
  ['echo a &\\\n!rm -rf /', REASON],
  ['echo a &!git push origin main', PUSH_REASON],
  ['echo a &!gh pr merge 1', MERGE_REASON],
  ['echo a &!factory say hi', FACTORY_CONTROL_REASON],
] as const)
  test(`F2 denies ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBe(want)
  })
for (const c of [
  'ls &',
  'echo a & ls',
  'echo a &!ls',
  'echo a &! ls',
  'echo hi >&! f',
  'echo hi >>&! f',
  'ls &>/dev/null',
  'echo "a &!x"',
  "echo 'a &!rm -rf /'",
])
  test(`F2 allows ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBeUndefined()
  })

// T4 (F1): bash 5.3 `${ cmd; }` and `${| cmd; }` run cmd. The raw rule denies `${` + blank or `|`.
for (const c of [
  'echo ${ rm -rf /; }',
  'cat ${ rm -r src; }',
  'echo "${ rm -rf /; }"',
  'echo ${\trm -rf /; }',
  'echo a${ rm -rf /; }b',
  'sudo -u ${ echo root; rm;} -rf /',
  'sudo -u ${ |REPLY=rm;} -rf /',
  'echo ${\\\n rm -rf /; }',
  'echo $\\\n{ rm -rf /; }',
  'x=${ rm -rf /; }',
  'echo ${ git push origin main; }',
  'echo ${|rm -rf /; }',
  "bash -c 'echo ${ rm -rf /; }'",
  // Accepted false deny: the rule reads single quotes as raw text too.
  "echo '${ x }'",
])
  test(`F1 denies ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBe(FUNSUB_REASON)
  })
for (const c of ['echo ${X}', 'echo ${X:-y}', 'echo ${#X}', 'echo "${X}"', 'echo ${(L)X}', 'echo ${x:-a b}'])
  test(`F1 allows ${c}`, () => {
    expect(ask(c)).toBeUndefined()
  })

// claude-factory-qn8a.5.7: the zsh flag-group re-read must not discard the funsub reason that hides a last-argument head deny.
for (const c of [
  "${(@)_}; echo '${() }'",
  "echo '${() }'; ${(z)_}",
  ": 'gh pr merge 1'; ${(z)_}; echo '${() }'",
  ": 'gh pr merge 1'; ${(s: :)_}; echo '${() }'",
  ": 'gh pr merge 1'; ${(@)=_}; echo '${() }'",
  ": 'git push origin main'; ${(z)_}; echo '${() }'",
  ": 'factory tick'; ${(z)_}; echo '${() }'",
  ': \'gh pr merge 1\'; ${(z)_}; echo "${(L) x}"',
  ": 'gh pr merge 1'; ${(z)_}\necho '${() }'",
])
  test(`5.7 denies ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBeDefined()
  })
// Known false deny (fail closed): the re-read puts a blank in the place of a glued $(...).
for (const c of ['echo ${$(date)%x}', 'echo "${$(pwd):t}"', 'echo ${$(date)}'])
  test(`5.7 known false deny ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBe(FUNSUB_REASON)
  })

// claude-factory-qn8a.5.8: a redirect target with a `(` between factory and its verb hides the verb.
for (const c of [
  'factory > >(cat) tick',
  'factory < <(echo x) say hi',
  'factory 2> >(cat) rig add w x',
  'factory > >(cat) memory compact',
])
  test(`5.8 denies ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBeDefined()
  })
for (const c of [
  'diff <(sort a) <(sort b)',
  'cat < <(echo x)',
  'echo x > >(cat)',
  'gh pr view 1 > >(cat)',
  'factory report r1 13 approve x > >(cat)',
  'factory memory search x > >(cat)',
])
  test(`5.8 allows ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBeUndefined()
  })
// Known gaps (claude-factory-qn8a.40): the same hidden verb for gh, git, kubectl, helm and rm is not read.
for (const c of [
  'gh > >(cat) pr merge 1',
  'gh pr > >(cat) merge 1',
  'git > >(cat) push origin main',
  'kubectl > >(cat) delete pod x',
  'helm > >(cat) upgrade x y',
  'rm > >(cat) -rf ./nx',
])
  test(`known gap qn8a.40 allows ${JSON.stringify(c)}`, () => {
    expect(ask(c)).toBeUndefined()
  })
