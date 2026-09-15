# Preparation verification receipt

Date: `2026-09-14`
Network/auth writes: none
Pinned target: `lark-cli 1.0.93`

## Pinned CLI help

The unpacked `lark-cli 1.0.93` release was run locally with these read-only commands:

```text
node package/scripts/run.js --version
node package/scripts/run.js config init --help
node package/scripts/run.js profile --help
node package/scripts/run.js auth login --help
node package/scripts/run.js auth check --help
node package/scripts/run.js auth scopes --help
node package/scripts/run.js schema --help
```

Observed version: `lark-cli version 1.0.93`. The help surface confirmed `config init --new`, named profile commands (`add`, `list`, `remove`, `rename`, `use`), one repeatable/comma-capable `auth login --scope`, `auth check --scope`, `auth scopes`, and `schema <service.resource.method>`. No authorization flow was started.

The host's separately installed CLI reported `1.0.94`; it was used only for a read-only schema cross-check and is not substituted for the pinned help proof.

## Event and callback cross-check

The read-only event schema for `card.action.trigger` identifies it as a `callback`, bot-only, single-consumer, requiring `im:message:readonly` and the developer-console callback configuration. It is therefore assigned to the existing Node SDK `WSClient`; the public contract does not start a second CLI event consumer.

The ordinary `im.message.receive_v1` event is conditional and bot-only. It is enabled only when that message consumer is selected. No comment event subscription is enabled by this contract.

## Local tests

```text
node public-input/verify-public-input.mjs
  ok=true; checked 19 public files; network=not used

node --test public-input/verify-public-input.test.mjs
  tests=4; pass=4; fail=0; clean archive plus extra/missing/hash-mismatch negatives

(cd card-callback && npm ci --ignore-scripts && npm test)
  tests=46; pass=46; fail=0; cancelled=0
  node=v24.14.1; @larksuiteoapi/node-sdk=1.73.3
```

## Production dependency audit

```text
(cd card-callback && npm_config_registry=https://registry.npmjs.org npm audit --omit=dev)
  found 0 vulnerabilities
```

The lockfile resolves the production security floor to `axios 1.18.0`, `form-data 4.0.6`, `protobufjs 8.8.0`, and `qs 6.16.0`. The SDK is exact-pinned to `1.73.3`; the public manifest and package metadata use the same pin.

The selected versions were checked against the official npm package metadata and the affected-version ranges in the GitHub Advisory Database before regenerating the lockfile. No `npm audit fix --force` was used.

The package test command intentionally names the public unit-test set. The excluded e2e test contains machine-specific executable paths and is not a public input.

## Source references

- https://pkg.go.dev/github.com/larksuite/cli@v1.0.93/shortcuts/base
- https://pkg.go.dev/github.com/larksuite/cli@v1.0.93/shortcuts/wiki
- https://pkg.go.dev/github.com/larksuite/cli@v1.0.93/shortcuts/drive
- https://pkg.go.dev/github.com/larksuite/cli@v1.0.93/shortcuts/im
- https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-card-action-reply.md
