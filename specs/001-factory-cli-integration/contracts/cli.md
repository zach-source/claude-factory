# CLI contract

All commands are person-only (`refuseWorker`) except `rig show` and `rig list`. Exit code 0 means success. Exit code 1 means the CLI refused or failed, and it wrote nothing. No command prints a token or a secret value.

## Rig

```text
factory rig show <rig>
factory rig set <rig> [--goal '<text...>'] [--max n] [--sweeps a,b|none] [--runner r] [--agent cmd]
                      [--mcp file] [--param name=value]...
factory rig env set <rig> KEY=VALUE
factory rig env unset <rig> KEY
factory rig egress add <rig> host[,host]...[=KEY[:Header:Prefix]] [--port n]
factory rig egress rm <rig> host[,host]...
factory rig beads-remote set <rig> --name n --url u --user user
factory rig beads-remote clear <rig>
factory rig history
factory rig undo [n]
```

- `<rig>` is a rig name or a repo path.
- `--goal` takes the rest of the line, as in `rig add`.
- `rig set` with no field flag exits 1 with the usage text.
- A bad value exits 1, prints the reason, and leaves `rigs.json` unchanged.
- `rigs.json` that is not valid JSON exits 1 and names the file and the parse error.

## Settings

```text
factory settings list
factory settings set <key> <value>
factory settings unset <key>
```

Output of `list`: one row per key with `key`, `value`, `source`. When the environment overrides a stored value, the row says `environment (overrides stored)`.

## Image

```text
factory image build [--target worker|manager]
```

Prints `image@digest` on stdout. On success it stores the value in the setting. On failure the setting stays as it was.

## Token

```text
factory token [list]
factory token use <n>
factory token best
```

- `list` shows the live slot and the 7-day use, 5-hour use and status of each slot. With no store configured it prints how to set `token.read` and `token.write`.
- `use <n>` exits 1 and changes nothing when slot `n` has no token.
- `best` makes the slot with the lowest 7-day use live among the slots that are not refused. If all are refused it says so and changes nothing.
- A locked store or an interactive sign-in need exits 1 and changes nothing.

## Up

```text
factory up [factory-dir] [manager args...]
```

`factory-dir` defaults to `$FACTORY_HOME`, then `~/factory`. A missing `bun` or `claude` exits 1 and names the tool. Outside herdr it warns and goes on.
