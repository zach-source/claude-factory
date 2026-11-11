# Contract: cluster manifests

Covers FR-001, FR-004, FR-012, FR-013 and FR-018. These manifests go into the GitOps repo, in `<gitops-overlays>/factory/`. The owner merges them and Flux applies them.

## Objects

| Object | Content |
| --- | --- |
| Namespace `factory` | label `<component-label>: agent` |
| ServiceAccount `factory-server` | no cluster rights, because the `ax` CLI uses a token, not RBAC (R5) |
| PVC `factory-home` | `synology-iscsi-retain`, ReadWriteOnce, 50Gi |
| Deployment `factory-server` | 1 replica, `strategy: Recreate` (one writer), image `ghcr.io/<org>/factory-server:<sha>@<digest>`, the PVC at `/var/lib/factory`, `FACTORY_SERVER_MODE=1` |
| Service `factory-server` | ClusterIP, ports 8443 and 8444, for the manager task and the workers |
| Service `factory-server-lb` | LoadBalancer, `lbipam.cilium.io/ips: <lb-ip>`, port 8444 only |
| secret-sync items | `factory-github`, `factory-ax-auth`, `factory-backup`, `factory-tls` (server certificate and key), `factory-person-ca`, `factory-manager-cert`, `factory-linear` (optional) |
| CiliumNetworkPolicy | ingress 8444 from the LAN and WARP ranges, 8443 and 8444 from AX VM egress (atenet), 8080 from the kubelet. Egress to `ax-server`, the router, the broker, Dolt, github.com, api.github.com, ghcr.io, the attic proxy and the backup remote. |

## Image pull

The image is internal to the org. The pod needs a pull secret for `ghcr.io`, or the team copies the image to a mirror. The beads hold this choice.

## DNS and certificate

- The owner adds `factory.<private-zone> -> <lb-ip>` in the same place as `ax.<private-zone>`.
- `factory cert person <dir> factory.<private-zone>` makes the CA, the server certificate and the person certificate. The CA and the server key go into the password vault, and the person makes `person.p12` for the browser (docs/web.md).

## Not allowed

- No secret in the image, the PVC backup paths or the repo.
- No second replica. A rollout uses `Recreate`, so two pods never tick at the same time.
