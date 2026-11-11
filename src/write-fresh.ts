import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'

/** Writes text to a fresh temp file with mode 0600 and renames it over file. It removes a stale temp
 * entry first and opens with 'wx', so it never writes through a symlink or keeps an old mode. */
export function writeFresh(file: string, text: string, tmp = `${file}.tmp`) {
  rmSync(tmp, { force: true })
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } catch (e) {
    closeSync(fd)
    rmSync(tmp, { force: true })
    throw e
  }
  closeSync(fd)
  renameSync(tmp, file)
}
