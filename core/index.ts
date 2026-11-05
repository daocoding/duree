import "../extensions/bundle";

export { Workspace } from "./workspace";

const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({ ok: true, service: "duree", version: "0.1.0" });
    }
    const name = request.headers.get("x-duree-workspace")?.trim() || env.DUREE_WORKSPACE || "main";
    if (!WORKSPACE_NAME.test(name)) {
      return Response.json({ ok: false, error: "validation", problems: [{ message: "invalid workspace name" }] }, { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.set("x-duree-workspace", name);
    const forwarded = new Request(request, { headers });
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(name));
    return stub.fetch(forwarded);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
