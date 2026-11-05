import { hasScope, parseScopes } from "./auth";
import { commit } from "./commit";
import { Db } from "./db";
import { randomToken, sha256Hex } from "./hash";
import { buildImportCommits } from "./import/jsonl";
import { changes, describe, getContext, getRecords, listEvents } from "./query";
import type { Actor, CommitResult } from "./types";

export class Store {
  readonly db: Db;

  constructor(storage: DurableObjectStorage, env: Cloudflare.Env) {
    this.db = new Db(storage, env);
  }

  migrate(): void {
    this.db.migrate();
  }

  noteWorkspace(name: string): void {
    this.db.noteWorkspace(name);
  }

  async ensureBootstrap(token: string): Promise<void> {
    await this.db.ensureBootstrap(token);
  }

  async actorFromToken(token: string): Promise<Actor | null> {
    return this.db.actorByHash(await sha256Hex(token));
  }

  commit(actor: Actor, input: unknown) {
    return commit(this.db, actor, input);
  }

  getContext(actor: Actor, input: Record<string, unknown>) {
    return getContext(this.db, actor, input);
  }

  getRecords(actor: Actor, input: { ids?: unknown; fields?: unknown }) {
    return getRecords(this.db, actor, input);
  }

  changes(actor: Actor, input: { since?: number; limit?: number; entities?: string[] }) {
    return changes(this.db, actor, input);
  }

  listEvents(
    actor: Actor,
    input: { since?: string; actor?: string; type?: string; project?: string; unsuperseded?: boolean; limit?: number },
  ) {
    return listEvents(this.db, actor, input);
  }

  describe(actor: Actor) {
    return describe(this.db, actor);
  }

  /** Split generic rows into idempotent commits. A repeated client_txn_id replays. */
  importRecords(actor: Actor, input: { events?: unknown[]; artifacts?: unknown[]; client_txn_id?: string }) {
    if (!hasScope(actor, "write:activity") && !hasScope(actor, "admin")) {
      return { ok: false as const, error: "forbidden" as const, version: this.db.version() };
    }
    const built = buildImportCommits({
      events: input.events,
      artifacts: input.artifacts,
      client_txn_id: input.client_txn_id,
      defaultActor: actor.name,
    });
    if (!built.ok) return { ...built, version: this.db.version() };
    const commits: CommitResult[] = [];
    for (const item of built.commits) commits.push(this.commit(actor, item));
    const failed = commits.find((item) => !item.ok);
    if (failed && !failed.ok) return failed;
    return {
      ok: true as const,
      version: this.db.version(),
      skipped: built.skipped,
      commits: commits.filter((item) => item.ok),
    };
  }

  async issueToken(actor: Actor, name: unknown, scopes: unknown) {
    if (!hasScope(actor, "admin")) {
      return { ok: false as const, error: "forbidden" as const, version: this.db.version() };
    }
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      return { ok: false as const, error: "validation" as const, version: this.db.version(), problems: [{ message: "name must be a short identifier" }] };
    }
    const parsed = parseScopes(scopes);
    if (!parsed) {
      return { ok: false as const, error: "validation" as const, version: this.db.version(), problems: [{ message: "scopes must be a non-empty list of known scopes" }] };
    }
    const token = randomToken();
    const created = await this.db.insertAgent(name, token, parsed);
    return { ok: true as const, agent_id: created.id, name, scopes: parsed, token };
  }

  revokeToken(actor: Actor, agentId: unknown) {
    if (!hasScope(actor, "admin")) {
      return { ok: false as const, error: "forbidden" as const, version: this.db.version() };
    }
    if (typeof agentId !== "string" || !agentId) {
      return { ok: false as const, error: "validation" as const, version: this.db.version(), problems: [{ message: "agent_id is required" }] };
    }
    const revoked = this.db.revokeAgent(agentId);
    if (!revoked) {
      return { ok: false as const, error: "validation" as const, version: this.db.version(), problems: [{ message: "agent not found" }] };
    }
    return { ok: true as const, agent_id: agentId, revoked: true };
  }
}
