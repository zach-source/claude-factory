# Data Model: One factory CLI for every factory operation

## Rig (existing, in `rigs.json`)

The list is an array of rigs. The fields that this feature edits:

| Field          | Type                                   | Edit command                                  |
| -------------- | -------------------------------------- | --------------------------------------------- |
| `goal`         | string                                 | `rig set <rig> --goal ...`                    |
| `max`          | number                                 | `rig set --max`                               |
| `sweeps`       | string[]                               | `rig set --sweeps a,b` or `none`              |
| `runner`       | runner name                            | `rig set --runner`                            |
| `agent`        | command string                         | `rig set --agent`                             |
| `mcp`          | file path                              | `rig set --mcp`                               |
| `params`       | `name=value` list                      | `rig set --param`                             |
| `env`          | map of string to string                | `rig env set KEY=VALUE`, `rig env unset KEY`  |
| `egress`       | list of Egress rule                    | `rig egress add`, `rig egress rm`             |
| `beadsRemote`  | `{name, url, user}` or absent          | `rig beads-remote set`, `rig beads-remote clear` |

Rule: a change writes only the named fields. All other fields stay byte-equal after the write.

## Egress rule (existing)

| Field    | Type       | Note                                                  |
| -------- | ---------- | ----------------------------------------------------- |
| `hosts`  | string[]   | The identity of a rule. `egress rm` matches this list. |
| `port`   | number?    | Optional                                              |
| `key`    | string?    | Vault key name. A name, not a value.                  |
| `header` | string?    | Used with `key`                                       |
| `prefix` | string?    | Used with `key`                                       |

Validation: refused when the rig's runner has no egress policy.

## Rig snapshot

A copy of `rigs.json` in `rigs-history/<timestamp>.json`. The newest 20 stay. A restore is a normal write, so it makes a new snapshot.

## Factory setting (new, in `settings.json`)

`settings.json` is a flat object `{ "<key>": "<string value>" }`. It holds names and commands, never secret values.

| Key (CLI name)         | Env variable                 | Note                                        |
| ---------------------- | ---------------------------- | ------------------------------------------- |
| `ax.image`             | `FACTORY_AX_IMAGE`           | Set by `image build`                        |
| `ax.manager-image`     | `FACTORY_AX_MANAGER_IMAGE`   | Set by `image build --target manager`       |
| `ax.vault`             | `FACTORY_AX_VAULT`           | A name                                      |
| `ax.context`           | `FACTORY_AX_CONTEXT`         | Cluster context                             |
| `ax.atespace`          | `FACTORY_AX_ATESPACE`        | Namespace. Default `factory`                |
| `ax.capabilities`      | `FACTORY_AX_CAPABILITIES`    | Comma list. Default `SETUID,SETGID,CHOWN`   |
| `ax.env`               | `FACTORY_AX_ENV`             | Path of the extra env JSON file             |
| `kubectl`              | `FACTORY_KUBECTL`            | Default `kubectl`                           |
| `max-runs`             | `FACTORY_MAX_RUNS`           | Default 16                                  |
| `cursor.cap`           | `FACTORY_CURSOR_CAP`         | Weekly Cursor pool percent. Default 60      |
| `grok.weeklyBudgetUsd` | `FACTORY_GROK_WEEKLY_BUDGET_USD` | Weekly Grok spend in dollars. Unset: no gate |
| `image.registry`       | none                         | Used by `image build`                       |
| `image.builder`        | none                         | Used by `image build`                       |
| `token.read`           | none                         | Shell command. Prints one field value.      |
| `token.write`          | none                         | Shell command. Field name is `$1`, value on stdin. |
| `token.live-field`, `token.slot-field`, `token.active-field` | none | Field names in the store |
| `devenv.builder`, `devenv.token`, `devenv.push` | none | Stored in `devenv.json`, not `settings.json` |

The exact list is the `SETTING_KEYS` table in `src/settings.ts`. A key outside the table is refused.

### Resolved setting (computed, not stored)

`{ key, value, source }` with `source` one of `environment`, `stored`, `default`. Order: environment, stored, default. A secret-class value is shown as `<hidden>`.

## Token slot (computed from the store)

`{ n, hasToken, use7d, use5h, status, live }`. `status` is `ok`, `refused` (at its limit), `empty` (no token), or `error` (the probe failed or gave no status). The live slot number comes from the `token.active-field`. No token value is part of this record.

## Worker image

A string `registry/name@sha256:digest`. Stored only after a successful push.
