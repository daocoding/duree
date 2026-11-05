# Duree

Duree: memory as lived time for AI agents.

Agents are capable inside a single session and amnesiac across them. Duree is the duration they are missing: a shared issue tracker, a shared memory of facts, and an append-only activity ledger, exposed to agents over MCP. Facts are superseded, never erased. Decisions keep their reasons. A turn starts from what already happened.

The name is Bergson's durée: the past carried into the present, rather than stored as a pile of files.

There is no human UI. An agent turn is at most one read (`get_context`) and one write (`commit`). A conflict reply includes the current values, so a retry does not need another read.

## What Phase 1 ships

- A Cloudflare Worker and one SQLite-backed Durable Object per workspace.
- Issues, memory facts, activity events, artifacts, and a monotonic change log.
- Field-level last-writer-wins, required `expect` on status, assignee, and memory supersede, and idempotent `client_txn_id`s.
- Lexical search (FTS5) updated in the same transaction as the write.
- MCP tools `get_context`, `commit`, `get`, `changes`, and `describe`.
- A generic activity log and artifact registry, plus an extension point for extra tools, routes, and imports.
- Config with defaults, an example overlay, and a deploy script that validates and renders. This repository does not deploy anything.

Apache-2.0. Code and defaults live here. Account ids, routes, agent rosters, and tokens stay in a private overlay and in Worker secrets.

## Quickstart

```bash
npm install
npm test
npm run dev
```

`npm run dev` starts `wrangler dev`. The committed Worker config is for local use only. Its bootstrap token is the fixture `test-token-not-a-secret`. Do not use that token on a public deploy.

```bash
curl -s http://127.0.0.1:8787/health

curl -s http://127.0.0.1:8787/v1/describe \
  -H "authorization: Bearer test-token-not-a-secret"

curl -s http://127.0.0.1:8787/v1/commit \
  -H "authorization: Bearer test-token-not-a-secret" \
  -H "content-type: application/json" \
  -d '{"client_txn_id":"local-1","changes":[{"op":"issue.create","title":"first issue"}]}'
```

Point an MCP client at `http://127.0.0.1:8787/mcp` with the same bearer token. The handler is stateless `createMcpHandler` (Streamable HTTP).

## Tools

| Tool | Role |
| --- | --- |
| `get_context` | The one read. Ranked issues, memories, and activity events, the global version, and changes since the caller's last version. |
| `commit` | The one write. Atomic batch. Stale `expect` returns current values and applies nothing. |
| `get` | Full records when a snippet is not enough. Accepts ids, issue keys, and imported source ids. |
| `changes` | Raw change feed after a sync id. |
| `describe` | Schema, enums, caller, version. |

`commit` ops: `issue.create`, `issue.set`, `issue.comment`, `issue.link`, `memory.add`, `memory.supersede`, `memory.archive`, `event.append`, `artifact.add`, `deck.append`.

`event.append` records an activity entry: `type` (a short lowercase word), `summary`, optional `actor`, `ts`, `project`, `status`, `refs`, `issue`, `supersedes`, and `details`. Entries are append-only. A later event can point at the one it replaces with `supersedes`. Artifacts are `{ path, producer, ts, kind, note, details }`. Unknown artifact fields are kept in `details`. `POST /v1/import` loads JSONL-shaped arrays through `commit`, so a repeated `client_txn_id` replays and a repeated row `id` does not duplicate. `POST /v1/events` and the `list_events` tool page the activity log: omit `cursor` for the first page (default 50, at most 200), then pass `next_cursor`. Order is `ts` descending, then sync id. See [docs/extensions.md](docs/extensions.md).

`issue.set` on `status` and `assignee` requires `expect` (the field's current version). `memory.supersede` requires `expect` and writes a new fact that points at the old one. Description accepts `replace: { anchor, with }` and fails when the anchor is gone.

The same calls are available as JSON under `/v1/commit`, `/v1/get_context`, `/v1/get`, `/v1/changes`, and `GET /v1/describe`.

Authorship is the token's agent. A payload cannot claim another author. `on_behalf_of` is stored as data, not identity. Tokens are SHA-256 hashed in the Durable Object. `issue_token` and `revoke_token` are admin tools (`POST /admin/tokens` and `POST /admin/tokens/revoke`).

## Config

Every field has a default in [`config/defaults.yaml`](config/defaults.yaml). The typed schema is [`config/schema.ts`](config/schema.ts), and [`config/schema.json`](config/schema.json) is the JSON Schema for editors. Unknown keys and wrong types fail with the field path, before anything is rendered.

[`examples/minimal`](examples/minimal) is a complete overlay with fake values: an issue prefix, a pretend account id, and an agent roster with names and scopes only.

```bash
npm run deploy -- --overlay examples/minimal
```

That validates the overlay, merges it onto the defaults, and writes `dist/wrangler.rendered.json`. It does not deploy. `--apply` runs `wrangler deploy` and refuses the example account id. Set `DUREE_BOOTSTRAP_TOKEN` with `wrangler secret put` on a real account. The rendered file never contains that token, and it never turns on the local dev-auth flag.

A private overlay (not in this repo) should pin `core` and override only what differs. Tokens stay in Cloudflare secrets.

## Extensions

Extra MCP tools, HTTP routes, and importers belong in an overlay module named in config under `extensions`. Core loads that module from a generated bundle. The built-in importer is `POST /v1/import` and `npm run import:jsonl`. Both write through `commit`. [docs/extensions.md](docs/extensions.md) has a toy JSONL example.

```bash
curl -s http://127.0.0.1:8787/v1/import \
  -H "authorization: Bearer test-token-not-a-secret" \
  -H "content-type: application/json" \
  -d '{"client_txn_id":"local-events","events":[{"id":"e1","type":"note","summary":"opened the work","actor":"ada"}]}'
```

## Tests

```bash
npm test          # Workers (Miniflare) and Node
npm run test:workers
npm run test:node
npm run typecheck
npm run scan      # fail if a secret-shaped string is committed
```

Workers tests run inside the Workers runtime via `@cloudflare/vitest-plugin` (Miniflare) and cover:

- one `get_context` and one `commit`, including read-your-writes through FTS5
- idempotent `client_txn_id`
- a stale `expect` returning the current value and applying nothing
- an extension that adds one HTTP route and one MCP tool, both writing through `commit`
- generic JSONL import: original timestamps, supersede links, and a replay that does not duplicate rows

Node tests cover config validation, the example overlay, event normalization, and the secret scan.

## Layout

```
core/                 Worker, workspace Durable Object, commit, search, MCP
core/deck/            placeholder deck module
core/ranker/          lexical FTS5 ranker
extensions/bundle.ts  generated list of overlay modules (empty by default)
config/               schema, defaults, loader
docs/extensions.md    how to add tools, routes, and an importer
examples/minimal/     fake overlay
scripts/deploy        validate, bundle extensions, and render; --apply deploys
scripts/import-jsonl.ts
tests/                Miniflare tests
```

## Later phases

Not in this revision, on purpose:

- Hybrid retrieval, embeddings, and rerank. `retrieval.ranker: hybrid` is accepted and warned on; reads stay lexical. `get_context` reports `rerank_applied: false`.
- A swappable deck plugin loader. `deck.append` of kind `note` works. `deck.module` other than `deck-placeholder` fails validation.
- Workers AI, Vectorize, R2 export, rate limits, and memory consolidation.
- A private overlay repository. `examples/minimal` is the stand-in, with no real account and no tokens.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
