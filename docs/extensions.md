# Extensions

Duree ships a complete hub for someone starting fresh: issues, memory, an activity log, and an artifact registry. A private overlay can add tools and routes without forking `core/`.

An extension is a module that default-exports this shape:

```ts
import type { Extension } from "duree/extend";

const extension: Extension = {
  name: "notes",
  registerTools(server, ctx) {
    server.registerTool("note_event", { description: "Append a note", inputSchema: /* zod */ undefined as never }, async (args) => {
      const result = ctx.store.commit(ctx.actor, {
        client_txn_id: `note:${args.summary}`,
        changes: [{ op: "event.append", type: "note", summary: args.summary }],
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
  },
  async handleHttp(request, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/extensions/notes") return null;
    const body = await request.json();
    const result = ctx.store.importRecords(ctx.actor, {
      client_txn_id: "notes-file",
      events: body.events,
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  },
};

export default extension;
```

`registerTools` runs for each MCP request, after the built-in tools. `handleHttp` runs only when the path is not a built-in `/v1` or `/admin` route. Return `null` to pass on.

`ctx.store` is the workspace store. Writes go through `commit`, which is atomic, idempotent on `client_txn_id`, and rejects a stale `expect` with the current values. `importRecords` turns arrays of generic events and artifacts into those commits. `listEvents` reads the activity log (`since`, `actor`, `type`, `project`, `unsuperseded`, `limit`, `cursor`). Omit `cursor` for the first page. The default page is 50 and a page is at most 200. The reply includes `next_cursor` when another page exists. Order is `ts` descending, then sync id, so the cursor stays put when newer events arrive. `getContext`, `getRecords`, `changes`, and `describe` are the same calls the built-in tools use. `list_events` is that read on MCP and `POST /v1/events`.

## Wire it in

In the overlay's `hub.yaml`:

```yaml
extensions:
  - ../my-overlay/extension.ts
```

Paths are relative to the overlay directory. Then regenerate the bundle (this rewrites `extensions/bundle.ts` and does not deploy):

```bash
npm run bundle-extensions -- --overlay examples/minimal
```

`npm run deploy -- --overlay ...` does the same rewrite before it renders Wrangler config. Leave the generated bundle out of any commit that is meant to stay generic. The copy in this repo registers nothing.

## Toy: import a JSONL file of events

Each line is one event. `id` is the idempotency key. `type` is a short lowercase word you choose. `supersedes` points at an earlier event id. `issue` optionally names an issue key or id. `details` is an object for fields this core does not model.

```json
{"id":"e1","ts":"2026-06-01T00:00:00Z","actor":"ada","type":"note","summary":"opened the work","refs":["README.md"]}
{"id":"e2","ts":"2026-06-01T01:00:00Z","actor":"ada","type":"correction","summary":"revised the note","supersedes":"e1","issue":"HUB-9"}
```

Artifact lines use `path` and `producer`. A `details` object, and any field that is not a known column, is stored on the artifact and returned by `get` and `get_context`. `details` must be an object and its JSON must be at most 4000 characters. Rows written before `details` existed read back as `details: null`.

```json
{"id":"f1","path":"notes/one.md","producer":"ada","ts":"2026-06-01T00:00:00Z","kind":"file","note":"scratch notes","checksum":"abc","details":{"lane":"desk"}}
```

Send them through the built-in importer, which calls `commit` in batches of 50. The same `client_txn_id` replays. The same row `id` does not create a second event even if the transaction id changes.

```bash
DUREE_TOKEN=... npm run import:jsonl -- \
  --events events.jsonl \
  --artifacts artifacts.jsonl \
  --client-txn notes-2026-06 \
  --url http://127.0.0.1:8787
```

Or `POST /v1/import` with `{ "client_txn_id", "events", "artifacts" }`. The caller needs `write:activity` (an admin token has it). Original `ts` values are stored as given. `sync_id` is assigned when the commit lands, so the change log stays gapless.

Activity text is rejected when it looks like a credential. Record a path or an id, not the secret.
