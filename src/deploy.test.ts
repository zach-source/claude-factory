import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
        if (!/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i.test(e.name)) continue
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

test('the container args start the worker API on 8443 from the mounted worker key', () => {
  const c = find(load(), 'Deployment').spec.template.spec.containers[0]
  expect(parseFlags(c.args).worker).toEqual({ port: 8443, key: '/etc/factory/worker-key/key' })
  expect(c.volumeMounts.map((m: Obj) => m.mountPath)).toContain('/etc/factory/worker-key')
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

test('the optional factory-backup Secret turns the home backup on: a remote, a token file and nothing else', () => {
  const pod = find(load(), 'Deployment').spec.template.spec
  const c = pod.containers[0]
  expect(c.env.find((e: Obj) => e.name === 'FACTORY_SERVER_BACKUP_REMOTE').valueFrom.secretKeyRef).toEqual({
    name: 'factory-backup',
    key: 'remote',
    optional: true,
  })
  expect(c.env.find((e: Obj) => e.name === 'FACTORY_SERVER_BACKUP_AUTH_FILE').value).toBe(
    '/etc/factory/backup/basic',
  )
  expect(c.volumeMounts).toContainEqual({ name: 'backup', mountPath: '/etc/factory/backup', readOnly: true })
  expect(pod.volumes.find((v: Obj) => v.name === 'backup').secret).toEqual({
    secretName: 'factory-backup',
    optional: true,
    items: [{ key: 'basic', path: 'basic' }],
  })
  const raw = readFileSync(join(import.meta.dir, '..', 'deploy', 'server.yaml'), 'utf8')
  expect(raw).toContain(
    '#   kubectl -n factory create secret generic factory-backup --from-literal=remote=<https url> --from-literal=basic=<base64 of x-access-token:token>   (optional: the home backup)',
  )
})

// deploy/broker.yaml: the broker NetworkPolicy lets in the egress gateway namespace and the server pod only.
const loadBroker = (): Obj[] =>
  Bun.YAML.parse(readFileSync(join(import.meta.dir, '..', 'deploy', 'broker.yaml'), 'utf8')) as Obj[]

const brokerUrl = (docs: Obj[]) => {
  const s = find(docs, 'Service')
  return `http://${s.metadata.name}.${s.metadata.namespace}.svc:${s.spec.ports[0].port}`
}

const brokerEnvProblems = (server: Obj[], broker: Obj[]): string[] => {
  const c = find(server, 'Deployment').spec.template.spec.containers.find((x: Obj) => x.name === 'server')
  const e = (c?.env ?? []).filter((x: Obj) => x.name === 'FACTORY_POLICY_BROKER')
  const ok =
    e.length === 1 &&
    JSON.stringify(Object.keys(e[0]).sort()) === '["name","value"]' &&
    e[0].value === brokerUrl(broker)
  return ok ? [] : ['FACTORY_POLICY_BROKER']
}

const brokerPolicyProblems = (broker: Obj[], server: Obj[]): string[] => {
  const np = find(broker, 'NetworkPolicy')
  const dep = find(server, 'Deployment')
  const svc = find(broker, 'Service')
  const port = svc.spec.ports[0].targetPort
  const want = [
    {
      from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ate-system' } } }],
      ports: [{ protocol: 'TCP', port: 8080 }],
    },
    {
      from: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': dep.metadata.namespace } },
          podSelector: { matchLabels: dep.spec.template.metadata.labels },
        },
      ],
      ports: [{ protocol: 'TCP', port }],
    },
  ]
  const bad: string[] = []
  if (JSON.stringify(Object.keys(np.spec).sort()) !== '["ingress","podSelector","policyTypes"]')
    bad.push('spec keys')
  if (JSON.stringify(np.spec.policyTypes) !== '["Ingress"]') bad.push('policyTypes')
  if (!Bun.deepEquals(np.spec.ingress, want, true)) bad.push('ingress')
  const labels = find(broker, 'Deployment').spec.template.metadata.labels
  if (!Bun.deepEquals(np.spec.podSelector, { matchLabels: labels }, true)) bad.push('podSelector')
  if (!Bun.deepEquals(labels, svc.spec.selector, true)) bad.push('service selector')
  return bad
}

test('the broker manifest holds the expected objects in order', () => {
  expect(loadBroker().map(d => d.kind)).toEqual([
    'Namespace',
    'ServiceAccount',
    'ClusterRole',
    'ClusterRoleBinding',
    'Role',
    'RoleBinding',
    'Deployment',
    'Service',
    'NetworkPolicy',
  ])
})

test('the server pod sets FACTORY_POLICY_BROKER to the broker Service', () => {
  const server = load()
  const broker = loadBroker()
  expect(brokerEnvProblems(server, broker)).toEqual([])
  const env = (m: (e: Obj[]) => Obj[]) => {
    const d = structuredClone(server)
    const c = find(d, 'Deployment').spec.template.spec.containers.find((x: Obj) => x.name === 'server')
    c.env = m(c.env)
    return brokerEnvProblems(d, broker)
  }
  const set = (f: (e: Obj) => void) =>
    env(l => {
      f(l.find(e => e.name === 'FACTORY_POLICY_BROKER')!)
      return l
    })
  expect(env(l => l.filter(e => e.name !== 'FACTORY_POLICY_BROKER'))).not.toEqual([])
  expect(set(e => (e.value = 'http://factory-policy-brokerx.factory-broker.svc:8080'))).not.toEqual([])
  expect(env(l => [...l, { ...l.find(e => e.name === 'FACTORY_POLICY_BROKER')! }])).not.toEqual([])
  expect(set(e => (e.value = 'https://factory-policy-broker.factory-broker.svc:8080'))).not.toEqual([])
  expect(set(e => (e.value += '/'))).not.toEqual([])
  expect(set(e => (e.valueFrom = { secretKeyRef: { name: 'x', key: 'y' } }))).not.toEqual([])
})

test('the broker NetworkPolicy lets in ate-system and the server pod only', () => {
  const server = load()
  const broker = loadBroker()
  expect(brokerPolicyProblems(broker, server)).toEqual([])
  const mut = (f: (np: Obj) => void) => {
    const d = structuredClone(broker)
    f(find(d, 'NetworkPolicy'))
    return brokerPolicyProblems(d, server)
  }
  const peer = (np: Obj) => np.spec.ingress[1].from[0]
  expect(mut(np => (np.spec.podSelector.matchLabels.app = 'factory-policy-brokerx'))).not.toEqual([])
  expect(mut(np => (np.spec.podSelector = {}))).not.toEqual([])
  expect(mut(np => delete peer(np).podSelector)).not.toEqual([])
  expect(
    mut(np => {
      const p = peer(np)
      np.spec.ingress[1].from = [{ namespaceSelector: p.namespaceSelector }, { podSelector: p.podSelector }]
    }),
  ).not.toEqual([])
  expect(mut(np => delete peer(np).namespaceSelector)).not.toEqual([])
  expect(mut(np => (peer(np).podSelector.matchLabels.app = 'factory-serverx'))).not.toEqual([])
  expect(mut(np => (peer(np).podSelector.matchLabels.extra = 'x'))).not.toEqual([])
  expect(
    mut(np => np.spec.ingress.push({ from: [{ podSelector: {} }], ports: [{ port: 8080 }] })),
  ).not.toEqual([])
  expect(mut(np => np.spec.ingress.shift())).not.toEqual([])
  expect(mut(np => np.spec.ingress[1].ports.push({ protocol: 'TCP', port: 8443 }))).not.toEqual([])
  expect(mut(np => (np.spec.ingress[1].ports[0].port = 8443))).not.toEqual([])
  expect(mut(np => delete np.spec.ingress[1].ports)).not.toEqual([])
  expect(mut(np => np.spec.policyTypes.push('Egress'))).not.toEqual([])
  expect(mut(np => (np.spec.egress = []))).not.toEqual([])
})
