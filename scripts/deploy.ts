import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../config/schema";
import { loadConfig, renderWrangler } from "../config/load";
import { writeExtensionBundle } from "./bundle-extensions";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const apply = process.argv.includes("--apply");
const overlay = arg("--overlay");

try {
  const loaded = loadConfig({ overlayDir: overlay });
  const bundle = writeExtensionBundle(loaded, overlay);
  const rendered = renderWrangler(loaded);
  if (rendered.includes("DUREE_BOOTSTRAP_TOKEN") || rendered.includes("DUREE_ALLOW_DEV_AUTH")) {
    throw new ConfigError("vars", "rendered wrangler config must not contain tokens or the dev auth flag");
  }
  const dir = join(loaded.root, "dist");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "wrangler.rendered.json");
  writeFileSync(out, `${rendered}\n`);
  for (const warning of loaded.warnings) console.warn(`warning: ${warning}`);
  console.log(`validated config, wrote ${bundle}, and wrote ${out}`);
  if (!apply) {
    console.log("validated only. Re-run with --apply to deploy with your own Cloudflare account.");
    process.exit(0);
  }
  const account = loaded.overlay.account_id ?? "";
  if (!account || account.includes("example") || account.includes("not-a-real")) {
    throw new ConfigError("account_id", "refusing --apply until wrangler.overlay.toml has a real account_id");
  }
  console.log("Set DUREE_BOOTSTRAP_TOKEN with wrangler secret put. It is not written to the rendered config.");
  const result = spawnSync("npx", ["wrangler", "deploy", "--config", out], {
    cwd: loaded.root,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
