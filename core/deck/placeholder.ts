/**
 * Placeholder deck module. Phase 1 keeps it in-tree.
 * A later phase loads `deck.module` as a bundled plugin through this interface.
 */
export interface DeckAppend {
  deck_id?: string;
  kind?: string;
  payload?: unknown;
}

export interface DeckModule {
  id: string;
  kinds: readonly string[];
  validate(op: DeckAppend): string | null;
  searchText(entry: { kind: string; payload: Record<string, unknown> }): { title: string; text: string } | null;
}

export const deckPlaceholder: DeckModule = {
  id: "deck-placeholder",
  kinds: ["note"],
  validate(op) {
    const kind = op.kind ?? "note";
    if (!this.kinds.includes(kind)) return `unknown deck kind "${kind}"`;
    if (!op.payload || typeof op.payload !== "object" || Array.isArray(op.payload)) {
      return "deck payload must be an object";
    }
    const text = (op.payload as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length === 0) return "deck note payload.text is required";
    return null;
  },
  searchText(entry) {
    const text = typeof entry.payload.text === "string" ? entry.payload.text : "";
    if (!text) return null;
    return { title: text.slice(0, 120), text };
  },
};
