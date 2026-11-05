import { registeredExtensions } from "./extend";
import type { Store } from "./store";
import type { Actor } from "./types";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function statusFor(error: string): number {
  switch (error) {
    case "forbidden":
      return 403;
    case "conflict":
      return 409;
    case "unauthorized":
      return 401;
    default:
      return 400;
  }
}

async function readBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const text = await request.text();
  if (text.length > 5_000_000) {
    return { ok: false, response: json({ ok: false, error: "validation", problems: [{ message: "body too large" }] }, 413) };
  }
  try {
    return { ok: true, body: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, response: json({ ok: false, error: "validation", problems: [{ message: "body is not JSON" }] }, 400) };
  }
}

export async function handleHttp(store: Store, actor: Actor, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method === "GET" && path === "/v1/describe") return json(store.describe(actor));

  if (request.method === "POST") {
    const known = path === "/v1/commit" || path === "/v1/get_context" || path === "/v1/get" || path === "/v1/changes" || path === "/v1/import" || path === "/admin/tokens" || path === "/admin/tokens/revoke";
    if (known) {
      const parsedBody = await readBody(request);
      if (!parsedBody.ok) return parsedBody.response;
      const body = parsedBody.body;
      const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      if (path === "/v1/commit") {
        const result = store.commit(actor, body);
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      if (path === "/v1/get_context") return json(store.getContext(actor, record));
      if (path === "/v1/get") return json(store.getRecords(actor, record));
      if (path === "/v1/changes") {
        return json(store.changes(actor, record as { since?: number; limit?: number; entities?: string[] }));
      }
      if (path === "/v1/import") {
        const result = store.importRecords(actor, {
          events: Array.isArray(record.events) ? record.events : [],
          artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
          client_txn_id: typeof record.client_txn_id === "string" ? record.client_txn_id : undefined,
        });
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      if (path === "/admin/tokens") {
        const result = await store.issueToken(actor, record.name, record.scopes);
        return json(result, result.ok ? 200 : statusFor(result.error));
      }
      const result = store.revokeToken(actor, record.agent_id);
      return json(result, result.ok ? 200 : statusFor(result.error));
    }
  }

  for (const extension of registeredExtensions()) {
    if (!extension.handleHttp) continue;
    const response = await extension.handleHttp(request, { store, actor });
    if (response) return response;
  }
  return json({ ok: false, error: "not_found" }, 404);
}
