import { z } from "zod";

const statuses = z.array(z.string().min(1)).min(1);

export const configSchema = z
  .object({
    version: z.literal(1),
    core: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    workspace: z
      .object({
        default: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
        issue_prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/),
        statuses,
      })
      .strict(),
    auth: z
      .object({
        bootstrap_admin: z.boolean(),
        token_ttl_days: z.number().int().nonnegative(),
      })
      .strict(),
    retrieval: z
      .object({
        ranker: z.enum(["lexical", "hybrid"]),
        embed_model: z.string().min(1),
        rerank: z.boolean(),
        rrf_k: z.number().int().positive(),
            limits: z
              .object({
                issue: z.number().int().positive(),
                memory: z.number().int().positive(),
                deck: z.number().int().positive(),
                event: z.number().int().positive(),
              })
              .strict(),
      })
      .strict(),
    deck: z
      .object({
        module: z.string().min(1),
      })
      .strict(),
    retention: z
      .object({
        change_log_days: z.number().int().nonnegative(),
      })
      .strict(),
    export: z
      .object({
        r2_nightly: z.boolean(),
      })
      .strict(),
    extensions: z.array(z.string().min(1)).default([]),
    agents: z.string().min(1).optional(),
    workspaces: z.string().min(1).optional(),
    ranking: z.string().min(1).optional(),
  })
  .strict();

export type ParsedConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(
    readonly fieldPath: string,
    message: string,
  ) {
    super(`${fieldPath}: ${message}`);
    this.name = "ConfigError";
  }
}

export function formatConfigError(error: unknown): ConfigError {
  if (error instanceof ConfigError) return error;
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") : "(root)";
    const message = issue?.message ?? "invalid config";
    return new ConfigError(path, message);
  }
  return new ConfigError("(root)", error instanceof Error ? error.message : "invalid config");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Overlay wins. Arrays replace. Unknown keys are kept so the schema can reject them. */
export function mergeConfig(base: unknown, overlay: unknown): unknown {
  if (Array.isArray(overlay)) return overlay;
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      merged[key] = key in base ? mergeConfig(base[key], value) : value;
    }
    return merged;
  }
  return overlay;
}
