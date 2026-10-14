import { z } from "zod";

/**
 * Environment configuration, validated once at startup.
 *
 * Rules:
 * - Only non-sensitive settings may have defaults. Secrets (passwords, signing keys, provider
 *   credentials) are required and have no fallback.
 * - Validation errors list every bad variable by name but never echo its value.
 */
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const sslModes = ["disable", "require", "verify-full"] as const;

const requiredSecret = z.string().min(12, "must be at least 12 characters");
const roleName = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/, "must be a lowercase PostgreSQL identifier");
const databaseName = roleName;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(logLevels).default("info"),

    // --- PostgreSQL cluster ---
    DATABASE_HOST: z.string().min(1).default("localhost"),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(54320),
    // No default in production: the mode must be chosen explicitly there.
    DATABASE_SSL: z.enum(sslModes).optional(),
    DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
    PLATFORM_DATABASE_NAME: databaseName.default("autoforce_platform"),
    TENANT_TEMPLATE_DATABASE_NAME: databaseName.default("tenant_template"),
    TENANT_DATABASE_PREFIX: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,15}_$/, "must be lowercase, start with a letter and end with _")
      .default("t_"),

    // --- Database roles (login users) ---
    PLATFORM_DB_USER: roleName.default("platform_app"),
    PLATFORM_DB_PASSWORD: requiredSecret,
    TENANT_DB_USER: roleName.default("tenant_app"),
    TENANT_DB_PASSWORD: requiredSecret,
    MIGRATOR_DB_USER: roleName.default("migrator"),
    MIGRATOR_DB_PASSWORD: requiredSecret,

    // --- Pools and timeouts ---
    PLATFORM_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    TENANT_POOL_MAX_POOLS: z.coerce.number().int().min(1).max(10_000).default(200),
    TENANT_POOL_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(50).default(4),
    TENANT_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

    MIGRATIONS_DIR: z.string().min(1).default("db/migrations"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.DATABASE_SSL === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_SSL"],
        message: "must be set explicitly in production (disable | require | verify-full)",
      });
    }
    if (env.DATABASE_SSL === "verify-full" && env.DATABASE_SSL_CA_FILE === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_SSL_CA_FILE"],
        message: "is required when DATABASE_SSL=verify-full",
      });
    }
  });

export type SslMode = (typeof sslModes)[number];

export type DatabaseRoleCredentials = Readonly<{ user: string; password: string }>;

export type DatabaseConfig = Readonly<{
  host: string;
  port: number;
  ssl: SslMode;
  sslCaFile: string | undefined;
  platformDatabase: string;
  tenantTemplateDatabase: string;
  tenantDatabasePrefix: string;
  roles: Readonly<{
    platform: DatabaseRoleCredentials;
    tenant: DatabaseRoleCredentials;
    migrator: DatabaseRoleCredentials;
  }>;
  platformPoolMax: number;
  tenantPools: Readonly<{ maxPools: number; maxConnections: number; idleTimeoutMs: number }>;
  statementTimeoutMs: number;
  migrationsDir: string;
}>;

export type AppConfig = Readonly<{
  env: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  logLevel: (typeof logLevels)[number];
  database: DatabaseConfig;
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

  const e = parsed.data;

  return Object.freeze({
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    database: Object.freeze({
      host: e.DATABASE_HOST,
      port: e.DATABASE_PORT,
      ssl: e.DATABASE_SSL ?? "disable",
      sslCaFile: e.DATABASE_SSL_CA_FILE,
      platformDatabase: e.PLATFORM_DATABASE_NAME,
      tenantTemplateDatabase: e.TENANT_TEMPLATE_DATABASE_NAME,
      tenantDatabasePrefix: e.TENANT_DATABASE_PREFIX,
      roles: Object.freeze({
        platform: Object.freeze({ user: e.PLATFORM_DB_USER, password: e.PLATFORM_DB_PASSWORD }),
        tenant: Object.freeze({ user: e.TENANT_DB_USER, password: e.TENANT_DB_PASSWORD }),
        migrator: Object.freeze({ user: e.MIGRATOR_DB_USER, password: e.MIGRATOR_DB_PASSWORD }),
      }),
      platformPoolMax: e.PLATFORM_POOL_MAX,
      tenantPools: Object.freeze({
        maxPools: e.TENANT_POOL_MAX_POOLS,
        maxConnections: e.TENANT_POOL_MAX_CONNECTIONS,
        idleTimeoutMs: e.TENANT_POOL_IDLE_TIMEOUT_MS,
      }),
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      migrationsDir: e.MIGRATIONS_DIR,
    }),
  });
}
