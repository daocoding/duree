import { z } from "zod";
import { describe, expect, it } from "vitest";
import { registerExtension } from "../core/extend";
import { request, workspaceName } from "./helpers";

registerExtension({
  name: "toy-notes",
  registerTools(server, ctx) {
    server.registerTool(
      "toy_note",
      {
        description: "Append one note to the activity log",
        inputSchema: z.object({ summary: z.string() }),
      },
      async ({ summary }) => {
        const result = ctx.store.commit(ctx.actor, {
          client_txn_id: `toy:${summary}`,
          changes: [{ op: "event.append", type: "note", summary }],
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );
  },
  async handleHttp(incoming, ctx) {
    const url = new URL(incoming.url);
    if (url.pathname !== "/extensions/toy") return null;
    const body = (await incoming.json()) as { summary?: string };
    const result = ctx.store.commit(ctx.actor, {
      client_txn_id: `http:${body.summary ?? ""}`,
      changes: [{ op: "event.append", type: "note", summary: body.summary ?? "" }],
    });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  },
});

describe("extension point", () => {
  it("serves an extra HTTP route and an extra MCP tool that commit events", async () => {
    const name = workspaceName();
    const posted = await request(name, "/extensions/toy", { body: { summary: "from the toy route" } });
    expect(posted.status).toBe(200);
    expect(posted.data.ok).toBe(true);
    const again = await request(name, "/extensions/toy", { body: { summary: "from the toy route" } });
    expect(again.data.replayed).toBe(true);

    const tool = await request(name, "/mcp", {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "toy_note", arguments: { summary: "from the toy tool" } },
      },
    });
    expect(tool.status, tool.text).toBe(200);
    const found = await request(name, "/v1/get_context", { body: { query: "toy tool", kinds: ["event"] } });
    expect(found.data.events.some((event: { summary: string }) => event.summary.includes("toy tool"))).toBe(true);

    const listed = await request(name, "/v1/get", { body: { ids: [posted.data.applied[0].id] } });
    expect(listed.data.records[0].summary).toBe("from the toy route");
    expect(listed.data.records[0].type).toBe("note");
  });
});
