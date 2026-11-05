/**
 * Activity entries describe the work. They never carry secrets.
 * The patterns are intentionally narrow so ordinary prose is kept.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9\-_\.]{20,}/i,
  /\b(?:api[_-]?key|secret|access[_-]?token|password)\s*[:=]\s*\S{8,}/i,
];

export function containsSensitive(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export const SENSITIVE_MESSAGE =
  "activity entries and artifacts must describe the work, not carry secrets; store a path or a reference instead";
