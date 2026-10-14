import { z } from "zod";

/**
 * Environment configuration, validated once at startup.
 *
 * Rules:
 * - Only non-sensitive settings may have defaults. Secrets (database URLs, signing keys,
 *   provider credentials) are added by later work packages as required values with no fallback.
 * - Validation errors list every bad variable by name but never echo its value.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppConfig = Readonly<{
  env: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}>;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const variable = issue.path.join(".") || "(root)";
      return `${variable}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }

  const { NODE_ENV, PORT, LOG_LEVEL } = parsed.data;

  return Object.freeze({
    env: NODE_ENV,
    isProduction: NODE_ENV === "production",
    port: PORT,
    logLevel: LOG_LEVEL,
  });
}
