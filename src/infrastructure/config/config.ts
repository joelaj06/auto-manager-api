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
/** Signing / HMAC keys: long random strings (e.g. `openssl rand -base64 48`). */
const signingSecret = z.string().min(32, "must be at least 32 characters");
const roleName = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/, "must be a lowercase PostgreSQL identifier");
const databaseName = roleName;

/** "https://app.example.com" or "https://*.example.com" (any subdomain), comma-separated. */
const ORIGIN_PATTERN = /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/;
const corsOrigins = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim().toLowerCase())
      .filter((origin) => origin.length > 0),
  )
  .refine((origins) => origins.every((origin) => ORIGIN_PATTERN.test(origin)), {
    message:
      "must be comma-separated origins like https://app.example.com or https://*.example.com",
  });

const booleanFlag = z.enum(["true", "false"]).transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(logLevels).default("info"),
    LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),

    // --- HTTP ---
    /** Number of reverse proxies in front of the app (0 = none); needed for real client IPs. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    CORS_ALLOWED_ORIGINS: corsOrigins,
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    HTTP_BODY_LIMIT_KB: z.coerce.number().int().min(1).max(10_240).default(1_024),
    /** Serve /api/v1/openapi.json (defaults to on outside production). */
    EXPOSE_OPENAPI: booleanFlag.optional(),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),

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

    // --- Authentication ---
    /** Master key for tenant access tokens; a per-tenant key is derived from it (HKDF). */
    TENANT_JWT_SECRET: signingSecret,
    /** Separate key for platform-console tokens (never accepted on tenant routes). */
    PLATFORM_JWT_SECRET: signingSecret,
    JWT_ISSUER: z.string().min(1).default("autoforce"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** Key for hashing one-time codes at rest (HMAC-SHA256). */
    OTP_SECRET: signingSecret,
    OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  })
  .superRefine((env, ctx) => {
    if (env.TENANT_JWT_SECRET === env.PLATFORM_JWT_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["PLATFORM_JWT_SECRET"],
        message: "must differ from TENANT_JWT_SECRET",
      });
    }
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

export type LogLevel = (typeof logLevels)[number];

export type HttpConfig = Readonly<{
  trustProxyHops: number;
  corsAllowedOrigins: readonly string[];
  rateLimit: Readonly<{ windowMs: number; max: number }>;
  bodyLimitKb: number;
  exposeOpenApi: boolean;
}>;

export type AuthConfig = Readonly<{
  tenantJwtSecret: string;
  platformJwtSecret: string;
  issuer: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  otpSecret: string;
  otpTtlMinutes: number;
  otpMaxAttempts: number;
}>;

export type AppConfig = Readonly<{
  env: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  logLevel: LogLevel;
  logFormat: "json" | "pretty";
  shutdownTimeoutMs: number;
  http: HttpConfig;
  database: DatabaseConfig;
  auth: AuthConfig;
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
    logFormat: e.LOG_FORMAT,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    http: Object.freeze({
      trustProxyHops: e.TRUST_PROXY_HOPS,
      corsAllowedOrigins: Object.freeze([...e.CORS_ALLOWED_ORIGINS]),
      rateLimit: Object.freeze({ windowMs: e.RATE_LIMIT_WINDOW_MS, max: e.RATE_LIMIT_MAX }),
      bodyLimitKb: e.HTTP_BODY_LIMIT_KB,
      exposeOpenApi: e.EXPOSE_OPENAPI ?? e.NODE_ENV !== "production",
    }),
    auth: Object.freeze({
      tenantJwtSecret: e.TENANT_JWT_SECRET,
      platformJwtSecret: e.PLATFORM_JWT_SECRET,
      issuer: e.JWT_ISSUER,
      accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
      otpSecret: e.OTP_SECRET,
      otpTtlMinutes: e.OTP_TTL_MINUTES,
      otpMaxAttempts: e.OTP_MAX_ATTEMPTS,
    }),
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
