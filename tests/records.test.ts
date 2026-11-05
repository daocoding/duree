import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { request, workspaceName } from "./helpers";

describe("artifact details", () => {
  it("round-trips details through commit, get, import, and context", async () => {
    const name = workspaceName();
    const committed = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "art-details",
        changes: [{
          op: "artifact.add",
          id: "f-commit",
          path: "notes/committed.md",
          producer: "ada",
          details: { lane: "desk", pages: 3 },
        }],
      },
    });
    expect(committed.data.ok).toBe(true);
    const got = await request(name, "/v1/get", { body: { ids: ["f-commit"] } });
    expect(got.data.records[0].details).toEqual({ lane: "desk", pages: 3 });

    const imported = await request(name, "/v1/import", {
      body: {
        client_txn_id: "art-import-details",
        artifacts: [{
          id: "f-import",
          path: "notes/imported.md",
          producer: "ada",
          checksum: "zirconiumlabel",
          details: { lane: "shelf" },
        }],
      },
    });
    expect(imported.data.ok).toBe(true);
    const importedGet = await request(name, "/v1/get", { body: { ids: ["f-import"] } });
    expect(importedGet.data.records[0].details).toEqual({ checksum: "zirconiumlabel", lane: "shelf" });
    const found = await request(name, "/v1/get_context", { body: { query: "zirconiumlabel", kinds: ["artifact"] } });
    expect(found.data.artifacts.some((row: { source_id: string }) => row.source_id === "f-import")).toBe(true);

    const plain = await request(name, "/v1/commit", {
      body: { client_txn_id: "art-plain", changes: [{ op: "artifact.add", id: "f-plain", path: "notes/plain.md", producer: "ada" }] },
    });
    expect(plain.data.ok).toBe(true);
    const plainGet = await request(name, "/v1/get", { body: { ids: ["f-plain"] } });
    expect(plainGet.data.records[0].details).toBeNull();
  });

  it("rejects an oversized details object and leaves the artifact unwritten", async () => {
    const name = workspaceName();
    const rejected = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "art-too-big",
        changes: [{
          op: "artifact.add",
          id: "f-big",
          path: "notes/big.md",
          producer: "ada",
          details: { blob: "a".repeat(4000) },
        }],
      },
    });
    expect(rejected.data.ok).toBe(false);
    expect(rejected.data.error).toBe("validation");
    expect(JSON.stringify(rejected.data.problems)).toContain("too large");
    const missing = await request(name, "/v1/get", { body: { ids: ["f-big"] } });
    expect(missing.data.records).toHaveLength(0);
  });

  it("adds details to an artifact table created before the column existed", async () => {
    const name = workspaceName();
    await request(name, "/v1/describe");
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(name));
    await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
      state.storage.sql.exec("ALTER TABLE artifacts DROP COLUMN details");
      state.storage.sql.exec(
        `INSERT INTO artifacts(id, source_id, path, host, producer, project, ts, kind, note, sync_id, created_by)
         VALUES ('art_legacy', 'legacy-src', 'old/path.md', NULL, 'ada', NULL, '2026-01-01T00:00:00.000Z', NULL, NULL, 1, 'legacy')`,
      );
    });
    await evictDurableObject(stub);
    const got = await request(name, "/v1/get", { body: { ids: ["legacy-src"] } });
    expect(got.data.records).toHaveLength(1);
    expect(got.data.records[0].path).toBe("old/path.md");
    expect(got.data.records[0].details).toBeNull();
    const described = await request(name, "/v1/describe");
    expect(described.data.schema_version).toBe(2);
  });
});

describe("event pages", () => {
  it("pages past 200 events in a stable order and keeps the first page when cursor is omitted", async () => {
    const name = workspaceName();
    const total = 250;
    const events = Array.from({ length: total }, (_, index) => ({
      id: `e${index}`,
      ts: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
      actor: "ada",
      type: "note",
      summary: `event ${index}`,
    }));
    const imported = await request(name, "/v1/import", { body: { client_txn_id: "page-events", events } });
    expect(imported.data.ok).toBe(true);

    const first = await request(name, "/v1/events", { body: { limit: 200 } });
    expect(first.data.events).toHaveLength(200);
    expect(first.data.next_cursor).toBeTruthy();
    expect(first.data.events[0].source_id).toBe("e249");
    expect(first.data.events[199].source_id).toBe("e50");

    const second = await request(name, "/v1/events", { body: { limit: 200, cursor: first.data.next_cursor } });
    expect(second.data.events).toHaveLength(50);
    expect(second.data.next_cursor).toBeNull();
    expect(second.data.events[0].source_id).toBe("e49");
    expect(second.data.events[49].source_id).toBe("e0");
    const ids = [...first.data.events, ...second.data.events].map((event: { source_id: string }) => event.source_id);
    expect(new Set(ids).size).toBe(total);

    const defaults = await request(name, "/v1/events", { body: {} });
    expect(defaults.data.events).toHaveLength(50);
    expect(defaults.data.events[0].source_id).toBe("e249");
    expect(defaults.data.next_cursor).toBeTruthy();

    const tied = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "same-ts",
        changes: [
          { op: "event.append", id: "tie-a", ts: "2026-02-01T00:00:00.000Z", type: "note", summary: "first write" },
          { op: "event.append", id: "tie-b", ts: "2026-02-01T00:00:00.000Z", type: "note", summary: "second write" },
        ],
      },
    });
    expect(tied.data.ok).toBe(true);
    const tiePage = await request(name, "/v1/events", {
      body: { since: "2026-02-01T00:00:00.000Z", limit: 10 },
    });
    const tieIds = tiePage.data.events.map((event: { source_id: string }) => event.source_id);
    expect(tieIds.indexOf("tie-b")).toBeLessThan(tieIds.indexOf("tie-a"));

    const bad = await request(name, "/v1/events", { body: { cursor: "not-a-cursor" } });
    expect(bad.data.ok).toBe(false);
    expect(bad.data.error).toBe("validation");
  });
});
