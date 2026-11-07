// Client API of `factory server` on port 8444 (claude-factory-akiq.7). Contract: specs/004-factory-server/contracts/client-api.md.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Make a new folder with the person CA, the person certificate and the server certificate.
 * If the folder exists or the name is bad, throw before any write. Call openssl with an argv array, not a shell.
 * ponytail: the person CA also signs the server certificate, because the client pins one ca.crt. That certificate has serverAuth only, so the CA does not accept it as a client certificate.
 */
export function personCerts(dir: string, serverName: string) {
  if (!NAME.test(serverName)) throw new Error('server-name must match ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$')
  if (existsSync(dir)) throw new Error(`${dir} exists: choose a new folder, no key is overwritten`)
  mkdirSync(dir, { mode: 0o700 })
  chmodSync(dir, 0o700)
  const ssl = (...a: string[]) => {
    const r = Bun.spawnSync(['openssl', ...a], { cwd: dir })
    if (r.exitCode !== 0) throw new Error(`openssl ${a[0]} failed: ${r.stderr.toString().slice(0, 300)}`)
  }
  const key = (n: string) => {
    ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${n}.key`)
    chmodSync(join(dir, `${n}.key`), 0o600)
  }
  const leaf = (n: string, cn: string, ext: string) => {
    key(n)
    ssl('req', '-new', '-key', `${n}.key`, '-subj', `/CN=${cn}`, '-out', `${n}.csr`)
    writeFileSync(join(dir, `${n}.ext`), ext)
    ssl(
      ...['x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial'],
      ...['-days', '825', '-sha256', '-extfile', `${n}.ext`, '-out', `${n}.crt`],
    )
  }
  try {
    key('ca')
    ssl(
      ...[
        'req',
        '-x509',
        '-new',
        '-key',
        'ca.key',
        '-sha256',
        '-days',
        '825',
        '-subj',
        '/CN=factory-person-ca',
      ],
      ...[
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign',
        '-out',
        'ca.crt',
      ],
    )
    leaf('person', 'person', 'extendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE\n')
    const san = IPV4.test(serverName) ? `IP:${serverName}` : `DNS:${serverName}`
    leaf(
      'server',
      serverName,
      `extendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nsubjectAltName=${san}\n`,
    )
    for (const f of ['person.csr', 'person.ext', 'server.csr', 'server.ext', 'ca.srl'])
      rmSync(join(dir, f), { force: true })
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  return [
    `made ${dir}: ca.key ca.crt person.key person.crt server.key server.crt. Next steps for the owner:`,
    `  1. Copy person.crt, person.key and ca.crt to ~/.config/factory/ on the laptop (person.key mode 0600).`,
    `  2. kubectl -n factory create secret tls factory-server-tls --cert=${dir}/server.crt --key=${dir}/server.key`,
    `  3. kubectl -n factory create secret generic factory-person-ca --from-file=ca.crt=${dir}/ca.crt`,
    `  4. Keep ca.key offline: move it off this machine.`,
  ].join('\n')
}
