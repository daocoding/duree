import { describe, expect, it } from "vitest";
import { normalizeArtifact } from "../core/records";

describe("artifact details", () => {
  it("keeps unknown fields and lets an explicit details object override them", () => {
    const parsed = normalizeArtifact({
      id: "f1",
      path: "notes/one.md",
      producer: "ada",
      checksum: "abc",
      details: { lane: "desk", checksum: "from-details" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.parse(parsed.value.details ?? "{}")).toEqual({ checksum: "from-details", lane: "desk" });
  });

  it("rejects details whose JSON is larger than 4000 characters", () => {
    const parsed = normalizeArtifact({
      path: "notes/big.md",
      producer: "ada",
      details: { blob: "a".repeat(4000) },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("too large");
  });

  it("accepts an artifact that omits details", () => {
    const parsed = normalizeArtifact({ path: "notes/plain.md", producer: "ada" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.details).toBeNull();
  });
});
