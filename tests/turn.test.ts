import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TOKEN, request, workspaceName } from "./helpers";

const worker = (exports as unknown as { default: { fetch(request: Request): Promise<Response> } }).default;

describe("one read, one write", () => {
  it("answers health from the worker and forwards an authenticated call", async () => {
    const health = await worker.fetch(new Request("http://duree.test/health"));
    expect(health.status).toBe(200);
    const name = workspaceName();
    const denied = await worker.fetch(
      new Request("http://duree.test/v1/describe", { headers: { "x-duree-workspace": name } }),
    );
    expect(denied.status).toBe(401);
    const described = await worker.fetch(
      new Request("http://duree.test/v1/describe", {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: "application/json",
          "x-duree-workspace": name,
        },
      }),
    );
    expect(described.status).toBe(200);
    const body = (await described.json()) as { schema_version: number; workspace: string; agent_id: string };
    expect(body.schema_version).toBe(2);
    expect(body.workspace).toBe(name);
    expect(body.agent_id).toBeTruthy();
  });

  it("reads context and commits a batch that the next read can see", async () => {
    const name = workspaceName();
    const before = await request(name, "/v1/get_context", { body: { query: "" } });
    expect(before.status).toBe(200);
    expect(before.data.version).toBe(0);
    expect(before.data.ranker).toBe("lexical");

    const wrote = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "turn-1",
        changes: [
          { op: "issue.create", title: "flakyqa deploy check", description: "memory supersede path", status: "todo" },
          { op: "memory.add", content: "Quality runs checks on every deploy", kind: "fact" },
          { op: "event.append", type: "decision", summary: "keep the flakyqa check in the deploy path", actor: "example" },
        ],
      },
    });
    expect(wrote.data.ok).toBe(true);
    expect(wrote.data.replayed).toBe(false);
    expect(wrote.data.last_sync_id).toBe(wrote.data.first_sync_id + 2);
    expect(wrote.data.version).toBe(wrote.data.last_sync_id);

    const after = await request(name, "/v1/get_context", {
      body: { since: before.data.version, kinds: ["issue", "memory", "event"] },
    });
    expect(after.data.issues.some((issue: { title: string }) => issue.title.includes("flakyqa"))).toBe(true);
    expect(after.data.memories.some((memory: { content: string }) => memory.content.includes("Quality runs checks"))).toBe(true);
    expect(after.data.events.some((event: { summary: string }) => event.summary.includes("flakyqa"))).toBe(true);
    const searched = await request(name, "/v1/get_context", { body: { query: "flakyqa" } });
    expect(searched.data.issues.some((issue: { title: string }) => issue.title.includes("flakyqa"))).toBe(true);
    expect(searched.data.events.some((event: { summary: string }) => event.summary.includes("flakyqa"))).toBe(true);
    expect(after.data.changes_since).toHaveLength(3);
    expect(after.data.changes_since.map((row: { sync_id: number }) => row.sync_id)).toEqual(
      after.data.changes_since.map((row: { sync_id: number }) => row.sync_id).sort((a: number, b: number) => a - b),
    );
    expect(after.data.index_version).toBe(after.data.version);
  });

  it("replays the same client transaction id", async () => {
    const name = workspaceName();
    const body = {
      client_txn_id: "same-txn",
      changes: [{ op: "issue.create", title: "once" }],
    };
    const first = await request(name, "/v1/commit", { body });
    const second = await request(name, "/v1/commit", { body });
    expect(first.data.ok).toBe(true);
    expect(second.data.ok).toBe(true);
    expect(second.data.replayed).toBe(true);
    expect(second.data.commit_id).toBe(first.data.commit_id);
    const feed = await request(name, "/v1/changes", { body: { since: 0 } });
    expect(feed.data.changes).toHaveLength(1);
  });

  it("returns the current value when expect is stale and applies nothing", async () => {
    const name = workspaceName();
    const created = await request(name, "/v1/commit", {
      body: { client_txn_id: "create-status", changes: [{ op: "issue.create", title: "status race" }] },
    });
    const id = created.data.applied[0].id as string;
    const got = await request(name, "/v1/get", { body: { ids: [id] } });
    const expected = got.data.records[0].field_versions.status as number;
    const moved = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "move-status",
        changes: [{ op: "issue.set", id, field: "status", value: "in_progress", expect: expected }],
      },
    });
    expect(moved.data.ok).toBe(true);
    const stale = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "stale-status",
        changes: [{ op: "issue.set", id, field: "status", value: "done", expect: expected }],
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.data.ok).toBe(false);
    expect(stale.data.error).toBe("conflict");
    expect(stale.data.conflicts[0].actual).toBeGreaterThan(stale.data.conflicts[0].expected);
    expect(stale.data.conflicts[0].current).toBe("in_progress");
    expect(String(stale.data.conflicts[0].by)).toContain("agent:");
    const after = await request(name, "/v1/get", { body: { ids: [id] } });
    expect(after.data.records[0].status).toBe("in_progress");
  });

  it("rejects a stale assignee expect and returns the current assignee", async () => {
    const name = workspaceName();
    const created = await request(name, "/v1/commit", {
      body: { client_txn_id: "create-assignee", changes: [{ op: "issue.create", title: "assignee race" }] },
    });
    const id = created.data.applied[0].id as string;
    const got = await request(name, "/v1/get", { body: { ids: [id] } });
    const expected = got.data.records[0].field_versions.assignee as number;
    const assigned = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "assign-ada",
        changes: [{ op: "issue.set", id, field: "assignee", value: "ada", expect: expected }],
      },
    });
    expect(assigned.data.ok).toBe(true);
    const stale = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "assign-bao",
        changes: [{ op: "issue.set", id, field: "assignee", value: "bao", expect: expected }],
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.data.ok).toBe(false);
    expect(stale.data.error).toBe("conflict");
    expect(stale.data.conflicts[0].field).toBe("assignee");
    expect(stale.data.conflicts[0].actual).toBeGreaterThan(stale.data.conflicts[0].expected);
    expect(stale.data.conflicts[0].current).toBe("ada");
    const after = await request(name, "/v1/get", { body: { ids: [id] } });
    expect(after.data.records[0].assignee).toBe("ada");
  });

  it("rejects a stale memory supersede expect and returns the current fact", async () => {
    const name = workspaceName();
    const added = await request(name, "/v1/commit", {
      body: { client_txn_id: "fact-v1", changes: [{ op: "memory.add", content: "checks every deploy" }] },
    });
    const id = added.data.applied[0].id as string;
    const version = added.data.last_sync_id as number;
    const revised = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "fact-v2",
        changes: [{ op: "memory.supersede", id, expect: version, content: "checks every staging deploy" }],
      },
    });
    expect(revised.data.ok).toBe(true);
    const currentId = revised.data.created[id] as string;
    const stale = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "fact-v3",
        changes: [{ op: "memory.supersede", id: currentId, expect: version, content: "checks every production deploy" }],
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.data.ok).toBe(false);
    expect(stale.data.error).toBe("conflict");
    expect(stale.data.conflicts[0].field).toBe("content");
    expect(stale.data.conflicts[0].actual).toBeGreaterThan(stale.data.conflicts[0].expected);
    expect(stale.data.conflicts[0].current).toBe("checks every staging deploy");
    const after = await request(name, "/v1/get", { body: { ids: [currentId] } });
    expect(after.data.records[0].content).toBe("checks every staging deploy");
    expect(after.data.records[0].status).toBe("current");
  });

  it("writes twenty changes with no gaps and stamps the token agent", async () => {
    const name = workspaceName();
    const issued = await request(name, "/admin/tokens", {
      body: { name: "writer", scopes: ["write:issues"] },
    });
    expect(issued.data.ok).toBe(true);
    const token = issued.data.token as string;
    const agentId = issued.data.agent_id as string;
    for (let i = 0; i < 20; i++) {
      const result = await request(name, "/v1/commit", {
        token,
        body: {
          client_txn_id: `row-${i}`,
          on_behalf_of: "someone-else",
          changes: [{ op: "issue.create", title: `row ${i}`, author: "forged" }],
        },
      });
      expect(result.data.ok).toBe(true);
    }
    const feed = await request(name, "/v1/changes", { body: { since: 0, limit: 50 } });
    expect(feed.data.changes).toHaveLength(20);
    const ids = feed.data.changes.map((row: { sync_id: number; agent_id: string }) => row.sync_id);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => a - b));
    expect(new Set(ids).size).toBe(20);
    expect(ids[ids.length - 1] - ids[0]).toBe(19);
    expect(feed.data.changes.every((row: { agent_id: string }) => row.agent_id === agentId)).toBe(true);
  });

  it("keeps sync ids gapless across parallel commits", async () => {
    const name = workspaceName();
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const issued = await request(name, "/admin/tokens", {
        body: { name: `p${i}`, scopes: ["write:issues"] },
      });
      tokens.push(issued.data.token as string);
    }
    const results = await Promise.all(
      tokens.flatMap((token, tokenIndex) =>
        Array.from({ length: 10 }, (_, n) =>
          request(name, "/v1/commit", {
            token,
            body: {
              client_txn_id: `p-${tokenIndex}-${n}`,
              changes: [{ op: "issue.create", title: `parallel ${tokenIndex}-${n}` }],
            },
          }),
        ),
      ),
    );
    expect(results.every((result) => result.data.ok)).toBe(true);
    const syncIds = results.map((result) => result.data.first_sync_id as number).sort((a, b) => a - b);
    expect(new Set(syncIds).size).toBe(50);
    expect(syncIds[0]).toBe(1);
    expect(syncIds[49]).toBe(50);
  });

  it("hides another agent's private memory", async () => {
    const name = workspaceName();
    const other = await request(name, "/admin/tokens", {
      body: { name: "other", scopes: ["read", "write:memory"] },
    });
    const owner = await request(name, "/admin/tokens", {
      body: { name: "owner", scopes: ["read", "write:memory"] },
    });
    const added = await request(name, "/v1/commit", {
      token: owner.data.token,
      body: {
        client_txn_id: "private-fact",
        changes: [{ op: "memory.add", scope: "private", content: "only the owner should read this fact" }],
      },
    });
    const id = added.data.applied[0].id as string;
    const hidden = await request(name, "/v1/get", { token: other.data.token, body: { ids: [id] } });
    expect(hidden.data.records).toHaveLength(0);
    expect(hidden.data.missing).toContain(id);
    const context = await request(name, "/v1/get_context", {
      token: other.data.token,
      body: { query: "owner should read", kinds: ["memory"] },
    });
    expect(context.data.memories).toHaveLength(0);
    const feed = await request(name, "/v1/changes", { token: other.data.token, body: { since: 0 } });
    expect(feed.data.changes).toHaveLength(0);
    const visible = await request(name, "/v1/get", { token: owner.data.token, body: { ids: [id] } });
    expect(visible.data.records[0].content).toContain("only the owner");
  });

  it("supersedes a memory instead of editing it", async () => {
    const name = workspaceName();
    const added = await request(name, "/v1/commit", {
      body: { client_txn_id: "fact", changes: [{ op: "memory.add", content: "checks every deploy" }] },
    });
    const id = added.data.applied[0].id as string;
    const version = added.data.last_sync_id as number;
    const next = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "fact-2",
        changes: [{ op: "memory.supersede", id, expect: version, content: "checks every staging deploy" }],
      },
    });
    expect(next.data.ok).toBe(true);
    expect(next.data.created[id]).toBeTruthy();
    const old = await request(name, "/v1/get", { body: { ids: [id] } });
    expect(old.data.records[0].status).toBe("superseded");
    const created = await request(name, "/v1/get", { body: { ids: [next.data.created[id]] } });
    expect(created.data.records[0].supersedes_id).toBe(id);
    expect(created.data.records[0].content).toContain("staging");
  });

  it("rejects a missing anchor and an unauthenticated call", async () => {
    const name = workspaceName();
    const created = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "desc",
        changes: [{ op: "issue.create", title: "copy", description: "alpha beta" }],
      },
    });
    const id = created.data.applied[0].id as string;
    const missing = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "anchor",
        changes: [{ op: "issue.set", id, field: "description", replace: { anchor: "gone", with: "x" } }],
      },
    });
    expect(missing.data.ok).toBe(false);
    const replaced = await request(name, "/v1/commit", {
      body: {
        client_txn_id: "anchor-ok",
        changes: [{ op: "issue.set", id, field: "description", replace: { anchor: "beta", with: "gamma" } }],
      },
    });
    expect(replaced.data.ok).toBe(true);
    const got = await request(name, "/v1/get", { body: { ids: [id] } });
    expect(got.data.records[0].description).toBe("alpha gamma");

    const anon = await request(name, "/v1/describe", { token: null });
    expect(anon.status).toBe(401);
    const described = await request(name, "/v1/describe");
    expect(described.data.schema_version).toBe(2);
    expect(described.data.agent_id).toBeTruthy();
    expect(described.data.version).toBe(got.data.version);
  });

  it("returns 401 for a revoked token", async () => {
    const name = workspaceName();
    const issued = await request(name, "/admin/tokens", {
      body: { name: "temp", scopes: ["read"] },
    });
    const ok = await request(name, "/v1/describe", { token: issued.data.token });
    expect(ok.status).toBe(200);
    const revoked = await request(name, "/admin/tokens/revoke", { body: { agent_id: issued.data.agent_id } });
    expect(revoked.data.ok).toBe(true);
    const denied = await request(name, "/v1/describe", { token: issued.data.token });
    expect(denied.status).toBe(401);
  });
});
