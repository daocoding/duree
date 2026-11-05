import { readFileSync } from "node:fs";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

const eventsPath = arg("--events");
const artifactsPath = arg("--artifacts");
const url = arg("--url") ?? "http://127.0.0.1:8787";
const token = process.env.DUREE_TOKEN ?? arg("--token");
const workspace = arg("--workspace") ?? "main";
const clientTxn = arg("--client-txn");

if (!token) {
  console.error("Set DUREE_TOKEN or pass --token. Do not commit the token.");
  process.exit(1);
}
if (!eventsPath && !artifactsPath) {
  console.error("usage: npm run import:jsonl -- --events events.jsonl --artifacts artifacts.jsonl --url http://127.0.0.1:8787");
  process.exit(1);
}

const events = eventsPath ? readJsonl(eventsPath) : [];
const artifacts = artifactsPath ? readJsonl(artifactsPath) : [];
const response = await fetch(`${url.replace(/\/$/, "")}/v1/import`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-duree-workspace": workspace,
  },
  body: JSON.stringify({
    events,
    artifacts,
    ...(clientTxn ? { client_txn_id: clientTxn } : {}),
  }),
});
const body = await response.json();
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exit(1);
