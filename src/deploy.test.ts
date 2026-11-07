import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECRETS } from './secrets'
import { parseFlags } from './server'

// deploy/server.yaml is applied by the owner. These tests read it as data: no cluster is needed.
type Obj = Record<string, any>
const load = (): Obj[] =>
  Bun.YAML.parse(readFileSync(join(import.meta.dir, '..', 'deploy', 'server.yaml'), 'utf8')) as Obj[]
const find = (docs: Obj[], kind: string) => docs.find(d => d.kind === kind)!

const hasKey = (v: unknown, keys: string[]): boolean =>
  Array.isArray(v)
    ? v.some(x => hasKey(x, keys))
    : v !== null && typeof v === 'object'
      ? Object.entries(v).some(([k, x]) => keys.includes(k) || hasKey(x, keys))
      : false

// One rule: no secret value appears in the file. Returns the problems found.
const secretProblems = (docs: Obj[]): string[] => {
  const bad: string[] = []
  if (docs.some(d => d.kind === 'Secret')) bad.push('Secret document')
  if (hasKey(docs, ['data', 'stringData'])) bad.push('data or stringData key')
  for (const d of docs.filter(x => x.kind === 'Deployment')) {
    const spec = d.spec.template.spec
    for (const c of spec.containers)
      for (const e of c.env ?? []) {
        // GIT_CONFIG_KEY_n names a git config key, not a secret; the SECRETS shapes check its value
        if (!/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(e.name) || /^GIT_CONFIG_KEY_\d+$/.test(e.name))
          continue
        const ref = e.valueFrom?.secretKeyRef
        if (
          e.value !== undefined ||
          !ref ||
          Object.keys(ref).some(k => !['name', 'key', 'optional'].includes(k))
        )
          bad.push(`env ${e.name}`)
      }
    for (const v of spec.volumes ?? [])
      if (v.secret && Object.keys(v.secret).some(k => !['secretName', 'optional', 'items'].includes(k)))
        bad.push(`volume ${v.name}`)
  }
  return bad
}

const rbacProblems = (docs: Obj[]): string[] => {
  const bad: string[] = []
  for (const r of docs.filter(d => d.kind === 'ClusterRole' || d.kind === 'Role').flatMap(d => d.rules)) {
    if (r.verbs.length !== 1 || r.verbs[0] !== 'get') bad.push(`verbs ${r.verbs}`)
    if ([...r.resources, ...r.apiGroups].some((x: string) => x === '*')) bad.push('wildcard')
    if (r.resources.some((x: string) => x === 'secrets' || x === 'pods/exec')) bad.push('secrets or exec')
  }
  return bad
}

const policyProblems = (docs: Obj[]): string[] => {
  const np = find(docs, 'NetworkPolicy')
  const bad: string[] = []
  if (JSON.stringify(np.spec.policyTypes) !== '["Ingress"]') bad.push('policyTypes')
  if (np.spec.ingress.length !== 2) bad.push('rule count')
  for (const r of np.spec.ingress) if (!r.from?.length) bad.push('rule without from')
  return bad
}

const servicePorts = (docs: Obj[]) =>
  find(docs, 'Service').spec.ports.map((p: Obj) => [p.name, p.port, p.targetPort])

test('the manifest holds the expected objects in order and namespaces', () => {
  const docs = load()
  expect(docs.map(d => d.kind)).toEqual([
    'Namespace',
    'ServiceAccount',
    'ClusterRole',
    'ClusterRoleBinding',
    'Role',
    'RoleBinding',
    'PersistentVolumeClaim',
    'Deployment',
    'Service',
    'NetworkPolicy',
  ])
  for (const d of docs) {
    if (['Namespace', 'ClusterRole', 'ClusterRoleBinding'].includes(d.kind)) continue
    expect(d.metadata.namespace).toBe(d.kind === 'Role' || d.kind === 'RoleBinding' ? 'ax-system' : 'factory')
  }
})

test('secrets are names only', () => {
  const docs = load()
  expect(secretProblems(docs)).toEqual([])
  const copy = () => structuredClone(docs)
  const withSecret = copy()
  withSecret.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'x' } })
  expect(secretProblems(withSecret)).not.toEqual([])
  const withString = copy()
  withString[1]!.stringData = { a: 'b' }
  expect(secretProblems(withString)).not.toEqual([])
  const withValue = copy()
  const env = find(withValue, 'Deployment').spec.template.spec.containers[0].env.find(
    (e: Obj) => e.name === 'GH_TOKEN',
  )
  delete env.valueFrom
  env.value = 'x'
  expect(secretProblems(withValue)).not.toEqual([])
})

test('the Deployment runs one non-root writer with the home volume', () => {
  const dep = find(load(), 'Deployment')
  expect(dep.metadata.name).toBe('factory-server')
  expect(dep.spec.replicas).toBe(1)
  expect(dep.spec.strategy.type).toBe('Recreate')
  const pod = dep.spec.template.spec
  expect(pod.securityContext).toEqual({
    runAsNonRoot: true,
    runAsUser: 1000,
    fsGroup: 1000,
    seccompProfile: { type: 'RuntimeDefault' },
  })
  const c = pod.containers[0]
  expect(c.securityContext).toEqual({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } })
  expect(c.image).toBe('${SERVER_IMAGE}')
  for (const p of [c.readinessProbe, c.livenessProbe])
    expect(p.httpGet).toEqual({ path: '/healthz', port: 8080 })
  expect(pod.volumes.some((v: Obj) => v.persistentVolumeClaim?.claimName === 'factory-home')).toBe(true)
  expect(c.volumeMounts.some((m: Obj) => m.mountPath === '/var/lib/factory')).toBe(true)
  expect(c.env.find((e: Obj) => e.name === 'FACTORY_HOME').value).toBe('/var/lib/factory/home')
})

test('the pod is a server home: rig clones under the PVC, git asks gh for the credential, no token in a value', () => {
  const c = find(load(), 'Deployment').spec.template.spec.containers[0]
  const val = (n: string) => c.env.find((e: Obj) => e.name === n)?.value
  expect(val('FACTORY_SERVER_HOME')).toBe('1')
  expect(val('FACTORY_REPOS')).toBe('/var/lib/factory/repos')
  expect(val('GIT_CONFIG_COUNT')).toBe('2')
  expect(val('GIT_CONFIG_KEY_0')).toBe('credential.https://github.com.helper')
  expect(val('GIT_CONFIG_VALUE_0')).toBe('')
  expect(val('GIT_CONFIG_KEY_1')).toBe('credential.https://github.com.helper')
  expect(val('GIT_CONFIG_VALUE_1')).toBe('!gh auth git-credential')
  expect(c.env.some((e: Obj) => e.name === 'FACTORY_IN_AX')).toBe(false)
  const doltEnv = c.env.find((e: Obj) => e.name === 'DOLT_REMOTE_PASSWORD')
  expect(doltEnv.value).toBeUndefined()
  expect(doltEnv.valueFrom.secretKeyRef.name).toBe('factory-dolt-remote')
  for (const e of c.env) for (const re of SECRETS) expect(re.test(String(e.value ?? ''))).toBe(false)
})

test('the container args start the client API on 8444 from the mounted TLS and person CA files', () => {
  const c = find(load(), 'Deployment').spec.template.spec.containers[0]
  const f = parseFlags(c.args)
  expect(f.port).toBe(8080)
  expect(f.client).toEqual({
    port: 8444,
    cert: '/etc/factory/tls/tls.crt',
    key: '/etc/factory/tls/tls.key',
    ca: '/etc/factory/person-ca/ca.crt',
  })
  const mounts = c.volumeMounts.map((m: Obj) => m.mountPath)
  expect(mounts).toContain('/etc/factory/tls')
  expect(mounts).toContain('/etc/factory/person-ca')
})

test('the Service exposes only the worker and client ports', () => {
  const docs = load()
  expect(servicePorts(docs)).toEqual([
    ['worker', 8443, 8443],
    ['client', 8444, 8444],
  ])
  expect(find(docs, 'Service').metadata.name).toBe('factory')
  const extra = structuredClone(docs)
  find(extra, 'Service').spec.ports.push({ name: 'x', port: 8080, targetPort: 8080 })
  expect(servicePorts(extra)).not.toEqual(servicePorts(docs))
})

test('the NetworkPolicy opens each port to one namespace only', () => {
  const docs = load()
  expect(policyProblems(docs)).toEqual([])
  const rules = find(docs, 'NetworkPolicy').spec.ingress
  const from = (port: number) => {
    const r = rules.filter((x: Obj) => x.ports.some((p: Obj) => p.port === port))
    expect(r.length).toBe(1)
    expect(r[0].ports.length).toBe(1)
    return r[0].from.map((f: Obj) => f.namespaceSelector.matchLabels['kubernetes.io/metadata.name'])
  }
  expect(from(8443)).toEqual(['ate-system'])
  expect(from(8444)).toEqual(['${CLIENT_GATEWAY_NAMESPACE}'])
  const open = structuredClone(docs)
  delete find(open, 'NetworkPolicy').spec.ingress[0].from
  expect(policyProblems(open)).not.toEqual([])
})

test('RBAC is read-only on two named objects', () => {
  const docs = load()
  expect(rbacProblems(docs)).toEqual([])
  expect(find(docs, 'ClusterRole').rules).toEqual([
    { apiGroups: ['certificates.k8s.io'], resources: ['clustertrustbundles'], verbs: ['get'] },
  ])
  expect(find(docs, 'Role').rules).toEqual([
    { apiGroups: ['apps'], resources: ['deployments'], resourceNames: ['ax-controller'], verbs: ['get'] },
  ])
  const write = structuredClone(docs)
  find(write, 'ClusterRole').rules[0].verbs = ['get', 'create']
  expect(rbacProblems(write)).not.toEqual([])
})
