# Contract: front ends and parity

## The generic view

Each front end has one generic view. The generic view:

1. reads `GET /v1/catalog`
2. lists each operation by group, with its summary
3. shows a form for the inputs (a field for each input kind)
4. runs the operation through its route, with an idempotency key for a changing operation
5. shows the output by its kind: `table` as a table, `text` as text, `json` as folded JSON, `stream` as a live area
6. shows the status of a long operation until it is done

| Front end | Generic view |
| --- | --- |
| CLI | `factory op <name> [--<input> <value>]... [--json]`, and `factory op` to list. Help comes from the catalog. |
| Web UI | an "All operations" page in `web/` |
| Claude mod | `/factory op <name> ...` and a Commands tab |
| Herdr mod | an "All operations" dialog, bound to a key in `keys.json` |

## Own views

A front end can register its own view for an operation name, for example the board, the Interview or the chat. An own view:

- calls only catalog operations
- does not decide an outcome (no own rule, check or schedule)
- falls back to the generic view when the operation changed and the own view does not know the new inputs

## Hidden operations

A front end that cannot show an operation lists it in its hidden list. For example, the Herdr status band has one line. The entry names the front end that shows the operation. It shows a link or a command to that front end.

## parity-gaps.json

```json
[
  {
    "op": "runs.screen",
    "frontEnd": "herdr-mod",
    "bead": "claude-factory-xxxx",
    "reason": "the AX screen needs runs.screen in the core first"
  }
]
```

## The parity check

`src/parity.test.ts` fails the build when:

- a front end's generic view cannot run the fixture operation `catalog.echo`
- an own view or a hidden entry names an operation that is not in the catalog
- a hidden entry does not name a front end that shows the operation
- a gap entry has no bead id or no reason

`factory parity` (on the laptop, in the pre-push hook) also fails when a gap entry names a closed bead.
