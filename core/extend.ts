import type { McpServer } from "@modelcontextprotocol/server";
import type { Store } from "./store";
import type { Actor } from "./types";

export interface ExtensionContext {
  store: Store;
  actor: Actor;
}

/**
 * A private overlay registers one of these. Core loads them from the generated
 * `extensions/bundle.ts` and, in tests, from `registerExtension`.
 * Handlers must not import product-specific names into core.
 */
export interface Extension {
  name: string;
  registerTools?(server: McpServer, ctx: ExtensionContext): void;
  handleHttp?(request: Request, ctx: ExtensionContext): Promise<Response | null> | Response | null;
}

const runtime: Extension[] = [];

export function registerExtension(extension: Extension): void {
  const existing = runtime.findIndex((item) => item.name === extension.name);
  if (existing >= 0) runtime.splice(existing, 1);
  runtime.push(extension);
}

export function clearExtensions(): void {
  runtime.splice(0, runtime.length);
}

export function registeredExtensions(): readonly Extension[] {
  return runtime;
}
