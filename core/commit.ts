import { hasScope } from "./auth";
import { deckPlaceholder } from "./deck/placeholder";
import { Db, parseJson } from "./db";
import type { Actor, CommitResult, Conflict, Problem } from "./types";
import { GUARDED_ISSUE_FIELDS, ISSUE_FIELDS, LINK_TYPES, MEMORY_SCOPES } from "./types";
import { normalizeArtifact, normalizeEvent } from "./records";

interface IssueRow {
  id: string;
  key: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  assignee: string | null;
  labels: string;
  parent_id: string | null;
  project: string | null;
  due: string | null;
  created_by: string;
  version: number;
  field_versions: string;
  field_writers: string;
  deleted: number;
}

interface MemoryRow {
  id: string;
  scope: string;
  owner: string | null;
  project: string | null;
  kind: string;
  subject: string | null;
  content: string;
  tags: string;
  source_ref: string | null;
  confidence: number | null;
  status: string;
  supersedes_id: string | null;
  expires_at: string | null;
  created_by: string;
  version: number;
  field_versions: string;
  field_writers: string;
}

type Op = Record<string, unknown>;

interface Prepared {
  op: string;
  /** Row already stored under this source id. Does not consume a sync id. */
  deduped?: { id: string; sync_id: number };
  apply?: (syncId: number, commitId: string) => { id: string; createdFrom?: string };
}

function problem(index: number, op: string, message: string): Problem {
  return { index, op, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function commit(db: Db, actor: Actor, input: unknown): CommitResult {
  const version = () => db.version();
  if (!isRecord(input)) {
    return { ok: false, error: "validation", version: version(), problems: [{ message: "commit body must be an object" }] };
  }
  const clientTxn = typeof input.client_txn_id === "string" ? input.client_txn_id.trim() : "";
  if (!clientTxn || clientTxn.length > 200) {
    return {
      ok: false,
      error: "validation",
      version: version(),
      problems: [{ message: "client_txn_id is required and must be at most 200 characters" }],
    };
  }
  const stored = db.replayedCommit(actor.id, clientTxn);
  if (stored) {
    const parsed = JSON.parse(stored) as CommitResult;
    return parsed.ok ? { ...parsed, replayed: true } : parsed;
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    return { ok: false, error: "validation", version: version(), problems: [{ message: "changes must be a non-empty array" }] };
  }
  const changes = input.changes as unknown[];
  if (changes.length > 100) {
    return { ok: false, error: "validation", version: version(), problems: [{ message: "a commit accepts at most 100 changes" }] };
  }
  const onBehalf = typeof input.on_behalf_of === "string" ? input.on_behalf_of.slice(0, 200) : null;
  const deckId = typeof input.deck_id === "string" ? input.deck_id : undefined;

  return db.tx(() => {
    const problems: Problem[] = [];
    const conflicts: Conflict[] = [];
    const prepared: Prepared[] = [];
    changes.forEach((raw: unknown, index: number) => {
      if (!isRecord(raw) || typeof raw.op !== "string") {
        problems.push(problem(index, "?", "each change needs an op"));
        return;
      }
      const outcome = prepare(db, actor, raw, index, deckId);
      if (outcome.problem) problems.push(outcome.problem);
      if (outcome.conflict) conflicts.push(outcome.conflict);
      if (outcome.prepared) prepared.push(outcome.prepared);
    });
    const current = db.version();
    if (problems.length > 0) {
      const forbidden = problems.every(
        (item) => item.message.startsWith("missing scope") || item.message.startsWith("private memory"),
      );
      return {
        ok: false as const,
        error: forbidden ? ("forbidden" as const) : ("validation" as const),
        version: current,
        problems,
      };
    }
    if (conflicts.length > 0) {
      return { ok: false as const, error: "conflict" as const, version: current, conflicts };
    }

    const writers = prepared.filter((item) => !item.deduped);
    const commitId = db.nextId("c");
    const created: Record<string, string> = {};
    const applied: Array<{ op: string; id: string; sync_id: number }> = [];
    let first = current;
    let last = current;
    let replayed = false;
    if (writers.length === 0) {
      replayed = true;
      for (const item of prepared) {
        if (item.deduped) applied.push({ op: item.op, id: item.deduped.id, sync_id: item.deduped.sync_id });
      }
    } else {
      const range = db.allocSync(writers.length);
      first = range.first;
      let syncId = range.first;
      for (const item of prepared) {
        if (item.deduped) {
          applied.push({ op: item.op, id: item.deduped.id, sync_id: item.deduped.sync_id });
          continue;
        }
        const result = item.apply!(syncId, commitId);
        applied.push({ op: item.op, id: result.id, sync_id: syncId });
        if (result.createdFrom) created[result.createdFrom] = result.id;
        syncId += 1;
      }
      last = range.last;
    }
    const success = {
      ok: true as const,
      commit_id: commitId,
      first_sync_id: first,
      last_sync_id: last,
      version: last,
      replayed,
      created,
      applied,
    };
    db.saveCommit({
      commit_id: commitId,
      agent_id: actor.id,
      client_txn_id: clientTxn,
      first_sync_id: first,
      last_sync_id: last,
      on_behalf_of: onBehalf,
      result: JSON.stringify(success),
    });
    return success;
  });
}

function prepare(
  db: Db,
  actor: Actor,
  raw: Op,
  index: number,
  deckId: string | undefined,
): { problem?: Problem; conflict?: Conflict; prepared?: Prepared } {
  const op = String(raw.op);
  switch (op) {
    case "issue.create":
    case "issue.set":
    case "issue.comment":
    case "issue.link":
      if (!hasScope(actor, "write:issues")) return { problem: problem(index, op, "missing scope write:issues") };
      break;
    case "memory.add":
    case "memory.supersede":
    case "memory.archive":
      if (!hasScope(actor, "write:memory")) return { problem: problem(index, op, "missing scope write:memory") };
      break;
    case "event.append":
    case "artifact.add":
      if (!hasScope(actor, "write:activity")) return { problem: problem(index, op, "missing scope write:activity") };
      break;
    case "deck.append":
      if (!hasScope(actor, "write:deck")) return { problem: problem(index, op, "missing scope write:deck") };
      break;
    default:
      return { problem: problem(index, op, `unknown op ${op}`) };
  }

  switch (op) {
    case "issue.create":
      return prepareIssueCreate(db, actor, raw, index);
    case "issue.set":
      return prepareIssueSet(db, actor, raw, index);
    case "issue.comment":
      return prepareComment(db, actor, raw, index);
    case "issue.link":
      return prepareLink(db, actor, raw, index);
    case "memory.add":
      return prepareMemoryAdd(db, actor, raw, index);
    case "memory.supersede":
      return prepareSupersede(db, actor, raw, index);
    case "memory.archive":
      return prepareArchive(db, actor, raw, index);
    case "event.append":
      return prepareEvent(db, actor, raw, index);
    case "artifact.add":
      return prepareArtifact(db, actor, raw, index);
    case "deck.append":
      return prepareDeck(db, actor, raw, index, deckId);
    default:
      return { problem: problem(index, op, `unknown op ${op}`) };
  }
}

function loadIssue(db: Db, idOrKey: string): IssueRow | null {
  const rows = db.exec<IssueRow>(
    "SELECT * FROM issues WHERE id = ? OR key = ?",
    idOrKey,
    idOrKey,
  );
  return rows[0] ?? null;
}

function loadMemory(db: Db, id: string): MemoryRow | null {
  const rows = db.exec<MemoryRow>("SELECT * FROM memories WHERE id = ?", id);
  return rows[0] ?? null;
}

function writers(raw: string): Record<string, string> {
  return parseJson(raw, {} as Record<string, string>);
}

function versions(raw: string): Record<string, number> {
  return parseJson(raw, {} as Record<string, number>);
}

function byName(db: Db, agentId: string | undefined, fallback: string): string {
  if (!agentId) return `agent:${fallback}`;
  return `agent:${db.agentName(agentId)}`;
}

function prepareIssueCreate(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "issue.create";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return { problem: problem(index, op, "title is required") };
  const statuses = db.statuses();
  const status = typeof raw.status === "string" ? raw.status : statuses[0]!;
  if (!statuses.includes(status)) return { problem: problem(index, op, `status must be one of ${statuses.join(", ")}`) };
  const description = typeof raw.description === "string" ? raw.description : "";
  const priority = raw.priority === undefined ? 0 : Number(raw.priority);
  if (!Number.isInteger(priority)) return { problem: problem(index, op, "priority must be an integer") };
  const labels = Array.isArray(raw.labels) ? raw.labels.filter((item) => typeof item === "string") : [];
  const assignee = typeof raw.assignee === "string" ? raw.assignee : null;
  const parentId = typeof raw.parent_id === "string" ? raw.parent_id : null;
  const project = typeof raw.project === "string" ? raw.project : null;
  const due = typeof raw.due === "string" ? raw.due : null;
  if (parentId && !loadIssue(db, parentId)) return { problem: problem(index, op, "parent_id does not exist") };

  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        const id = db.nextId("iss");
        const key = db.nextIssueKey();
        const now = new Date().toISOString();
        const fieldVersions = {
          title: syncId,
          description: syncId,
          status: syncId,
          priority: syncId,
          assignee: syncId,
          labels: syncId,
          parent_id: syncId,
          project: syncId,
          due: syncId,
        };
        const fieldWriters = Object.fromEntries(Object.keys(fieldVersions).map((field) => [field, actor.id]));
        db.exec(
          `INSERT INTO issues(id, key, title, description, status, priority, assignee, labels, parent_id, project, due,
             created_by, version, field_versions, field_writers, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          id, key, title, description, status, priority, assignee, JSON.stringify(labels), parentId, project, due,
          actor.id, syncId, JSON.stringify(fieldVersions), JSON.stringify(fieldWriters), now, now,
        );
        db.indexDoc({ entity: "issue", entity_id: id, title, text: `${title}\n${description}`, sync_id: syncId });
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "issue", entity_id: id, field: null, op,
          value: JSON.stringify({ id, key, title, status }), agent_id: actor.id, at: now,
        });
        return { id };
      },
    },
  };
}

function prepareIssueSet(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "issue.set";
  const id = typeof raw.id === "string" ? raw.id : "";
  const field = typeof raw.field === "string" ? raw.field : "";
  if (!id || !field) return { problem: problem(index, op, "id and field are required") };
  if (!(ISSUE_FIELDS as readonly string[]).includes(field)) {
    return { problem: problem(index, op, `field ${field} cannot be set`) };
  }
  const issue = loadIssue(db, id);
  if (!issue || issue.deleted) return { problem: problem(index, op, "issue not found") };
  const fieldVersions = versions(issue.field_versions);
  const actual = fieldVersions[field] ?? issue.version;
  const expectRequired = (GUARDED_ISSUE_FIELDS as readonly string[]).includes(field);
  if (expectRequired && typeof raw.expect !== "number") {
    return { problem: problem(index, op, `expect is required for ${field}`) };
  }
  if (typeof raw.expect === "number" && raw.expect !== actual) {
    const fieldWriters = writers(issue.field_writers);
    return {
      conflict: {
        id: issue.id,
        field,
        expected: raw.expect,
        actual,
        current: currentField(issue, field),
        by: byName(db, fieldWriters[field] ?? issue.created_by, actor.name),
      } satisfies Conflict,
    };
  }
  let value = raw.value;
  if (field === "description" && isRecord(raw.replace)) {
    const anchor = typeof raw.replace.anchor === "string" ? raw.replace.anchor : "";
    const replacement = typeof raw.replace.with === "string" ? raw.replace.with : "";
    if (!anchor) return { problem: problem(index, op, "replace.anchor is required") };
    if (!issue.description.includes(anchor)) return { problem: problem(index, op, "anchor is not in the description") };
    value = issue.description.replace(anchor, replacement);
  }
  const normalized = normalizeField(db, field, value);
  if (typeof normalized === "string" && normalized.startsWith("error:")) {
    return { problem: problem(index, op, normalized.slice("error:".length)) };
  }

  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        const nextVersions = { ...fieldVersions, [field]: syncId };
        const nextWriters = { ...writers(issue.field_writers), [field]: actor.id };
        const stored = field === "labels" ? JSON.stringify(normalized) : (normalized as string | number | null);
        db.exec(
          `UPDATE issues SET ${field} = ?, version = ?, field_versions = ?, field_writers = ?, updated_at = ? WHERE id = ?`,
          stored,
          syncId,
          JSON.stringify(nextVersions),
          JSON.stringify(nextWriters),
          new Date().toISOString(),
          issue.id,
        );
        if (field === "title" || field === "description") {
          const title = field === "title" ? String(normalized) : issue.title;
          const description = field === "description" ? String(normalized) : issue.description;
          db.indexDoc({ entity: "issue", entity_id: issue.id, title, text: `${title}\n${description}`, sync_id: syncId });
        }
        db.writeChange({
          sync_id: syncId,
          commit_id: commitId,
          entity: "issue",
          entity_id: issue.id,
          field,
          op,
          value: JSON.stringify(normalized),
          agent_id: actor.id,
          at: new Date().toISOString(),
        });
        return { id: issue.id };
      },
    },
  };
}

function currentField(issue: IssueRow, field: string): string | number | null {
  switch (field) {
    case "title": return issue.title;
    case "description": return issue.description;
    case "status": return issue.status;
    case "priority": return issue.priority;
    case "assignee": return issue.assignee;
    case "labels": return issue.labels;
    case "parent_id": return issue.parent_id;
    case "project": return issue.project;
    case "due": return issue.due;
    default: return null;
  }
}

function normalizeField(db: Db, field: string, value: unknown): string | number | string[] | null | `error:${string}` {
  if (field === "priority") {
    const priority = Number(value);
    if (!Number.isInteger(priority)) return "error:priority must be an integer";
    return priority;
  }
  if (field === "labels") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return "error:labels must be an array of strings";
    return value as string[];
  }
  if (field === "status") {
    if (typeof value !== "string" || !db.statuses().includes(value)) {
      return `error:status must be one of ${db.statuses().join(", ")}`;
    }
    return value;
  }
  if (value === null) {
    if (field === "title" || field === "description" || field === "status") return "error:field cannot be null";
    return null;
  }
  if (typeof value !== "string") return "error:value must be a string";
  return value;
}

function prepareComment(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "issue.comment";
  const id = typeof raw.id === "string" ? raw.id : "";
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!id || !body) return { problem: problem(index, op, "id and body are required") };
  const issue = loadIssue(db, id);
  if (!issue || issue.deleted) return { problem: problem(index, op, "issue not found") };
  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        const commentId = db.nextId("cmt");
        db.exec(
          "INSERT INTO issue_comments(id, issue_id, author, body, sync_id) VALUES (?, ?, ?, ?, ?)",
          commentId, issue.id, actor.id, body, syncId,
        );
        db.exec("UPDATE issues SET version = ?, updated_at = ? WHERE id = ?", syncId, new Date().toISOString(), issue.id);
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "issue_comment", entity_id: commentId,
          field: "body", op, value: JSON.stringify({ issue_id: issue.id, body }), agent_id: actor.id,
          at: new Date().toISOString(),
        });
        return { id: commentId };
      },
    },
  };
}

function prepareLink(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "issue.link";
  const fromId = typeof raw.from_id === "string" ? raw.from_id : "";
  const toId = typeof raw.to_id === "string" ? raw.to_id : "";
  const type = typeof raw.type === "string" ? raw.type : "";
  if (!fromId || !toId || !type) return { problem: problem(index, op, "from_id, to_id, and type are required") };
  if (!(LINK_TYPES as readonly string[]).includes(type)) {
    return { problem: problem(index, op, `type must be one of ${LINK_TYPES.join(", ")}`) };
  }
  const from = loadIssue(db, fromId);
  const to = loadIssue(db, toId);
  if (!from || !to) return { problem: problem(index, op, "both issues must exist") };
  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        db.exec(
          "INSERT OR REPLACE INTO issue_links(from_id, to_id, type, sync_id) VALUES (?, ?, ?, ?)",
          from.id, to.id, type, syncId,
        );
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "issue_link", entity_id: `${from.id}:${to.id}:${type}`,
          field: "type", op,           value: JSON.stringify({ from_id: from.id, to_id: to.id, type }),
          agent_id: actor.id, at: new Date().toISOString(),
        });
        return { id: `${from.id}:${to.id}:${type}` };
      },
    },
  };
}

function prepareMemoryAdd(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "memory.add";
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (!content) return { problem: problem(index, op, "content is required") };
  const scope = typeof raw.scope === "string" ? raw.scope : "shared";
  if (!(MEMORY_SCOPES as readonly string[]).includes(scope)) {
    return { problem: problem(index, op, `scope must be one of ${MEMORY_SCOPES.join(", ")}`) };
  }
  const project = typeof raw.project === "string" ? raw.project : null;
  if (scope === "project" && !project) return { problem: problem(index, op, "project scope requires project") };
  const kind = typeof raw.kind === "string" ? raw.kind : "fact";
  const subject = typeof raw.subject === "string" ? raw.subject : null;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((item) => typeof item === "string") : [];
  const sourceRef = typeof raw.source_ref === "string" ? raw.source_ref : null;
  const confidence = raw.confidence === undefined ? null : Number(raw.confidence);
  if (confidence !== null && Number.isNaN(confidence)) return { problem: problem(index, op, "confidence must be a number") };
  const owner = scope === "private" ? actor.id : typeof raw.owner === "string" ? raw.owner : null;

  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        const id = db.nextId("mem");
        const now = new Date().toISOString();
        const fieldVersions = JSON.stringify({ content: syncId });
        const fieldWriters = JSON.stringify({ content: actor.id });
        db.exec(
          `INSERT INTO memories(id, scope, owner, project, kind, subject, content, tags, source_ref, confidence,
             status, supersedes_id, expires_at, created_by, version, field_versions, field_writers, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', NULL, ?, ?, ?, ?, ?, ?)`,
          id, scope, owner, project, kind, subject, content, JSON.stringify(tags), sourceRef, confidence,
          typeof raw.expires_at === "string" ? raw.expires_at : null,
          actor.id, syncId, fieldVersions, fieldWriters, now,
        );
        db.indexDoc({
          entity: "memory",
          entity_id: id,
          title: subject ?? content.slice(0, 120),
          text: `${subject ?? ""}\n${content}`,
          sync_id: syncId,
        });
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "memory", entity_id: id, field: "content", op,
          value: JSON.stringify({ content, scope, kind }), agent_id: actor.id, at: now,
        });
        return { id };
      },
    },
  };
}

function prepareSupersede(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "memory.supersede";
  const id = typeof raw.id === "string" ? raw.id : "";
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (!id || !content) return { problem: problem(index, op, "id and content are required") };
  if (typeof raw.expect !== "number") return { problem: problem(index, op, "expect is required for memory.supersede") };
  const memory = loadMemory(db, id);
  if (!memory) return { problem: problem(index, op, "memory not found") };
  if (memory.scope === "private" && memory.owner !== actor.id) {
    return { problem: problem(index, op, "private memory belongs to another agent") };
  }
  const actual = versions(memory.field_versions).content ?? memory.version;
  if (raw.expect !== actual) {
    return {
      conflict: {
        id: memory.id,
        field: "content",
        expected: raw.expect,
        actual,
        current: memory.content,
        by: byName(db, writers(memory.field_writers).content ?? memory.created_by, actor.name),
      },
    };
  }
  if (memory.status !== "current") return { problem: problem(index, op, "only a current memory can be superseded") };
  const subject = typeof raw.subject === "string" ? raw.subject : memory.subject;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((item) => typeof item === "string") : parseJson<string[]>(memory.tags, []);

  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        const newId = db.nextId("mem");
        const now = new Date().toISOString();
        db.exec("UPDATE memories SET status = 'superseded', version = ? WHERE id = ?", syncId, memory.id);
        db.removeDoc("memory", memory.id);
        db.exec(
          `INSERT INTO memories(id, scope, owner, project, kind, subject, content, tags, source_ref, confidence,
             status, supersedes_id, expires_at, created_by, version, field_versions, field_writers, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?, ?)`,
          newId, memory.scope, memory.owner, memory.project, memory.kind, subject, content, JSON.stringify(tags),
          memory.source_ref, memory.confidence, memory.id, memory.expires_at, actor.id, syncId,
          JSON.stringify({ content: syncId }), JSON.stringify({ content: actor.id }), now,
        );
        db.indexDoc({
          entity: "memory", entity_id: newId, title: subject ?? content.slice(0, 120),
          text: `${subject ?? ""}\n${content}`, sync_id: syncId,
        });
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "memory", entity_id: newId, field: "content", op,
          value: JSON.stringify({ content, supersedes_id: memory.id }), agent_id: actor.id, at: now,
        });
        return { id: newId, createdFrom: memory.id };
      },
    },
  };
}

function prepareArchive(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "memory.archive";
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return { problem: problem(index, op, "id is required") };
  const memory = loadMemory(db, id);
  if (!memory) return { problem: problem(index, op, "memory not found") };
  if (memory.scope === "private" && memory.owner !== actor.id) {
    return { problem: problem(index, op, "private memory belongs to another agent") };
  }
  const actual = memory.version;
  if (typeof raw.expect === "number" && raw.expect !== actual) {
    return {
      conflict: {
        id: memory.id, field: "status", expected: raw.expect, actual, current: memory.status,
        by: byName(db, memory.created_by, actor.name),
      },
    };
  }
  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        db.exec("UPDATE memories SET status = 'archived', version = ? WHERE id = ?", syncId, memory.id);
        db.removeDoc("memory", memory.id);
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "memory", entity_id: memory.id, field: "status", op,
          value: JSON.stringify("archived"), agent_id: actor.id, at: new Date().toISOString(),
        });
        return { id: memory.id };
      },
    },
  };
}

function resolveIssueRef(db: Db, ref: string | null, strict: boolean): { issue_id: string | null; issue_key: string | null; error?: string } {
  if (!ref) return { issue_id: null, issue_key: null };
  const issue = loadIssue(db, ref);
  if (!issue) {
    if (strict) return { issue_id: null, issue_key: null, error: `issue ${ref} not found` };
    const key = /^[A-Z][A-Z0-9]+-\d+$/.test(ref) ? ref : null;
    return { issue_id: null, issue_key: key ?? ref };
  }
  return { issue_id: issue.id, issue_key: issue.key };
}

function prepareEvent(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "event.append";
  const normalized = normalizeEvent(raw, { defaultActor: actor.name });
  if (!normalized.ok) return { problem: problem(index, op, normalized.error) };
  const event = normalized.value;
  const link = resolveIssueRef(db, event.issue_ref, raw.allow_unresolved_issue !== true);
  if (link.error) return { problem: problem(index, op, link.error) };
  const existing = db.exec<{ id: string; sync_id: number }>(
    "SELECT id, sync_id FROM events WHERE source_id = ?",
    event.source_id,
  )[0];
  if (existing) {
    return { prepared: { op, deduped: { id: existing.id, sync_id: existing.sync_id } } };
  }
  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        const id = db.nextId("evt");
        db.exec(
          `INSERT INTO events(id, source_id, ts, actor, type, summary, status, project, refs, issue_id, issue_key,
             supersedes_source, supersedes_id, details, sync_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          id, event.source_id, event.ts, event.actor, event.type, event.summary, event.status, event.project,
          JSON.stringify(event.refs), link.issue_id, link.issue_key, event.supersedes_source, event.details,
          syncId, actor.id,
        );
        db.resolveSupersedes();
        db.indexDoc({
          entity: "event", entity_id: id, title: event.summary.slice(0, 180),
          text: `${event.summary}\n${event.project ?? ""} ${event.type}`, sync_id: syncId,
        });
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "event", entity_id: id, field: null, op,
          value: JSON.stringify({ type: event.type, summary: event.summary, ts: event.ts, actor: event.actor }),
          agent_id: actor.id, at: event.ts,
        });
        return { id };
      },
    },
  };
}

function prepareArtifact(db: Db, actor: Actor, raw: Op, index: number) {
  const op = "artifact.add";
  const normalized = normalizeArtifact(raw, { defaultActor: actor.name });
  if (!normalized.ok) return { problem: problem(index, op, normalized.error) };
  const artifact = normalized.value;
  const existing = db.exec<{ id: string; sync_id: number }>(
    "SELECT id, sync_id FROM artifacts WHERE source_id = ?",
    artifact.source_id,
  )[0];
  if (existing) {
    return { prepared: { op, deduped: { id: existing.id, sync_id: existing.sync_id } } };
  }
  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        const id = db.nextId("art");
        db.exec(
          `INSERT INTO artifacts(id, source_id, path, host, producer, project, ts, kind, note, sync_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, artifact.source_id, artifact.path, artifact.host, artifact.producer, artifact.project,
          artifact.ts, artifact.kind, artifact.note, syncId, actor.id,
        );
        db.indexDoc({
          entity: "artifact", entity_id: id, title: artifact.path,
          text: `${artifact.path}\n${artifact.note ?? ""} ${artifact.kind ?? ""} ${artifact.project ?? ""}`,
          sync_id: syncId,
        });
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "artifact", entity_id: id, field: null, op,
          value: JSON.stringify({ path: artifact.path, kind: artifact.kind, ts: artifact.ts }),
          agent_id: actor.id, at: artifact.ts,
        });
        return { id };
      },
    },
  };
}

function prepareDeck(db: Db, actor: Actor, raw: Op, index: number, commitDeckId: string | undefined) {
  const op = "deck.append";
  const deckOp = {
    deck_id: typeof raw.deck_id === "string" ? raw.deck_id : commitDeckId,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    payload: raw.payload,
  };
  const error = deckPlaceholder.validate(deckOp);
  if (error) return { problem: problem(index, op, error) };
  const payload = deckOp.payload as Record<string, unknown>;
  const kind = deckOp.kind ?? "note";
  return {
    prepared: {
      op,
      apply(syncId: number, commitId: string) {
        let deckId = deckOp.deck_id;
        if (deckId) {
          const found = db.exec<{ id: string }>("SELECT id FROM decks WHERE id = ?", deckId)[0];
          if (!found) {
            db.exec(
              "INSERT INTO decks(id, conversation_ref, owner, state, version) VALUES (?, ?, ?, '{}', ?)",
              deckId, deckId, actor.id, syncId,
            );
          } else {
            db.exec("UPDATE decks SET version = ? WHERE id = ?", syncId, deckId);
          }
        } else {
          deckId = db.nextId("deck");
          db.exec(
            "INSERT INTO decks(id, conversation_ref, owner, state, version) VALUES (?, NULL, ?, '{}', ?)",
            deckId, actor.id, syncId,
          );
        }
        const entryId = db.nextId("dk");
        const ordinalRow = db.exec<{ n: number }>(
          "SELECT COALESCE(MAX(ordinal), 0) AS n FROM deck_entries WHERE deck_id = ?",
          deckId,
        )[0];
        const ordinal = (ordinalRow?.n ?? 0) + 1;
        db.exec(
          `INSERT INTO deck_entries(id, deck_id, kind, payload, ordinal, author, version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          entryId, deckId, kind, JSON.stringify(payload), ordinal, actor.id, syncId,
        );
        const search = deckPlaceholder.searchText({ kind, payload });
        if (search) db.indexDoc({ entity: "deck", entity_id: entryId, title: search.title, text: search.text, sync_id: syncId });
        db.writeChange({
          sync_id: syncId, commit_id: commitId, entity: "deck", entity_id: entryId, field: "payload", op,
          value: JSON.stringify({ deck_id: deckId, kind }), agent_id: actor.id, at: new Date().toISOString(),
        });
        return { id: entryId };
      },
    },
  };
}

