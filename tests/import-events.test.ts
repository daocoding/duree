import { describe, expect, it } from "vitest";
import { request, workspaceName } from "./helpers";

describe("generic JSONL import", () => {
  it("loads events and artifacts through commit, then replays", async () => {
    const name = workspaceName();
    const body = {
      client_txn_id: "import-batch-1",
      events: [
        { id: "e1", ts: "2026-06-01T00:00:00.000Z", actor: "ada", type: "note", summary: "opened the work", refs: ["README.md"] },
        { id: "e2", ts: "2026-06-01T01:00:00.000Z", actor: "ada", type: "correction", summary: "revised the note", supersedes: "e1", issue: "HUB-9" },
      ],
      artifacts: [
        { id: "f1", path: "notes/one.md", producer: "ada", ts: "2026-06-01T00:00:00.000Z", kind: "file", note: "scratch notes" },
      ],
    };
    const first = await request(name, "/v1/import", { body });
    expect(first.status).toBe(200);
    expect(first.data.ok).toBe(true);
    expect(first.data.commits[0].replayed).toBe(false);

    const got = await request(name, "/v1/get", { body: { ids: ["e1", "e2", "f1"] } });
    const original = got.data.records.find((row: { source_id: string }) => row.source_id === "e1");
    const revision = got.data.records.find((row: { source_id: string }) => row.source_id === "e2");
    const file = got.data.records.find((row: { source_id: string }) => row.source_id === "f1");
    expect(original.ts).toBe("2026-06-01T00:00:00.000Z");
    expect(revision.supersedes_id).toBe(original.id);
    expect(revision.issue_key).toBe("HUB-9");
    expect(file.path).toBe("notes/one.md");

    const described = await request(name, "/v1/describe");
    expect(described.data.counts.events).toBe(2);
    expect(described.data.counts.artifacts).toBe(1);

    const second = await request(name, "/v1/import", { body });
    expect(second.data.ok).toBe(true);
    expect(second.data.commits[0].replayed).toBe(true);
    expect(second.data.commits[0].commit_id).toBe(first.data.commits[0].commit_id);
    const after = await request(name, "/v1/describe");
    expect(after.data.counts.events).toBe(2);
    expect(after.data.version).toBe(described.data.version);
  });
});
