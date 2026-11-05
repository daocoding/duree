import { env } from "cloudflare:workers";

export const TOKEN = "test-token-not-a-secret";

export function workspaceName(): string {
  return `t${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export async function request(
  name: string,
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; data: Record<string, any>; text: string }> {
  const headers = new Headers({
    "x-duree-workspace": name,
    accept: "application/json, text/event-stream",
  });
  if (options.token !== null) headers.set("authorization", `Bearer ${options.token ?? TOKEN}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(name));
  const response = await stub.fetch(
    new Request(`http://duree.test${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  const text = await response.text();
  let data: Record<string, any> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, text };
}
