import type { Db } from "../db";

export interface LexicalHit {
  doc_id: string;
  entity: string;
  entity_id: string;
  title: string;
  text: string;
  /** Higher is better. FTS5 bm25() is negated so callers can sort descending. */
  score: number;
}

/** Quote alphanumeric tokens and AND them. Operators in the raw query are not passed through. */
export function ftsQuery(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" AND ");
}

export function searchLexical(db: Db, query: string, limit: number): LexicalHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const rows = db.exec<{
    doc_id: string;
    entity: string;
    entity_id: string;
    title: string;
    text: string;
    rank: number;
  }>(
    `SELECT doc_id, entity, entity_id, title, text, bm25(search_fts) AS rank
     FROM search_fts
     WHERE search_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
    match,
    limit,
  );
  return rows.map((row) => ({
    doc_id: row.doc_id,
    entity: row.entity,
    entity_id: row.entity_id,
    title: row.title,
    text: row.text,
    score: Number((-row.rank).toFixed(6)),
  }));
}
