import { fnv1a } from "../hash";
import { normalizeArtifact, normalizeEvent } from "../records";

const CHUNK = 50;

export interface ImportRequest {
  events?: unknown[];
  artifacts?: unknown[];
  client_txn_id?: string;
  defaultActor: string;
}

export interface BuiltCommit {
  client_txn_id: string;
  changes: Record<string, unknown>[];
}

export type BuiltImport =
  | { ok: true; commits: BuiltCommit[]; skipped: Array<{ index: number; message: string }> }
  | { ok: false; error: "validation" | "sensitive"; problems: Array<{ index: number; message: string }> };

/**
 * Turn generic JSONL rows into idempotent commits.
 * Each row's `id` becomes the event or artifact source id. The commit's
 * `client_txn_id` is stable for the same rows, so a second run replays.
 */
export function buildImportCommits(input: ImportRequest): BuiltImport {
  const events = Array.isArray(input.events) ? input.events : [];
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  if (events.length + artifacts.length === 0) {
    return { ok: false, error: "validation", problems: [{ index: 0, message: "events or artifacts are required" }] };
  }
  if (events.length > 5_000 || artifacts.length > 5_000) {
    return { ok: false, error: "validation", problems: [{ index: 0, message: "import at most 5000 rows of each kind per call" }] };
  }

  const changes: Record<string, unknown>[] = [];
  const problems: Array<{ index: number; message: string }> = [];
  events.forEach((raw, index) => {
    const normalized = normalizeEvent(raw, { defaultActor: input.defaultActor });
    if (!normalized.ok) {
      problems.push({ index, message: normalized.error });
      return;
    }
    const value = normalized.value;
    changes.push({
      op: "event.append",
      id: value.source_id,
      ts: value.ts,
      actor: value.actor,
      type: value.type,
      summary: value.summary,
      status: value.status,
      project: value.project,
      refs: value.refs,
      issue: value.issue_ref,
      supersedes: value.supersedes_source,
      details: value.details ? JSON.parse(value.details) : undefined,
      allow_unresolved_issue: true,
    });
  });
  artifacts.forEach((raw, index) => {
    const normalized = normalizeArtifact(raw, { defaultActor: input.defaultActor });
    if (!normalized.ok) {
      problems.push({ index: events.length + index, message: normalized.error });
      return;
    }
    const value = normalized.value;
    changes.push({
      op: "artifact.add",
      id: value.source_id,
      path: value.path,
      host: value.host,
      producer: value.producer,
      project: value.project,
      ts: value.ts,
      kind: value.kind,
      note: value.note,
    });
  });
  if (changes.length === 0) {
    const sensitive = problems.some((item) => item.message.includes("secrets"));
    return { ok: false, error: sensitive ? "sensitive" : "validation", problems };
  }

  const base = input.client_txn_id?.trim() || `import:${fnv1a(JSON.stringify(changes.map((change) => change.id)))}`;
  const commits: BuiltCommit[] = [];
  for (let offset = 0; offset < changes.length; offset += CHUNK) {
    const slice = changes.slice(offset, offset + CHUNK);
    const index = offset / CHUNK;
    commits.push({
      client_txn_id: changes.length <= CHUNK ? base : `${base}:${index}`,
      changes: slice,
    });
  }
  return { ok: true, commits, skipped: problems };
}
