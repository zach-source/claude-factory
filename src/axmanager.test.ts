// The AX manager's builders (claude-factory-d289.4): its task manifest, env and egress, the attach files, and
// the cutover ports. Pure functions only; ax.test.ts drives launchManager through a fake ax.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ax from './ax'
import { isLaptopPane, mapRunWorktree, stationRunnerName } from './axrepos'
import { attemptStart } from './cli'
import { seedClaudeJson, seedSettings, sshdConfig } from './managerhost'

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGs0bWVrZXlrZXlrZXlrZXlrZXlrZXlrZXlrZXlrZXk laptop'
const files = (m: Record<string, string>) => (p: string) => {
  if (!(p in m)) throw new Error(`no file ${p}`)
  return m[p]!
}

test('the manager manifest runs its own command with no worker env, debug on, on the workspace volume', () => {
  const docs = ax
    .manifest({
      name: 'f-manager',
      image: 'mgr@sha256:abc',
      command: ['factory', 'manager', 'host'],
      env: { A: '1' },
    })
    .split('\n---\n')
    .map(d => JSON.parse(d))
  expect(docs[0]).toMatchObject({ kind: 'Workspace', metadata: { name: 'f-manager' }, spec: {} })
  const spec = docs[1].spec
  expect(spec.command).toEqual(['factory', 'manager', 'host'])
  expect(spec.env).toEqual([{ name: 'A', value: '1' }])
  expect(spec.debug).toBe(true)
  expect(spec.workspaces).toEqual([{ name: 'f-manager', path: ax.WS }])
})

test('managerEnv holds no secret: a real token on the laptop does not go over, only names and a public key', () => {
  const laptop = {
    FACTORY_AX_VAULT: 'v1',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-real',
    GH_TOKEN: 'ghp_real',
    AX_AUTH_TOKEN: 'real',
    FACTORY_BROKER_TOKEN: 'real',
    OP_SERVICE_ACCOUNT_TOKEN: 'real',
    FACTORY_AX_MANAGER_SSH_PUBKEY: '/k.pub',
  }
  const env = ax.managerEnv(laptop, files({ '/k.pub': `${PUB}\n` }))
  expect(Object.values(env).some(v => typeof v === 'string' && v.includes('real'))).toBe(false)
  expect(env[ax.AUTHORIZED_KEYS_ENV as keyof typeof env]).toBe(`${PUB}\n`)
  expect(env).toMatchObject({ FACTORY_IN_AX: '1', FACTORY_HOME: '/workspace/w/home', FACTORY_AX_VAULT: 'v1' })
})

test('a private key in FACTORY_AX_MANAGER_SSH_PUBKEY is refused, and the error does not show it', () => {
  // split, so no secret scanner takes the fake key for a real one
  const kind = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ')
  const key = `-----BEGIN ${kind}-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END ${kind}-----\n`
  let msg = ''
  try {
    ax.managerEnv({ FACTORY_AX_MANAGER_SSH_PUBKEY: '/id' }, files({ '/id': key }))
  } catch (e) {
    msg = (e as Error).message
  }
  expect(msg).toContain('public key')
  expect(msg).not.toContain('b3BlbnNz')
  expect(() => ax.publicKeys('')).toThrow()
  expect(ax.publicKeys(`\n${PUB}\n\n`)).toBe(`${PUB}\n`)
})

test('managerEnv passes the pkg gate, an empty capabilities list, and FACTORY_AX_ENV as content', () => {
  const env = ax.managerEnv(
    {
      FACTORY_AX_PKG_GATE: 'http://gate.example.svc:8080',
      FACTORY_AX_CAPABILITIES: '',
      FACTORY_AX_ENV: '/e.json',
    },
    files({ '/e.json': '{"FACTORY_BAZELRC":"x"}' }),
  )
  expect(env).toMatchObject({
    FACTORY_AX_PKG_GATE: 'http://gate.example.svc:8080',
    FACTORY_AX_CAPABILITIES: '',
    FACTORY_AX_ENV: '{"FACTORY_BAZELRC":"x"}',
  })
  expect('FACTORY_AX_CAPABILITIES' in ax.managerEnv({})).toBe(false)
  expect(ax.readAxEnv('{"A":"1"}')).toEqual({ A: '1' })
  expect(() => ax.readAxEnv('/e.json', files({ '/e.json': '["secret"]' }))).toThrow(/not a JSON object/)
  expect(() => ax.readAxEnv('/e.json', files({ '/e.json': '{bad secret' }))).toThrow(
    'FACTORY_AX_ENV is not a JSON object or the path of a JSON file',
  )
})

test('managerEgress: an https AX server gets the AX_AUTH key, a Dolt remote its rule, a --linear rig Linear', () => {
  const rules = ax.managerEgress({ FACTORY_AX_MANAGER_AX_SERVER: 'https://ax.example.svc:8443' }, [
    { beadsRemote: { url: 'https://dolt.example.com/db' }, linear: true },
  ])
  expect(rules).toEqual([
    { hosts: ['claude.ai'] },
    { hosts: ['ax.example.svc'], port: 8443, key: 'AX_AUTH', header: 'Authorization', prefix: 'Bearer ' },
    { hosts: ['dolt.example.com'], key: 'DOLT_BASIC', header: 'Authorization', prefix: 'Basic ', port: 443 },
    { hosts: ['api.linear.app'], key: 'LINEAR', header: 'Authorization', prefix: '' },
  ])
})

test('the ssh Host block runs sshd -i as the worker through ax stdio, with the context and atespace first', () => {
  const saved = { ...process.env }
  try {
    Object.assign(process.env, {
      FACTORY_AX: 'ax',
      FACTORY_AX_CONTEXT: 'acme',
      FACTORY_AX_ATESPACE: 'factory',
    })
    expect(ax.sshConfigBlock('f-manager-test')).toBe(
      [
        'Host f-manager-test',
        '  User worker',
        '  ProxyCommand ax --context acme -a factory stdio f-manager-test -- setpriv --reuid=worker --regid=worker ' +
          '--init-groups /nix/var/nix/profiles/default/bin/sshd -i -f /workspace/w/ssh/sshd_config',
      ].join('\n'),
    )
  } finally {
    process.env = saved
  }
})

test('the sshd_config allows only the key, and SetEnv carries the one-line host env', () => {
  const text = sshdConfig('/w/ssh', {
    PATH: '/nix/bin:/usr/bin',
    FACTORY_HOME: '/workspace/w/home',
    HOME: '/root',
    FACTORY_CA: '-----BEGIN-----\nAAA\n',
    GIT_CONFIG_VALUE_0: 'Authorization: Basic placeholder',
  })
  for (const line of [
    'HostKey /w/ssh/host_ed25519',
    'AuthorizedKeysFile /w/ssh/authorized_keys',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitRootLogin no',
    'StrictModes no',
    'UsePAM no',
  ])
    expect(text.split('\n')).toContain(line)
  const setEnv = text.split('\n').find(l => l.startsWith('SetEnv '))!
  expect(setEnv).toContain('"PATH=/nix/bin:/usr/bin"')
  expect(setEnv).toContain('"GIT_CONFIG_VALUE_0=Authorization: Basic placeholder"')
  expect(setEnv).not.toContain('HOME=/root')
  expect(setEnv).not.toContain('FACTORY_CA')
})

test('the Claude config seed skips onboarding and the bypass dialog, and keeps what is there', () => {
  const out = seedClaudeJson({ theme: 'light', projects: { '/x': { a: 1 } }, other: 2 }, ['/w'])
  expect(out).toMatchObject({
    theme: 'light',
    other: 2,
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
  })
  expect(out.projects).toEqual({
    '/x': { a: 1 },
    '/w': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
  })
  expect(seedClaudeJson({}, []).theme).toBe('dark')
  expect(seedSettings({ a: 1 })).toEqual({ a: 1, skipDangerousModePermissionPrompt: true })
})

test('in the AX manager a station never gets a local runner, and a laptop pane is a handoff', () => {
  const local = (n: string) => n === 'herdr'
  expect(stationRunnerName(false, 'herdr', 'ax', 'herdr', local)).toBe('herdr')
  expect(stationRunnerName(true, 'herdr', 'ax', 'herdr', local)).toBe('ax')
  expect(stationRunnerName(true, undefined, undefined, 'herdr', local)).toBe('ax')
  expect(stationRunnerName(true, 'gke', 'ax', 'herdr', local)).toBe('gke')
  expect(isLaptopPane(true, 'w2:p3')).toBe(true)
  expect(isLaptopPane(true, 'ax://f-run-1')).toBe(false)
  expect(isLaptopPane(false, 'w2:p3')).toBe(false)
})

test('a laptop run gets a worktree under the task home; a task run keeps its own', () => {
  const rigs = [{ name: 'acme', repo: '/Users/me/acme' }]
  const env = { FACTORY_IN_AX: '1', FACTORY_HOME: '/workspace/w/home' }
  expect(mapRunWorktree(rigs, { id: 'r1', repo: '/Users/me/acme', worktree: '/Users/me/wt' }, env)).toBe(
    '/workspace/w/home/worktrees/r1',
  )
  expect(mapRunWorktree(rigs, { id: 'r2', repo: '/workspace/w/repos/acme', worktree: '/t' }, env)).toBe('/t')
  expect(mapRunWorktree(rigs, { id: 'r1', repo: '/Users/me/acme', worktree: '/Users/me/wt' }, {})).toBe(
    '/Users/me/wt',
  )
})

test('the home rewrite changes only the run state files and only whole path names', () => {
  const to = mkdtempSync(join(tmpdir(), 'axm-'))
  mkdirSync(join(to, 'runs', 'r1'), { recursive: true })
  const state = '{"repo":"/h/f/x","other":"/h/f2/y","end":"/h/f"}'
  writeFileSync(join(to, 'runs', 'r1', 'run.json'), state)
  writeFileSync(join(to, 'runs', 'r1', 'brief.md'), state)
  const p = Bun.spawnSync(['sh', '-c', ax.rewriteHomeCmd('/h/f/', to)])
  expect(p.exitCode).toBe(0)
  expect(readFileSync(join(to, 'runs', 'r1', 'run.json'), 'utf8')).toBe(
    `{"repo":"${to}/x","other":"/h/f2/y","end":"${to}"}`,
  )
  expect(readFileSync(join(to, 'runs', 'r1', 'brief.md'), 'utf8')).toBe(state)
  expect(ax.rewriteHomeCmd('')).toBe(':')
})

test('a task that waits for capacity is queued, and its clock starts when it leaves the queue', () => {
  expect(ax.isCapacityWait('status:\n  conditions:\n  - type: Ready\n    reason: WaitingForCapacity\n')).toBe(
    true,
  )
  expect(ax.isCapacityWait('status:\n  conditions:\n  - reason: Scheduled\n')).toBe(false)
  expect(attemptStart(100, 2, { seq: 2, at: 500 })).toBe(500)
  expect(attemptStart(100, 3, { seq: 2, at: 500 })).toBe(100)
  expect(attemptStart(100, 2)).toBe(100)
})
