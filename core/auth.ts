import { SCOPES, type Actor, type Scope } from "./types";

export function hasScope(actor: Actor, scope: Scope | "read"): boolean {
  if (actor.scopes.includes("admin")) return true;
  if (scope === "read") {
    return actor.scopes.includes("read") || actor.scopes.some((item) => item.startsWith("write:"));
  }
  return actor.scopes.includes(scope);
}

export function parseScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SCOPES.includes(item as Scope)) return null;
    scopes.push(item);
  }
  return scopes;
}
