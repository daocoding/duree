import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { DEFAULTS } from "./defaults";
import { ConfigError, configSchema, formatConfigError, isPlainObject, mergeConfig, type ParsedConfig } from "./schema";

export interface OverlayFiles {
  account_id?: string;
  worker_name?: string;
}

export interface LoadedConfig {
  config: ParsedConfig;
  overlay: OverlayFiles;
  warnings: string[];
  root: string;
}

export function repoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "config", "defaults.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError("(root)", "could not find the duree repo root");
}

export function loadDefaultsYaml(root = repoRoot()): unknown {
  return parse(readFileSync(join(root, "config", "defaults.yaml"), "utf8"));
}

function readYamlFile(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

/** Subset of TOML: assignments and comments. Enough for the example overlay. */
export function parseOverlayToml(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new ConfigError("wrangler.overlay.toml", `unsupported line: ${trimmed}`);
    let value = match[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values[match[1]!] = value;
  }
  return values;
}

const SECRET_KEYS = new Set(["token", "secret", "password", "api_key", "apikey", "access_token"]);

export function assertNoSecrets(value: unknown, path = "agents"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      throw new ConfigError(`${path}.${key}`, "tokens and secrets do not belong in config; use wrangler secret put");
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

export function loadConfig(options: { root?: string; overlayDir?: string } = {}): LoadedConfig {
  const root = options.root ?? repoRoot();
  const defaults = loadDefaultsYaml(root);
  let overlayDoc: unknown = {};
  let overlay: OverlayFiles = {};
  const warnings: string[] = [];
  if (options.overlayDir) {
    const dir = isAbsolute(options.overlayDir) ? options.overlayDir : resolve(root, options.overlayDir);
    const hub = join(dir, "hub.yaml");
    if (!existsSync(hub)) throw new ConfigError("hub.yaml", `missing ${hub}`);
    overlayDoc = readYamlFile(hub);
    const wranglerPath = join(dir, "wrangler.overlay.toml");
    if (existsSync(wranglerPath)) {
      const parsed = parseOverlayToml(readFileSync(wranglerPath, "utf8"));
      overlay = { account_id: parsed.account_id, worker_name: parsed.name };
    }
  }
  const merged = mergeConfig(defaults, overlayDoc);
  let config: ParsedConfig;
  try {
    config = configSchema.parse(merged);
  } catch (error) {
    throw formatConfigError(error);
  }
  if (JSON.stringify(defaults) !== JSON.stringify(DEFAULTS)) {
    throw new ConfigError("config/defaults.yaml", "does not match config/defaults.ts");
  }
  const base = options.overlayDir
    ? resolve(root, options.overlayDir)
    : root;
  for (const key of ["agents", "workspaces", "ranking"] as const) {
    const relative = config[key];
    if (!relative) continue;
    const path = resolve(base, relative);
    if (!existsSync(path)) throw new ConfigError(key, `file not found: ${relative}`);
    if (key === "agents") assertNoSecrets(readYamlFile(path), key);
  }
  for (const spec of config.extensions ?? []) {
    const path = resolve(base, spec);
    if (!existsSync(path)) throw new ConfigError("extensions", `file not found: ${spec}`);
  }
  if (config.deck.module !== "deck-placeholder") {
    throw new ConfigError("deck.module", "only deck-placeholder is bundled in this phase");
  }
  if (config.retrieval.ranker === "hybrid") {
    warnings.push("retrieval.ranker hybrid is accepted but this phase serves lexical search; hybrid ships later");
  }
  if (config.retrieval.rerank) {
    warnings.push("retrieval.rerank is ignored until a later phase");
  }
  return { config, overlay, warnings, root };
}

export function renderWrangler(loaded: LoadedConfig): string {
  const { config, overlay } = loaded;
  const document = {
    name: overlay.worker_name ?? "duree",
    main: "core/index.ts",
    compatibility_date: "2026-11-04",
    compatibility_flags: ["nodejs_compat"],
    ...(overlay.account_id ? { account_id: overlay.account_id } : {}),
    vars: {
      DUREE_WORKSPACE: config.workspace.default,
      DUREE_ISSUE_PREFIX: config.workspace.issue_prefix,
      DUREE_STATUSES: config.workspace.statuses.join(","),
    },
    durable_objects: {
      bindings: [{ name: "WORKSPACE", class_name: "Workspace" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Workspace"] }],
  };
  return JSON.stringify(document, null, 2);
}

export function scanTree(root: string, patterns: Array<{ name: string; re: RegExp }>): string[] {
  const findings: string[] = [];
  const skip = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (stat.size > 1_000_000) continue;
      if (entry === "scan-secrets.ts") continue;
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (line.includes("test-token-not-a-secret")) return;
        for (const pattern of patterns) {
          if (pattern.re.test(line)) findings.push(`${path}:${index + 1} ${pattern.name}`);
        }
      });
    }
  };
  walk(root);
  return findings;
}

export const SECRET_PATTERNS = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "slack-token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: "github-pat", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "cloudflare-account-hex", re: /account_id["']?\s*[:=]\s*["'][0-9a-f]{32}["']/i },
  { name: "bearer-secret", re: /Bearer\s+[A-Za-z0-9\-_\.]{32,}/ },
];
