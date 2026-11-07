// Pure checks that untrusted text never sits in shell double quotes (claude-factory-dgok, claude-factory-2z48).
// quote-untrusted.test.tsx runs them on the manager manual. src/steps.test.ts runs them on the patrol step file.

/** the `factory ...` spans of `t` that hold a `<...>` placeholder */
export const placeholderSpans = (t: string) =>
  (t.match(/`factory [^`]*`/g) ?? []).filter(s => s.includes('<'))

export const ID_PLACEHOLDERS = new Set([
  'run',
  'outcome',
  'name',
  'repo',
  'rig',
  'bead',
  'key',
  'station',
  'station|done',
  'factory',
  'rig|repo',
  'old note path',
  'source rig',
  'source id',
  'path',
])
export const badPlaceholders = (t: string) =>
  (t.match(/`factory [^`]*`/g) ?? []).flatMap(s =>
    (s.replace(/'<[^>]*>'/g, '').match(/<[^>]*>/g) ?? []).filter(p => !ID_PLACEHOLDERS.has(p.slice(1, -1))),
  )

const FILE_OK = new Set(['run', 'rig', 'bead', 'key', 'source rig', 'source id', 'path'])
export const fileSpans = (t: string) =>
  (t.match(/`[^`]*`/g) ?? []).filter(s => /file-elsewhere|decisions propose/.test(s))
export const fileFormBad = (t: string) =>
  fileSpans(t).flatMap(s =>
    (s.match(/['"]?<[^>]*>['"]?/g) ?? []).filter(
      p => /^['"]/.test(p) || !FILE_OK.has(p.replace(/^<|>$/g, '')),
    ),
  )
