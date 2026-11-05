import { containsSensitive, SENSITIVE_MESSAGE } from "./sensitive";
import { fnv1a } from "./hash";

const MAX_TEXT = 2_000;
const MAX_REFS = 50;
const MAX_REF_LEN = 500;
const MAX_DETAILS = 4_000;

export interface NormalizeOptions {
  defaultActor?: string;
  now?: Date;
}

export type NormalizeFailure = { ok: false; reason: "sensitive" | "invalid"; error: string };

export interface NormalizedEvent {
  source_id: string;
  ts: string;
  actor: string;
  type: string;
  summary: string;
  status: string | null;
  project: string | null;
  refs: string[];
  issue_ref: string | null;
  supersedes_source: string | null;
  details: string | null;
}

export interface NormalizedArtifact {
  source_id: string;
  path: string;
  host: string | null;
  producer: string;
  project: string | null;
  ts: string;
  kind: string | null;
  note: string | null;
  details: string | null;
}

const ARTIFACT_FIELDS = new Set(["id", "path", "host", "producer", "project", "ts", "kind", "note", "details"]);
const ARTIFACT_ENVELOPE = new Set(["op", "allow_unresolved_issue", "expect", "client_txn_id"]);

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function canonicalTs(value: unknown, now: Date): string | null {
  if (value === undefined || value === null || value === "") return now.toISOString();
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function eventType(value: unknown): string | null {
  const type = str(value);
  if (!type || !/^[a-z][a-z0-9_-]{0,31}$/.test(type)) return null;
  return type;
}

export function normalizeEvent(input: unknown, options: NormalizeOptions = {}): { ok: true; value: NormalizedEvent } | NormalizeFailure {
  const record = asRecord(input);
  if (!record) return { ok: false, reason: "invalid", error: "event must be an object" };
  const type = eventType(record.type);
  if (!type) return { ok: false, reason: "invalid", error: "type must be a short lowercase identifier" };
  const summary = str(record.summary);
  if (!summary) return { ok: false, reason: "invalid", error: "summary is required" };
  if (summary.length > MAX_TEXT) return { ok: false, reason: "invalid", error: `summary exceeds ${MAX_TEXT} characters` };
  if (containsSensitive(summary)) return { ok: false, reason: "sensitive", error: SENSITIVE_MESSAGE };
  const actor = str(record.actor) ?? options.defaultActor;
  if (!actor) return { ok: false, reason: "invalid", error: "actor is required" };
  const ts = canonicalTs(record.ts, options.now ?? new Date());
  if (!ts) return { ok: false, reason: "invalid", error: "ts is not a valid time" };

  const refs: string[] = [];
  if (record.refs !== undefined) {
    if (!Array.isArray(record.refs)) return { ok: false, reason: "invalid", error: "refs must be an array" };
    if (record.refs.length > MAX_REFS) return { ok: false, reason: "invalid", error: `refs exceeds ${MAX_REFS}` };
    for (const ref of record.refs) {
      const text = str(ref);
      if (!text || text.length > MAX_REF_LEN) return { ok: false, reason: "invalid", error: "each ref must be a short string" };
      if (containsSensitive(text)) return { ok: false, reason: "sensitive", error: SENSITIVE_MESSAGE };
      refs.push(text);
    }
  }

  const status = str(record.status) ?? null;
  const project = str(record.project) ?? null;
  if ((status && containsSensitive(status)) || (project && containsSensitive(project)) || containsSensitive(actor)) {
    return { ok: false, reason: "sensitive", error: SENSITIVE_MESSAGE };
  }

  let details: string | null = null;
  if (record.details !== undefined && record.details !== null) {
    if (!asRecord(record.details)) return { ok: false, reason: "invalid", error: "details must be an object" };
    details = JSON.stringify(record.details);
    if (details.length > MAX_DETAILS) return { ok: false, reason: "invalid", error: "details is too large" };
    if (containsSensitive(details)) return { ok: false, reason: "sensitive", error: SENSITIVE_MESSAGE };
  }

  const supersedesRaw = str(record.supersedes) ?? str(record.supersedes_id) ?? null;
  const supersedes = supersedesRaw ? supersedesRaw.replace(/^event:/, "") : null;
  const issueRef = str(record.issue_id) ?? str(record.issue_key) ?? str(record.issue) ?? null;
  const givenId = str(record.id);
  const source_id =
    givenId ??
    fnv1a(JSON.stringify({ ts, actor, type, summary, status, project, refs, supersedes, issueRef, details }));

  return {
    ok: true,
    value: {
      source_id,
      ts,
      actor,
      type,
      summary,
      status,
      project,
      refs,
      issue_ref: issueRef,
      supersedes_source: supersedes,
      details,
    },
  };
}

export function normalizeArtifact(input: unknown, options: NormalizeOptions = {}): { ok: true; value: NormalizedArtifact } | NormalizeFailure {
  const record = asRecord(input);
  if (!record) return { ok: false, reason: "invalid", error: "artifact must be an object" };
  const path = str(record.path);
  if (!path) return { ok: false, reason: "invalid", error: "path is required" };
  if (path.length > 1_000) return { ok: false, reason: "invalid", error: "path is too long" };
  const note = str(record.note) ?? null;
  if (note && note.length > MAX_TEXT) return { ok: false, reason: "invalid", error: `note exceeds ${MAX_TEXT} characters` };
  if (containsSensitive(path) || (note && containsSensitive(note))) {
    return { ok: false, reason: "sensitive", error: SENSITIVE_MESSAGE };
  }
  const producer = str(record.producer) ?? options.defaultActor;
  if (!producer) return { ok: false, reason: "invalid", error: "producer is required" };
  const ts = canonicalTs(record.ts, options.now ?? new Date());
  if (!ts) return { ok: false, reason: "invalid", error: "ts is not a valid time" };
  const givenId = str(record.id);
  const host = str(record.host) ?? null;
  const project = str(record.project) ?? null;
  const kind = str(record.kind) ?? null;
  const details = artifactDetails(record);
  if (!details.ok) return details;
  const source_id = givenId ?? fnv1a(JSON.stringify({ path, host, producer, project, ts, kind, note, details: details.value }));
  return {
    ok: true,
    value: { source_id, path, host, producer, project, ts, kind, note, details: details.value },
  };
}

/** Known columns stay columns. Any other field is kept inside `details`. */
function artifactDetails(record: Record<string, unknown>): { ok: true; value: string | null } | NormalizeFailure {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ARTIFACT_FIELDS.has(key) || ARTIFACT_ENVELOPE.has(key)) continue;
    extra[key] = value;
  }
  let merged: Record<string, unknown> | null = null;
  if (record.details !== undefined && record.details !== null) {
    if (!asRecord(record.details)) return { ok: false, reason: "invalid", error: "details must be an object" };
    merged = { ...extra, ...record.details };
  } else if (Object.keys(extra).length > 0) {
    merged = extra;
  }
  if (!merged) return { ok: true, value: null };
  const encoded = JSON.stringify(merged);
  if (encoded.length > MAX_DETAILS) return { ok: false, reason: "invalid", error: "details is too large" };
  if (containsSensitive(encoded)) return { ok: false, reason: "sensitive", error: SENSITIVE_MESSAGE };
  return { ok: true, value: encoded };
}
