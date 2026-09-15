# Portable Feishu Bitable control plane

This directory is the public, portable input for an agent that already has a
working `lark-cli` identity. It contains the existing contract-aware queue,
consumer, status, validation, and readback mechanism. It is not an installer,
runtime registry, schema provisioner, or replacement queue.

The package is deliberately namespace-neutral. It contains no tenant IDs,
remote table IDs, credentials, private paths, or business rows. A receiving
agent creates or adopts tables in its own namespace, records its own IDs in a
local untracked asset contract, and then uses the commands in
[`docs/SETUP.md`](docs/SETUP.md).

The table catalog in [`config/public-table-contracts.json`](config/public-table-contracts.json)
describes the required and conditional owner surfaces for the public platform
bundle. It is a field contract catalog, not a set of runnable private
registry entries. Table creation stays with the receiving agent through the
native Lark CLI and the relevant owner contract.

## Runtime

- Python `3.11.15` (`.python-version`); declared compatibility is `>=3.11,<3.12`.
- Runtime dependencies: none beyond the Python standard library.
- External dependency: the receiving agent's existing `lark-cli`, selected by
  `LARK_CLI_BIN`.
- The wrappers use `.venv/bin/python` by default. `SM_FEISHU_PYTHON` may point
  to an equivalent Python 3.11 interpreter for a controlled environment.

## Public surface

- `bin/feishu-sync-enqueue`: enqueue rows through the existing queue.
- `bin/feishu-sync-consumer`: invoke the existing queue drain consumer.
- `bin/feishu-sync-status`: read queue state and terminal readback evidence.
- `bin/sm-feishu`: exposes only `asset validate` and the existing `queue`
  `enqueue`, `consumer`, and `status` commands; schema creation remains with
  the user's native Lark CLI.
- `src/wendangwang_feishu/`: the import closure used by those commands.
- `tests/fixtures/public-demo.asset.json`: safe stub-only example; it uses
  `example.invalid` and is never part of a user's registry.
- `tests/`: local stub and end-to-end tests; they never contact Lark.

The exact export allowlist and exclusions are in
[`docs/PUBLIC-EXPORT.md`](docs/PUBLIC-EXPORT.md).
