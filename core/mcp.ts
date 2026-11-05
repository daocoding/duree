import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registeredExtensions } from "./extend";
import type { Store } from "./store";
import type { Actor } from "./types";

function toolText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

const loose = z.object({}).passthrough();

/**
 * One stateless MCP server per request. The actor is already resolved from
 * the bearer token, and every tool is a single call into the workspace store.
 */
export function buildMcpServer(store: Store, actor: Actor): McpServer {
  const server = new McpServer({ name: "duree", version: "0.1.0" });

  server.registerTool(
    "get_context",
    {
      description: "One read per turn: ranked issues, memories, and activity events, plus the global version and changes since.",
      inputSchema: z.object({
        query: z.string().optional(),
        task_id: z.string().optional(),
        deck_id: z.string().optional(),
        since: z.number().optional(),
        kinds: z.array(z.string()).optional(),
        limit: z.object({
          issue: z.number().optional(),
          memory: z.number().optional(),
          deck: z.number().optional(),
          event: z.number().optional(),
          artifact: z.number().optional(),
        }).optional(),
        filters: z.record(z.string(), z.array(z.string())).optional(),
        rerank: z.boolean().optional(),
      }),
    },
    async (args) => toolText(store.getContext(actor, args)),
  );

  server.registerTool(
    "commit",
    {
      description: "One write per turn. Applies a batch atomically, or rejects it and returns current values on conflict. Retries with the same client_txn_id replay.",
      inputSchema: z.object({
        client_txn_id: z.string(),
        deck_id: z.string().optional(),
        on_behalf_of: z.string().optional(),
        changes: z.array(loose).min(1).max(100),
      }),
    },
    async (args) => toolText(store.commit(actor, args)),
  );

  server.registerTool(
    "get",
    {
      description: "Full records by id, issue key, or imported source id.",
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(50),
        fields: z.array(z.string()).optional(),
      }),
    },
    async (args) => toolText(store.getRecords(actor, args)),
  );

  server.registerTool(
    "changes",
    {
      description: "Change feed after a sync id, in ascending order.",
      inputSchema: z.object({
        since: z.number().optional(),
        limit: z.number().optional(),
        entities: z.array(z.string()).optional(),
      }),
    },
    async (args) => toolText(store.changes(actor, args)),
  );

  server.registerTool(
    "describe",
    {
      description: "Schema, enums, ops, caller identity, and the current version.",
      inputSchema: z.object({}),
    },
    async () => toolText(store.describe(actor)),
  );

  for (const extension of registeredExtensions()) {
    extension.registerTools?.(server, { store, actor });
  }

  server.registerTool(
    "issue_token",
    {
      description: "Admin: mint an agent token. The plaintext token is returned once.",
      inputSchema: z.object({
        name: z.string(),
        scopes: z.array(z.string()).min(1),
      }),
    },
    async (args) => toolText(await store.issueToken(actor, args.name, args.scopes)),
  );

  server.registerTool(
    "revoke_token",
    {
      description: "Admin: revoke an agent by id or name. Later calls with that token return 401.",
      inputSchema: z.object({ agent_id: z.string() }),
    },
    async (args) => toolText(store.revokeToken(actor, args.agent_id)),
  );

  return server;
}
