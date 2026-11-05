import { sha256Hex } from "./hash";
import type { Actor } from "./types";
import { SCHEMA_VERSION } from "./types";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    assignee TEXT,
    labels TEXT NOT NULL DEFAULT '[]',
    parent_id TEXT,
    project TEXT,
    due TEXT,
    created_by TEXT NOT NULL,
    version INTEGER NOT NULL,
    field_versions TEXT NOT NULL,
    field_writers TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS issue_comments (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    sync_id INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS issue_links (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    type TEXT NOT NULL,
    sync_id INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, type)
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    owner TEXT,
    project TEXT,
    kind TEXT NOT NULL,
    subject TEXT,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    source_ref TEXT,
    confidence REAL,
    status TEXT NOT NULL,
    supersedes_id TEXT,
    expires_at TEXT,
    created_by TEXT NOT NULL,
    version INTEGER NOT NULL,
    field_versions TEXT NOT NULL,
    field_writers TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    source_id TEXT UNIQUE,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT,
    project TEXT,
    refs TEXT NOT NULL,
    issue_id TEXT,
    issue_key TEXT,
    supersedes_source TEXT,
    supersedes_id TEXT,
    details TEXT,
    sync_id INTEGER NOT NULL,
    created_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    source_id TEXT UNIQUE,
    path TEXT NOT NULL,
    host TEXT,
    producer TEXT NOT NULL,
    project TEXT,
    ts TEXT NOT NULL,
    kind TEXT,
    note TEXT,
    details TEXT,
    sync_id INTEGER NOT NULL,
    created_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS decks (
    id TEXT PRIMARY KEY,
    conversation_ref TEXT,
    owner TEXT,
    state TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deck_entries (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    author TEXT NOT NULL,
    version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS changes (
    sync_id INTEGER PRIMARY KEY,
    commit_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field TEXT,
    op TEXT NOT NULL,
    value TEXT,
    agent_id TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commits (
    commit_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    client_txn_id TEXT NOT NULL,
    first_sync_id INTEGER NOT NULL,
    last_sync_id INTEGER NOT NULL,
    on_behalf_of TEXT,
    result TEXT NOT NULL,
    UNIQUE (agent_id, client_txn_id)
  )`,
  `CREATE TABLE IF NOT EXISTS search_docs (
    doc_id TEXT PRIMARY KEY,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    chunk_no INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    sync_id INTEGER NOT NULL
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    doc_id UNINDEXED,
    entity UNINDEXED,
    entity_id UNINDEXED,
    title,
    text
  )`,
  `CREATE INDEX IF NOT EXISTS events_ts ON events(ts)`,
  `CREATE INDEX IF NOT EXISTS events_actor_ts ON events(actor, ts)`,
  `CREATE INDEX IF NOT EXISTS events_type ON events(type)`,
  `CREATE INDEX IF NOT EXISTS events_supersedes ON events(supersedes_id)`,
  `CREATE INDEX IF NOT EXISTS changes_entity ON changes(entity, entity_id)`,
  `CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, status)`,
  `CREATE INDEX IF NOT EXISTS issues_status ON issues(status)`,
];

export type SqlRow = Record<string, SqlStorageValue>;

export class Db {
  constructor(
    readonly storage: DurableObjectStorage,
    readonly env: Cloudflare.Env,
  ) {}

  migrate(): void {
    for (const statement of SCHEMA) this.storage.sql.exec(statement);
    this.ensureColumn("artifacts", "details", "TEXT");
    this.insertMeta("schema_version", String(SCHEMA_VERSION));
    this.insertMeta("last_sync_id", "0");
    this.insertMeta("index_version", "0");
    this.insertMeta("issue_seq", "0");
    const current = Number(this.meta("schema_version") ?? "0");
    if (current < SCHEMA_VERSION) this.setMeta("schema_version", String(SCHEMA_VERSION));
    if (!this.meta("issue_prefix")) {
      this.setMeta("issue_prefix", this.env.DUREE_ISSUE_PREFIX || "HUB");
    }
    if (!this.meta("statuses")) {
      this.setMeta("statuses", this.env.DUREE_STATUSES || "todo,in_progress,in_review,done,canceled");
    }
  }

  noteWorkspace(name: string): void {
    if (!this.meta("workspace")) this.setMeta("workspace", name);
  }

  exec<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.storage.sql.exec<SqlRow>(query, ...bindings).toArray() as T[];
  }

  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  meta(key: string): string | null {
    const rows = this.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
    return rows[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.storage.sql.exec(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** Additive column for databases created before the column existed. */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.exec<{ name: string }>(`PRAGMA table_info(${table})`);
    if (columns.some((item) => item.name === column)) return;
    this.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private insertMeta(key: string, value: string): void {
    this.storage.sql.exec("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)", key, value);
  }

  version(): number {
    return Number(this.meta("last_sync_id") ?? "0");
  }

  statuses(): string[] {
    return (this.meta("statuses") ?? "todo").split(",").filter(Boolean);
  }

  issuePrefix(): string {
    return this.meta("issue_prefix") ?? "HUB";
  }

  workspaceName(): string {
    return this.meta("workspace") ?? this.env.DUREE_WORKSPACE ?? "main";
  }

  /** Allocate `count` ids and return them in order. */
  allocIds(prefix: string, count: number): string[] {
    if (count <= 0) return [];
    const key = `seq:${prefix}`;
    const start = Number(this.meta(key) ?? "0");
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) ids.push(`${prefix}_${(start + i).toString(36)}`);
    this.setMeta(key, String(start + count));
    return ids;
  }

  nextId(prefix: string): string {
    return this.allocIds(prefix, 1)[0]!;
  }

  allocSync(count: number): { first: number; last: number } {
    const current = this.version();
    const first = current + 1;
    const last = current + count;
    this.setMeta("last_sync_id", String(last));
    this.setMeta("index_version", String(last));
    return { first, last };
  }

  nextIssueKey(): string {
    const next = Number(this.meta("issue_seq") ?? "0") + 1;
    this.setMeta("issue_seq", String(next));
    return `${this.issuePrefix()}-${next}`;
  }

  actorByHash(hash: string): Actor | null {
    const rows = this.exec<{ id: string; name: string; scopes: string; revoked_at: string | null }>(
      "SELECT id, name, scopes, revoked_at FROM agents WHERE token_hash = ?",
      hash,
    );
    const row = rows[0];
    if (!row || row.revoked_at) return null;
    return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) as string[] };
  }

  async ensureBootstrap(token: string): Promise<void> {
    const hash = await sha256Hex(token);
    const existing = this.exec<{ id: string }>("SELECT id FROM agents WHERE token_hash = ?", hash);
    if (existing.length > 0) return;
    const id = this.nextId("agent");
    const now = new Date().toISOString();
    this.storage.sql.exec(
      `INSERT INTO agents(id, name, kind, token_hash, scopes, revoked_at, created_at)
       VALUES (?, 'admin', 'admin', ?, ?, NULL, ?)`,
      id,
      hash,
      JSON.stringify(["admin"]),
      now,
    );
  }

  async insertAgent(name: string, token: string, scopes: string[], kind = "agent"): Promise<{ id: string }> {
    const hash = await sha256Hex(token);
    const id = this.nextId("agent");
    this.storage.sql.exec(
      `INSERT INTO agents(id, name, kind, token_hash, scopes, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      id,
      name,
      kind,
      hash,
      JSON.stringify(scopes),
      new Date().toISOString(),
    );
    return { id };
  }

  revokeAgent(idOrName: string): boolean {
    const rows = this.exec<{ id: string }>(
      "SELECT id FROM agents WHERE id = ? OR name = ?",
      idOrName,
      idOrName,
    );
    const row = rows[0];
    if (!row) return false;
    this.storage.sql.exec(
      "UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      new Date().toISOString(),
      row.id,
    );
    return true;
  }

  agentName(id: string): string {
    const rows = this.exec<{ name: string }>("SELECT name FROM agents WHERE id = ?", id);
    return rows[0]?.name ?? id;
  }

  writeChange(entry: {
    sync_id: number;
    commit_id: string;
    entity: string;
    entity_id: string;
    field: string | null;
    op: string;
    value: string | null;
    agent_id: string;
    at: string;
  }): void {
    this.storage.sql.exec(
      `INSERT INTO changes(sync_id, commit_id, entity, entity_id, field, op, value, agent_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.sync_id,
      entry.commit_id,
      entry.entity,
      entry.entity_id,
      entry.field,
      entry.op,
      entry.value,
      entry.agent_id,
      entry.at,
    );
  }

  indexDoc(
    doc: { entity: string; entity_id: string; title: string; text: string; sync_id: number },
    replace = true,
  ): void {
    const docId = `${doc.entity}:${doc.entity_id}`;
    const title = doc.title.slice(0, 500);
    const text = doc.text.slice(0, 8_000);
    if (replace) this.removeDoc(doc.entity, doc.entity_id);
    this.storage.sql.exec(
      `INSERT INTO search_docs(doc_id, entity, entity_id, chunk_no, title, text, sync_id)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
      docId,
      doc.entity,
      doc.entity_id,
      title,
      text,
      doc.sync_id,
    );
    this.storage.sql.exec(
      `INSERT INTO search_fts(doc_id, entity, entity_id, title, text) VALUES (?, ?, ?, ?, ?)`,
      docId,
      doc.entity,
      doc.entity_id,
      title,
      text,
    );
  }

  removeDoc(entity: string, entityId: string): void {
    const docId = `${entity}:${entityId}`;
    this.storage.sql.exec("DELETE FROM search_fts WHERE doc_id = ?", docId);
    this.storage.sql.exec("DELETE FROM search_docs WHERE doc_id = ?", docId);
  }

  /** Multi-row insert. Durable Object SQLite allows 100 bound parameters per statement. */
  insertRows(table: string, columns: string[], rows: SqlStorageValue[][]): void {
    const group = `(${columns.map(() => "?").join(",")})`;
    const width = Math.max(1, Math.floor(90 / columns.length));
    for (let offset = 0; offset < rows.length; offset += width) {
      const slice = rows.slice(offset, offset + width);
      const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${slice.map(() => group).join(",")}`;
      this.storage.sql.exec(sql, ...slice.flat());
    }
  }

  resolveSupersedes(): number {
    const before = this.exec<{ n: number }>(
      "SELECT count(*) AS n FROM events WHERE supersedes_source IS NOT NULL AND supersedes_id IS NULL",
    )[0]?.n ?? 0;
    this.storage.sql.exec(
      `UPDATE events
       SET supersedes_id = COALESCE(
         (SELECT t.id FROM events AS t WHERE t.source_id = events.supersedes_source LIMIT 1),
         (SELECT t.id FROM events AS t WHERE t.id = events.supersedes_source LIMIT 1)
       )
       WHERE supersedes_source IS NOT NULL
         AND supersedes_id IS NULL
         AND (
           EXISTS (SELECT 1 FROM events AS t WHERE t.source_id = events.supersedes_source)
           OR EXISTS (SELECT 1 FROM events AS t WHERE t.id = events.supersedes_source)
         )`,
    );
    const after = this.exec<{ n: number }>(
      "SELECT count(*) AS n FROM events WHERE supersedes_source IS NOT NULL AND supersedes_id IS NULL",
    )[0]?.n ?? 0;
    return before - after;
  }

  replayedCommit(agentId: string, clientTxnId: string): string | null {
    const rows = this.exec<{ result: string }>(
      "SELECT result FROM commits WHERE agent_id = ? AND client_txn_id = ?",
      agentId,
      clientTxnId,
    );
    return rows[0]?.result ?? null;
  }

  saveCommit(row: {
    commit_id: string;
    agent_id: string;
    client_txn_id: string;
    first_sync_id: number;
    last_sync_id: number;
    on_behalf_of: string | null;
    result: string;
  }): void {
    this.storage.sql.exec(
      `INSERT INTO commits(commit_id, agent_id, client_txn_id, first_sync_id, last_sync_id, on_behalf_of, result)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.commit_id,
      row.agent_id,
      row.client_txn_id,
      row.first_sync_id,
      row.last_sync_id,
      row.on_behalf_of,
      row.result,
    );
  }
}

export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function snippet(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}
