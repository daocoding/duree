import { DurableObject } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { handleHttp } from "./http";
import { buildMcpServer } from "./mcp";
import { Store } from "./store";

const EXECUTION = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

export class Workspace extends DurableObject<Cloudflare.Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store.migrate();
      const token = env.DUREE_BOOTSTRAP_TOKEN;
      if (token) await this.store.ensureBootstrap(token);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const workspace = request.headers.get("x-duree-workspace");
    if (workspace) this.store.noteWorkspace(workspace);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "duree", version: "0.1.0" });
    }

    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const actor = await this.store.actorFromToken(match[1]);
    if (!actor) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

    try {
      if (url.pathname === "/mcp") {
        const handler = createMcpHandler(() => buildMcpServer(this.store, actor), {
          route: "/mcp",
          responseMode: "json",
          allowedOriginHostnames: "*",
        });
        return await handler(request, this.env, EXECUTION);
      }
      return await handleHttp(this.store, actor, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      return Response.json({ ok: false, error: "internal", message }, { status: 500 });
    }
  }
}
