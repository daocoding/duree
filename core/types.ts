/** Shared record and tool shapes. */

export const SCHEMA_VERSION = 2;

export const SCOPES = [
  "read",
  "write:issues",
  "write:memory",
  "write:activity",
  "write:deck",
  "admin",
] as const;

export type Scope = (typeof SCOPES)[number];

export const ISSUE_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "assignee",
  "labels",
  "parent_id",
  "project",
  "due",
] as const;

/** Status and assignee always require `expect`. Other fields accept it. */
export const GUARDED_ISSUE_FIELDS = ["status", "assignee"] as const;

export const LINK_TYPES = ["blocks", "relates", "duplicates"] as const;

export const MEMORY_SCOPES = ["shared", "private", "project"] as const;

export interface Actor {
  id: string;
  name: string;
  scopes: string[];
}

export interface Problem {
  index?: number;
  op?: string;
  message: string;
}

export interface Conflict {
  id: string;
  field: string;
  expected: number;
  actual: number;
  current: string | number | boolean | null;
  by: string;
}

export interface CommitSuccess {
  ok: true;
  commit_id: string;
  first_sync_id: number;
  last_sync_id: number;
  version: number;
  replayed: boolean;
  /** Old memory id to the new record created by memory.supersede. */
  created: Record<string, string>;
  applied: Array<{ op: string; id: string; sync_id: number }>;
}

export interface CommitFailure {
  ok: false;
  error: "validation" | "conflict" | "forbidden" | "unauthorized";
  version: number;
  problems?: Problem[];
  conflicts?: Conflict[];
}

export type CommitResult = CommitSuccess | CommitFailure;
