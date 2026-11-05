import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, renderWrangler, repoRoot, scanTree, SECRET_PATTERNS } from "../config/load";
import { ConfigError } from "../config/schema";
import { normalizeEvent } from "../core/records";
import { buildImportCommits } from "../core/import/jsonl";

describe("config", () => {
  it("matches the yaml defaults and renders an example overlay without secrets", () => {
    const loaded = loadConfig({ root: repoRoot(), overlayDir: "examples/minimal" });
    expect(loaded.config.workspace.issue_prefix).toBe("EX");
    expect(loaded.config.workspace.default).toBe("main");
    expect(loaded.config.retrieval.ranker).toBe("lexical");
    const rendered = renderWrangler(loaded);
    expect(rendered).not.toContain("DUREE_BOOTSTRAP_TOKEN");
    expect(rendered).not.toContain("DUREE_ALLOW_DEV_AUTH");
    expect(rendered).toContain("\"DUREE_ISSUE_PREFIX\": \"EX\"");
    expect(rendered).toContain("example-not-a-real-account");
  });

  it("names the field path for an unknown key and a wrong type", () => {
    const root = repoRoot();
    const dir = mkdtempSync(join(tmpdir(), "duree-config-"));
    writeFileSync(join(dir, "hub.yaml"), "workspace:\n  issue_prefix: EX\n  extra: true\n");
    expect(() => loadConfig({ root, overlayDir: dir })).toThrow(ConfigError);
    try {
      loadConfig({ root, overlayDir: dir });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(`${(error as ConfigError).fieldPath} ${(error as ConfigError).message}`).toMatch(/extra|workspace/);
    }

    writeFileSync(join(dir, "hub.yaml"), "retrieval:\n  rerank: \"yes\"\n");
    try {
      loadConfig({ root, overlayDir: dir });
      throw new Error("expected config to fail");
    } catch (error) {
      if (error instanceof Error && error.message === "expected config to fail") throw error;
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).fieldPath).toContain("rerank");
    }
  });
});

describe("generic events", () => {
  it("keeps a source id, an issue link, and a supersede link", () => {
    const event = normalizeEvent({
      id: "e2",
      ts: "2026-06-01T00:00:00Z",
      actor: "ada",
      type: "correction",
      summary: "replaced the earlier note",
      refs: ["src/app.ts"],
      issue: "HUB-4",
      supersedes: "event:e1",
    });
    expect(event.ok).toBe(true);
    if (!event.ok) return;
    expect(event.value.supersedes_source).toBe("e1");
    expect(event.value.issue_ref).toBe("HUB-4");
    expect(event.value.ts).toBe("2026-06-01T00:00:00.000Z");
    expect(event.value.source_id).toBe("e2");
  });

  it("builds a stable client transaction id for the same rows", () => {
    const rows = [{ id: "e1", type: "note", summary: "hello", actor: "ada", ts: "2026-06-01T00:00:00Z" }];
    const first = buildImportCommits({ events: rows, defaultActor: "ada", client_txn_id: "batch-1" });
    const second = buildImportCommits({ events: rows, defaultActor: "ada", client_txn_id: "batch-1" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.commits[0]?.client_txn_id).toBe(second.commits[0]?.client_txn_id);
    expect(first.commits[0]?.changes[0]?.op).toBe("event.append");
  });
});

describe("secret scan", () => {
  it("flags a sample key and accepts this repo", () => {
    const sample = `AKIA${"A".repeat(16)}`;
    expect(SECRET_PATTERNS.some((pattern) => pattern.re.test(sample))).toBe(true);
    expect(scanTree(repoRoot(), SECRET_PATTERNS)).toEqual([]);
  });
});
