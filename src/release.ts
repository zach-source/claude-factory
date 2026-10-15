// Cuts a release the way the repo's own git history already does it. Commit b641b64 shows the pattern:
// bump the "version" field in package.json and mod/.claude-plugin/plugin.json, and move the CHANGELOG's
// "## Unreleased" bullets under a new "## X.Y.Z (date)" heading.
//
// A person can run `bun src/release.ts <command> ...` by hand. .github/workflows/release.yml runs it too.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Bump = 'patch' | 'minor' | 'major'

const VERSION_FIELD = /"version":\s*"(\d+\.\d+\.\d+)"/
const UNRELEASED_HEADING = /^## Unreleased\n\n/m
const HEADING_LINE = /^## .+$/m

export function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  if (!m) throw new Error(`not a semver x.y.z version: ${JSON.stringify(v)}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function bumpVersion(current: string, kind: Bump): string {
  const [major, minor, patch] = parseVersion(current)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`unknown bump kind: ${JSON.stringify(kind)}; use patch, minor or major`)
}

export function readVersion(json: string): string {
  const m = VERSION_FIELD.exec(json)
  if (!m) throw new Error('no "version" field found')
  return m[1]!
}

// Edits only the version field, byte for byte everywhere else, the way f580705 did.
export function setVersion(json: string, version: string): string {
  if (!VERSION_FIELD.test(json)) throw new Error('no "version" field found')
  return json.replace(VERSION_FIELD, `"version": "${version}"`)
}

// package.json and mod/.claude-plugin/plugin.json must carry the same version (the PR #18/#20 drift this
// goal exists to close): refuse before bumping either one.
export function checkVersions(pkgJson: string, pluginJson: string): string {
  const a = readVersion(pkgJson)
  const b = readVersion(pluginJson)
  if (a !== b)
    throw new Error(`package.json is ${a} but mod/.claude-plugin/plugin.json is ${b}; fix the drift first`)
  return a
}

// Find the text under one `## ` heading. `startRe` must match the heading's own line. The result cuts off
// at the next `## ` heading, or at the end of the file when there is none. It drops the heading's own line
// and the blank line under it. It trims trailing blank lines from the end.
function sectionBody(changelog: string, startRe: RegExp): { headingEnd: number; body: string } {
  const start = startRe.exec(changelog)
  if (!start) throw new Error(`heading not found: ${startRe}`)
  const headingLineEnd = changelog.indexOf('\n', start.index)
  const bodyStart =
    headingLineEnd + 1 === changelog.indexOf('\n', headingLineEnd + 1)
      ? headingLineEnd + 2
      : headingLineEnd + 1
  HEADING_LINE.lastIndex = 0
  const rest = changelog.slice(bodyStart)
  const next = HEADING_LINE.exec(rest)
  const body = (next ? rest.slice(0, next.index) : rest).replace(/\n+$/, '')
  return { headingEnd: bodyStart, body }
}

// Refuses an empty Unreleased section: nothing to release.
export function unreleasedBody(changelog: string): string {
  const { body } = sectionBody(changelog, /^## Unreleased\n\n/m)
  if (body.trim() === '') throw new Error('the Unreleased section is empty; nothing to release')
  return body
}

// Moves the Unreleased bullets under a new `## <version> (<date>)` heading, right after the now-empty
// `## Unreleased` heading, the way b641b64 did it: insert two lines, change nothing else.
export function cut(changelog: string, version: string, date: string): string {
  unreleasedBody(changelog) // throws on empty, before touching anything
  if (!UNRELEASED_HEADING.test(changelog)) throw new Error('no "## Unreleased\\n\\n" heading found')
  return changelog.replace(UNRELEASED_HEADING, `## Unreleased\n\n## ${version} (${date})\n\n`)
}

// The bullets released under `## <version> (...)`, for a GitHub release's notes body.
export function notes(changelog: string, version: string): string {
  const re = new RegExp(`^## ${version.replace(/\./g, '\\.')} \\(`, 'm')
  const { body } = sectionBody(changelog, re)
  if (body.trim() === '') throw new Error(`"## ${version} (...)" section is empty`)
  return body
}

// Checks the remote, not the local clone: release.yml's checkout step takes GitHub's default
// `fetch-tags: false`, so a local `git rev-parse --verify refs/tags/vX` always says "not found" in
// CI even when the tag is already on GitHub (claude-factory-5h9.15). `git ls-remote` asks origin
// directly, so it works in any clone shape.
// cut() moves everything under `## Unreleased` to a new `## X.Y.Z (date)` heading right below it.
// Right after a cut, `## Unreleased` is empty.
//
// A later commit can still land on main before the release PR merges. It can add its own bullet
// under `## Unreleased`, the normal per-change pattern. Its code ships in the tag that
// release-tag.yml makes at the merge commit. But `notes()` reads only the already-cut
// `## X.Y.Z (...)` section. So its bullet never reaches the GitHub release notes
// (claude-factory-5h9.11).
//
// Call this at the merge commit, after `prepare` has run. A non-empty result means the tag is
// about to ship undocumented changes.
export function lateUnreleasedBullets(changelog: string): string {
  const { body } = sectionBody(changelog, /^## Unreleased\n\n/m)
  return body.trim()
}

export function tagExists(version: string, cwd = '.'): boolean {
  const p = Bun.spawnSync([
    'git',
    '-C',
    cwd,
    'ls-remote',
    '--exit-code',
    '--tags',
    'origin',
    `refs/tags/v${version}`,
  ])
  return p.exitCode === 0
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

function usage(): never {
  console.error(
    'usage: bun src/release.ts prepare <patch|minor|major> [--date YYYY-MM-DD]\n' +
      '       bun src/release.ts notes <version>\n' +
      '       bun src/release.ts check-no-late-unreleased',
  )
  process.exit(1)
}

function main(argv: string[]) {
  const [cmd, ...args] = argv
  const pkgPath = join(process.cwd(), 'package.json')
  const pluginPath = join(process.cwd(), 'mod/.claude-plugin/plugin.json')
  const changelogPath = join(process.cwd(), 'CHANGELOG.md')

  if (cmd === 'prepare') {
    const kind = args[0] as Bump | undefined
    if (kind !== 'patch' && kind !== 'minor' && kind !== 'major') usage()
    const dateIdx = args.indexOf('--date')
    const date = dateIdx !== -1 && args[dateIdx + 1] ? args[dateIdx + 1]! : todayUTC()

    const pkgJson = readFileSync(pkgPath, 'utf8')
    const pluginJson = readFileSync(pluginPath, 'utf8')
    const changelog = readFileSync(changelogPath, 'utf8')

    const current = checkVersions(pkgJson, pluginJson) // throws on drift
    const next = bumpVersion(current, kind)
    if (tagExists(next)) throw new Error(`tag v${next} already exists; delete it or pick a different bump`)
    const newChangelog = cut(changelog, next, date) // throws on an empty Unreleased

    writeFileSync(pkgPath, setVersion(pkgJson, next))
    writeFileSync(pluginPath, setVersion(pluginJson, next))
    writeFileSync(changelogPath, newChangelog)
    console.log(next)
    return
  }

  if (cmd === 'notes') {
    const version = args[0]
    if (!version) usage()
    const changelog = readFileSync(changelogPath, 'utf8')
    console.log(notes(changelog, version))
    return
  }

  if (cmd === 'check-no-late-unreleased') {
    const changelog = readFileSync(changelogPath, 'utf8')
    const late = lateUnreleasedBullets(changelog)
    if (late !== '')
      throw new Error(
        `## Unreleased is not empty at the merge commit; it will not reach the release notes:\n${late}`,
      )
    return
  }

  usage()
}

if (import.meta.main)
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`refused: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
