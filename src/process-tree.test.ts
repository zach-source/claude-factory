import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopChildren } from './process-tree'

const alive = (pid: number) => {
  const p = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'stat='])
  return p.exitCode === 0 && !!p.stdout.toString().trim() && !p.stdout.toString().trim().startsWith('Z')
}

test('cleanup stops a detached child that ignores TERM and preserves the shell and another worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-processes-'))
  const receipt = join(dir, 'child.json')
  const childCode = `process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  const rootCode = `
    const {spawn}=require('node:child_process');
    const {writeFileSync}=require('node:fs');
    const child=spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {detached:true,stdio:'ignore'});
    writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({child:child.pid}));
    setInterval(() => {}, 1000);
  `
  const root = spawn(process.execPath, ['-e', rootCode], { stdio: 'ignore' })
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  let child: number | undefined
  try {
    const until = Date.now() + 2000
    while (!existsSync(receipt) && Date.now() < until) await Bun.sleep(10)
    child = JSON.parse(readFileSync(receipt, 'utf8')).child
    await Bun.sleep(100)
    expect(alive(child!)).toBe(true)
    stopChildren(root.pid!)
    expect(alive(child!)).toBe(false)
    expect(alive(root.pid!)).toBe(true)
    expect(alive(other.pid!)).toBe(true)
    expect(() => stopChildren(process.pid)).toThrow('invalid worker shell pid')
  } finally {
    for (const pid of [child, root.pid, other.pid]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
