# The web page

The client port of `factory server` (`--client-port`) serves one web page at `https://<server>:8444/`. It needs no other flag and no second port.

The page holds no factory logic. It calls the `/v1` routes of the catalog and shows the answers. It refreshes every 5 seconds. It reads only. It sends no command.

`factory ui` is the local page. It still works in local mode and does not change.

## Sections

| Section           | Routes                                      |
| ----------------- | ------------------------------------------- |
| Overview          | `/v1/board`, `/v1/lease`                    |
| Runs              | `/v1/status`                                |
| Epics and backlog | `/v1/backlog`                               |
| PRs               | `/v1/prs`                                   |
| Rigs              | `/v1/rigs`                                  |
| Runners           | `/v1/runners`                               |
| Mail              | `/v1/mail`                                  |
| Manager           | `/v1/decisions`, `/v1/steps`, `/v1/metrics` |

The Epics and backlog section shows one block for each rig: the epic progress (`epics` field of `/v1/backlog`, the same counts as `factory ui`), then the queued and unqueued beads. The core computes the counts. The page only lays them out.

The page shows any other array of objects as a table. It shows any other answer as text.

## Certificate and listen config

The page uses the same mTLS listener as the client API. A browser must present the person certificate. If it does not, the TLS handshake fails.

1. Make the certificates with `personCerts`. Use the public host name of the server as `serverName`, so that the server certificate matches the URL.
2. Make a browser file from the person certificate. Use the person key, the person certificate and `ca.crt`:
   `openssl pkcs12 -export -inkey <person key> -in person.crt -certfile ca.crt -out person.p12`
3. Import `person.p12` into the browser or the system key store.
4. Make the browser trust `ca.crt`. If you do not, the browser shows a certificate warning. The person CA also signs the server certificate.
5. Open `https://<server>:8444/` and pick the person certificate.

Do not share `person.p12`. Whoever holds it is the owner, because `op.rights` is not enforced yet.

The server listens on all interfaces. The route to port 8444 must pass TLS through to the server. A proxy that ends TLS removes the person certificate, and the page then has no access.
