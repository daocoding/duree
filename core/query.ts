import { hasScope } from "./auth";
import { searchLexical } from "./ranker/lexical";
import { Db, parseJson, snippet } from "./db";
import type { Actor } from "./types";
import { LINK_TYPES, SCOPES } from "./types";

const OPS = [
  "issue.create",
  "issue.set",
  "issue.comment",
  "issue.link",
  "memory.add",
  "memory.supersede",
  "memory.archive",
  "event.append",
  "artifact.add",
  "deck.append",
];

const TOOLS = [
  "get_context",
  "commit",
  "get",
  "changes",
  "describe",
  "issue_token",
  "revoke_token",
];

type Kind = "issue" | "memory" | "event" | "deck" | "artifact";

function denied(actor: Actor) {
  return !hasScope(actor, "read");
}

function clamp(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : fallback;
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(50, Math.floor(number)));
}

export function describe(db: Db, actor: Actor) {
  const counts = {
    issues: count(db, "issues"),
    memories: count(db, "memories"),
    events: count(db, "events"),
    artifacts: count(db, "artifacts"),
    changes: count(db, "changes"),
  };
  return {
    ok: true,
    schema_version: Number(db.meta("schema_version") ?? "1"),
    agent_id: actor.id,
    agent_name: actor.name,
    version: db.version(),
    index_version: Number(db.meta("index_version") ?? "0"),
    workspace: db.workspaceName(),
    issue_prefix: db.issuePrefix(),
    statuses: db.statuses(),
    link_types: LINK_TYPES,
    scopes: SCOPES,
    ops: OPS,
    tools: TOOLS,
    ranker: "lexical",
    counts,
  };
}

const COUNTABLE = new Set(["issues", "memories", "events", "artifacts", "changes"]);

function count(db: Db, table: string): number {
  if (!COUNTABLE.has(table)) throw new Error(`unknown table ${table}`);
  const rows = db.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
}

export function changes(db: Db, actor: Actor, input: { since?: number; limit?: number; entities?: string[] }) {
  if (denied(actor)) return { ok: false as const, error: "forbidden" as const, version: db.version() };
  const since = typeof input.since === "number" ? input.since : 0;
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const entities = input.entities?.filter((entity) => typeof entity === "string") ?? [];
  const filter = entities.length > 0 ? ` AND c.entity IN (${entities.map(() => "?").join(",")})` : "";
  const rows = db.exec<{
    sync_id: number;
    commit_id: string;
    entity: string;
    entity_id: string;
    field: string | null;
    op: string;
    value: string | null;
    agent_id: string;
    at: string;
  }>(
    `SELECT c.sync_id, c.commit_id, c.entity, c.entity_id, c.field, c.op, c.value, c.agent_id, c.at
     FROM changes c
     LEFT JOIN memories m ON c.entity = 'memory' AND m.id = c.entity_id
     WHERE c.sync_id > ?
       AND (c.entity != 'memory' OR m.id IS NULL OR m.scope != 'private' OR m.owner = ?)
       ${filter}
     ORDER BY c.sync_id ASC
     LIMIT ?`,
    since,
    actor.id,
    ...entities,
    limit + 1,
  );
  const truncated = rows.length > limit;
  return {
    ok: true as const,
    version: db.version(),
    since,
    truncated,
    changes: rows.slice(0, limit).map((row) => ({
      sync_id: row.sync_id,
      commit_id: row.commit_id,
      entity: row.entity,
      id: row.entity_id,
      field: row.field,
      op: row.op,
      value: row.value ? parseJson(row.value, row.value) : null,
      agent_id: row.agent_id,
      at: row.at,
    })),
  };
}

export function getRecords(db: Db, actor: Actor, input: { ids?: unknown; fields?: unknown }) {
  if (denied(actor)) return { ok: false as const, error: "forbidden" as const, version: db.version() };
  if (!Array.isArray(input.ids) || input.ids.length === 0) {
    return { ok: false as const, error: "validation" as const, version: db.version(), problems: [{ message: "ids is required" }] };
  }
  const records = [];
  const missing: string[] = [];
  for (const raw of input.ids.slice(0, 50)) {
    if (typeof raw !== "string") continue;
    const record = loadAny(db, actor, raw);
    if (record) records.push(record);
    else missing.push(raw);
  }
  return { ok: true as const, version: db.version(), records, missing };
}

function loadAny(db: Db, actor: Actor, id: string): Record<string, unknown> | null {
  const issue = db.exec<Record<string, SqlStorageValue>>(
    "SELECT * FROM issues WHERE id = ? OR key = ?",
    id,
    id,
  )[0];
  if (issue && issue.deleted !== 1) return presentIssue(db, issue);

  const memory = db.exec<Record<string, SqlStorageValue>>("SELECT * FROM memories WHERE id = ?", id)[0];
  if (memory) {
    if (memory.scope === "private" && memory.owner !== actor.id) return null;
    return presentMemory(memory);
  }

  const event = db.exec<Record<string, SqlStorageValue>>(
    "SELECT * FROM events WHERE id = ? OR source_id = ?",
    id,
    id,
  )[0];
  if (event) return presentEvent(event);

  const artifact = db.exec<Record<string, SqlStorageValue>>(
    "SELECT * FROM artifacts WHERE id = ? OR source_id = ?",
    id,
    id,
  )[0];
  if (artifact) return presentArtifact(artifact);

  const deck = db.exec<Record<string, SqlStorageValue>>("SELECT * FROM deck_entries WHERE id = ?", id)[0];
  if (deck) {
    return {
      entity: "deck",
      id: deck.id,
      deck_id: deck.deck_id,
      kind: deck.kind,
      payload: parseJson(String(deck.payload), {}),
      ordinal: deck.ordinal,
      author: deck.author,
      version: deck.version,
    };
  }
  return null;
}

function presentIssue(db: Db, issue: Record<string, SqlStorageValue>) {
  const comments = db.exec<{ id: string; author: string; body: string; sync_id: number }>(
    "SELECT id, author, body, sync_id FROM issue_comments WHERE issue_id = ? ORDER BY sync_id DESC LIMIT 20",
    String(issue.id),
  );
  return {
    entity: "issue",
    id: issue.id,
    key: issue.key,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assignee: issue.assignee,
    labels: parseJson(String(issue.labels), []),
    parent_id: issue.parent_id,
    project: issue.project,
    due: issue.due,
    created_by: issue.created_by,
    version: issue.version,
    field_versions: parseJson(String(issue.field_versions), {}),
    deleted: issue.deleted === 1,
    comments,
  };
}

function presentMemory(memory: Record<string, SqlStorageValue>) {
  return {
    entity: "memory",
    id: memory.id,
    scope: memory.scope,
    owner: memory.owner,
    project: memory.project,
    kind: memory.kind,
    subject: memory.subject,
    content: memory.content,
    tags: parseJson(String(memory.tags), []),
    source_ref: memory.source_ref,
    confidence: memory.confidence,
    status: memory.status,
    supersedes_id: memory.supersedes_id,
    created_by: memory.created_by,
    version: memory.version,
    field_versions: parseJson(String(memory.field_versions), {}),
  };
}

export function presentEvent(event: Record<string, SqlStorageValue>) {
  return {
    entity: "event",
    id: event.id,
    source_id: event.source_id,
    ts: event.ts,
    actor: event.actor,
    type: event.type,
    summary: event.summary,
    status: event.status,
    project: event.project,
    refs: parseJson(String(event.refs ?? "[]"), []),
    issue_id: event.issue_id,
    issue_key: event.issue_key,
    supersedes_id: event.supersedes_id,
    supersedes_source: event.supersedes_source,
    details: event.details ? parseJson(String(event.details), {}) : null,
    sync_id: event.sync_id,
    created_by: event.created_by,
  };
}

export function presentArtifact(artifact: Record<string, SqlStorageValue>) {
  return {
    entity: "artifact",
    id: artifact.id,
    source_id: artifact.source_id,
    path: artifact.path,
    host: artifact.host,
    producer: artifact.producer,
    project: artifact.project,
    ts: artifact.ts,
    kind: artifact.kind,
    note: artifact.note,
    sync_id: artifact.sync_id,
    created_by: artifact.created_by,
  };
}

export function getContext(db: Db, actor: Actor, input: Record<string, unknown>) {
  if (denied(actor)) return { ok: false as const, error: "forbidden" as const, version: db.version() };
  const query = typeof input.query === "string" ? input.query : "";
  const kinds = normalizeKinds(input.kinds);
  if (!kinds) {
    return { ok: false as const, error: "validation" as const, version: db.version(), problems: [{ message: "unknown kind" }] };
  }
  const limitInput = input.limit && typeof input.limit === "object" ? (input.limit as Record<string, unknown>) : {};
  const limits: Record<Kind, number> = {
    issue: clamp(limitInput.issue, 8),
    memory: clamp(limitInput.memory, 12),
    deck: clamp(limitInput.deck, 10),
    event: clamp(limitInput.event, 10),
    artifact: clamp(limitInput.artifact, 8),
  };
  const statusFilter = readStatusFilter(input.filters);
  if (statusFilter === "invalid") {
    return {
      ok: false as const,
      error: "validation" as const,
      version: db.version(),
      problems: [{ message: "filters currently accepts only issue.status" }],
    };
  }

  const version = db.version();
  const taskId = typeof input.task_id === "string" ? input.task_id : undefined;
  const pinned = taskId ? loadPinned(db, taskId) : null;
  const buckets: Record<Kind, Array<Record<string, unknown>>> = {
    issue: [],
    memory: [],
    event: [],
    deck: [],
    artifact: [],
  };

  if (query.trim()) {
    const hits = searchLexical(db, query, 80);
    for (const hit of hits) {
      const kind = hit.entity as Kind;
      if (!kinds.has(kind) || buckets[kind].length >= limits[kind]) continue;
      const record = hitToRecord(db, actor, kind, hit.entity_id, hit.score, statusFilter);
      if (record) buckets[kind].push(record);
    }
  } else {
    if (kinds.has("issue")) buckets.issue = recentIssues(db, limits.issue, statusFilter);
    if (kinds.has("memory")) buckets.memory = recentMemories(db, actor, limits.memory);
    if (kinds.has("event")) buckets.event = recentEvents(db, limits.event);
    if (kinds.has("artifact")) buckets.artifact = recentArtifacts(db, limits.artifact);
  }

  const deckId = typeof input.deck_id === "string" ? input.deck_id : undefined;
  if (deckId && (kinds.has("deck") || input.kinds === undefined)) {
    buckets.deck = recentDeck(db, deckId, limits.deck);
  }

  let changesSince: ReturnType<typeof changes>["changes"] = [];
  let truncated = false;
  if (typeof input.since === "number") {
    const feed = changes(db, actor, { since: input.since, limit: 100 });
    if (feed.ok) {
      changesSince = feed.changes;
      truncated = feed.truncated;
    }
  }

  return {
    ok: true as const,
    version,
    index_version: Number(db.meta("index_version") ?? version),
    ranker: "lexical",
    rerank_applied: false,
    pinned: pinned ? { issue: pinned } : null,
    issues: buckets.issue,
    memories: buckets.memory,
    events: buckets.event,
    deck: buckets.deck,
    artifacts: buckets.artifact,
    changes_since: changesSince,
    truncated,
  };
}

function normalizeKinds(value: unknown): Set<Kind> | null {
  const all: Kind[] = ["issue", "memory", "event", "deck", "artifact"];
  if (value === undefined) return new Set(["issue", "memory", "event"]);
  if (!Array.isArray(value)) return null;
  const kinds = new Set<Kind>();
  for (const item of value) {
    if (!all.includes(item as Kind)) return null;
    kinds.add(item as Kind);
  }
  return kinds;
}

function readStatusFilter(filters: unknown): string[] | null | "invalid" {
  if (filters === undefined) return null;
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return "invalid";
  const record = filters as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  if (keys.some((key) => key !== "issue.status")) return "invalid";
  const value = record["issue.status"];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return "invalid";
  return value as string[];
}

function loadPinned(db: Db, taskId: string) {
  const rows = db.exec<Record<string, SqlStorageValue>>(
    "SELECT * FROM issues WHERE (id = ? OR key = ?) AND deleted = 0",
    taskId,
    taskId,
  );
  const issue = rows[0];
  if (!issue) return null;
  return {
    id: issue.id,
    key: issue.key,
    title: issue.title,
    status: issue.status,
    version: issue.version,
    field_versions: parseJson(String(issue.field_versions), {}),
  };
}

function hitToRecord(
  db: Db,
  actor: Actor,
  kind: Kind,
  id: string,
  score: number,
  statusFilter: string[] | null,
): Record<string, unknown> | null {
  if (kind === "issue") {
    const issue = db.exec<Record<string, SqlStorageValue>>("SELECT * FROM issues WHERE id = ? AND deleted = 0", id)[0];
    if (!issue) return null;
    if (statusFilter && !statusFilter.includes(String(issue.status))) return null;
    return {
      id: issue.id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
      score,
      snippet: snippet(`${issue.title} ${issue.description}`),
      version: issue.version,
    };
  }
  if (kind === "memory") {
    const memory = db.exec<Record<string, SqlStorageValue>>(
      "SELECT * FROM memories WHERE id = ? AND status = 'current'",
      id,
    )[0];
    if (!memory) return null;
    if (memory.scope === "private" && memory.owner !== actor.id) return null;
    return {
      id: memory.id,
      kind: memory.kind,
      scope: memory.scope,
      content: memory.content,
      score,
      snippet: snippet(String(memory.content)),
      version: memory.version,
    };
  }
  if (kind === "event") {
    const event = db.exec<Record<string, SqlStorageValue>>("SELECT * FROM events WHERE id = ?", id)[0];
    if (!event) return null;
    return { ...presentEvent(event), score, snippet: snippet(String(event.summary)) };
  }
  if (kind === "artifact") {
    const artifact = db.exec<Record<string, SqlStorageValue>>("SELECT * FROM artifacts WHERE id = ?", id)[0];
    if (!artifact) return null;
    return { ...presentArtifact(artifact), score, snippet: snippet(`${artifact.path} ${artifact.note ?? ""}`) };
  }
  const entry = db.exec<Record<string, SqlStorageValue>>("SELECT * FROM deck_entries WHERE id = ?", id)[0];
  if (!entry) return null;
  const payload = parseJson<Record<string, unknown>>(String(entry.payload), {});
  return {
    id: entry.id,
    deck_id: entry.deck_id,
    kind: entry.kind,
    payload,
    score,
    snippet: snippet(typeof payload.text === "string" ? payload.text : ""),
    version: entry.version,
  };
}

function recentIssues(db: Db, limit: number, statusFilter: string[] | null) {
  const rows = db.exec<Record<string, SqlStorageValue>>(
    "SELECT * FROM issues WHERE deleted = 0 ORDER BY version DESC LIMIT 80",
  );
  const out = [];
  for (const issue of rows) {
    if (statusFilter && !statusFilter.includes(String(issue.status))) continue;
    out.push({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      status: issue.status,
      snippet: snippet(`${issue.title} ${issue.description}`),
      version: issue.version,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function recentMemories(db: Db, actor: Actor, limit: number) {
  const rows = db.exec<Record<string, SqlStorageValue>>(
    `SELECT * FROM memories
     WHERE status = 'current' AND (scope != 'private' OR owner = ?)
     ORDER BY version DESC LIMIT ?`,
    actor.id,
    limit,
  );
  return rows.map((memory) => ({
    id: memory.id,
    kind: memory.kind,
    scope: memory.scope,
    content: memory.content,
    snippet: snippet(String(memory.content)),
    version: memory.version,
  }));
}

function recentEvents(db: Db, limit: number) {
  return db
    .exec<Record<string, SqlStorageValue>>("SELECT * FROM events ORDER BY sync_id DESC LIMIT ?", limit)
    .map((event) => ({ ...presentEvent(event), snippet: snippet(String(event.summary)) }));
}

export function listEvents(
  db: Db,
  actor: Actor,
  input: { since?: string; actor?: string; type?: string; project?: string; unsuperseded?: boolean; limit?: number },
) {
  if (denied(actor)) return { ok: false as const, error: "forbidden" as const, version: db.version() };
  const since = input.since ?? null;
  const actorName = input.actor ?? null;
  const type = input.type ?? null;
  const project = input.project ?? null;
  const unsuperseded = input.unsuperseded ? 1 : 0;
  const limit = Math.max(1, Math.min(200, input.limit ?? 50));
  const rows = db.exec<Record<string, SqlStorageValue>>(
    `SELECT * FROM events
     WHERE (? IS NULL OR ts >= ?)
       AND (? IS NULL OR actor = ?)
       AND (? IS NULL OR type = ?)
       AND (? IS NULL OR project = ?)
       AND (? = 0 OR NOT EXISTS (SELECT 1 FROM events newer WHERE newer.supersedes_id = events.id))
     ORDER BY ts DESC, sync_id DESC
     LIMIT ?`,
    since, since, actorName, actorName, type, type, project, project, unsuperseded, limit,
  );
  return { ok: true as const, version: db.version(), events: rows.map(presentEvent) };
}

function recentArtifacts(db: Db, limit: number) {
  return db
    .exec<Record<string, SqlStorageValue>>("SELECT * FROM artifacts ORDER BY sync_id DESC LIMIT ?", limit)
    .map((artifact) => presentArtifact(artifact));
}

function recentDeck(db: Db, deckId: string, limit: number) {
  return db
    .exec<Record<string, SqlStorageValue>>(
      "SELECT * FROM deck_entries WHERE deck_id = ? ORDER BY ordinal DESC LIMIT ?",
      deckId,
      limit,
    )
    .map((entry) => ({
      id: entry.id,
      deck_id: entry.deck_id,
      kind: entry.kind,
      payload: parseJson(String(entry.payload), {}),
      version: entry.version,
    }));
}
