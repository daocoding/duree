import { repoRoot, scanTree, SECRET_PATTERNS } from "../config/load";

const findings = scanTree(repoRoot(), SECRET_PATTERNS);
if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log("secret scan clean");
