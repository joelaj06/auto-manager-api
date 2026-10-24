import { readFileSync } from "node:fs";
import { HostAllowList } from "../../domain/mobile/ConnectLink.js";
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

/** Comma-separated list; each entry must match `pattern`. */
const list = (pattern: RegExp, message: string) =>
  z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .refine((entries) => entries.every((entry) => pattern.test(entry)), { message });
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "must be a version like 2.3.0");

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
    /** Sign-in and other credential endpoints: requests per client IP per 15 minutes. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
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
    /**
     * Bound on opening a connection and on waiting for a pooled one. Without it a connect that
     * stalls under load never settles, and every request for that tenant waits on it.
     */
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
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
    /** Read-only role used by backups (pg_dump). */
    BACKUP_DB_USER: roleName.default("backup"),
    BACKUP_DB_PASSWORD: requiredSecret,

    // --- Pools and timeouts ---
    PLATFORM_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    TENANT_POOL_MAX_POOLS: z.coerce.number().int().min(1).max(10_000).default(200),
    TENANT_POOL_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(50).default(4),
    /**
     * All tenant pools together, per process: beyond it the least recently used idle pools are
     * closed. Keep (API + worker processes) × (this + platform and job pools) under the server's
     * max_connections — or PgBouncer's pool size when hosted.
     */
    TENANT_POOL_MAX_TOTAL_CONNECTIONS: z.coerce.number().int().min(1).max(10_000).default(60),
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

    // --- Platform console (staff) ---
    /** Key for encrypting staff TOTP secrets at rest. */
    MFA_ENCRYPTION_KEY: signingSecret,
    /** Console origin, used in invitation links. */
    PLATFORM_CONSOLE_URL: z.url().default("http://localhost:5173"),
    PLATFORM_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
    PLATFORM_SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
    PLATFORM_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(12),

    // --- Background jobs (pg-boss in the platform database) ---
    /** Jobs of each type a worker process runs at the same time. */
    JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
    JOB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

    // --- Backups (docs/26) ---
    /** Root of local backup storage (off-site object storage replaces it with hosting). */
    BACKUP_DIR: z.string().min(1).default("backups"),
    /** RSA public key (PEM) backups are encrypted for; the private key stays off the server. */
    BACKUP_PUBLIC_KEY_FILE: z.string().min(1).optional(),
    /** Where pg_dump / pg_restore come from: the PATH, or the PostgreSQL Docker image. */
    BACKUP_PG_TOOLS: z.enum(["local", "docker"]).default("local"),
    BACKUP_PG_TOOLS_IMAGE: z.string().min(1).default("postgres:18-alpine"),
    BACKUP_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),

    // --- Public web app and platform SMS ---
    /** Public web app origin: applicant status links (signup). */
    WEB_APP_URL: z.url().default("http://localhost:5174"),
    /**
     * Platform SMS provider for signup phone verification. `log` writes messages to the log and
     * is refused at startup in production; a real provider is added once chosen.
     */
    SMS_PROVIDER: z.enum(["log"]).default("log"),
    /**
     * Push to the staff app. `log` writes pushes to the log (development); `fcm` sends through
     * Firebase Cloud Messaging with the service account in FCM_SERVICE_ACCOUNT_FILE.
     */
    PUSH_PROVIDER: z.enum(["log", "fcm"]).default("log"),
    FCM_SERVICE_ACCOUNT_FILE: z.string().min(1).optional(),

    // --- Platform billing gateway (tenants paying Autoforce, docs/25 §4) ---
    /**
     * `paystack` charges through Paystack (PAYSTACK_SECRET_KEY); `fake` is an in-process
     * gateway for development and tests (refused in production) whose webhooks are signed with
     * BILLING_FAKE_WEBHOOK_SECRET.
     */
    BILLING_GATEWAY: z.enum(["fake", "paystack"]).default("fake"),
    PAYSTACK_SECRET_KEY: z.string().min(10).optional(),
    PAYSTACK_BASE_URL: z.url().default("https://api.paystack.co"),
    BILLING_FAKE_WEBHOOK_SECRET: z.string().min(16).default("fake-gateway-webhook-secret"),
    /** Where the gateway sends the payer back after checkout (the portal's Billing page). */
    BILLING_RETURN_URL: z.url().optional(),

    // --- Console operations (docs/27 §2, §3.1, §8) ---
    /** On-call: alerts at or above ONCALL_MIN_SEVERITY are emailed and posted to the webhook. */
    ONCALL_EMAILS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      )
      .pipe(z.array(z.email())),
    /** Slack-compatible incoming webhook (`{ "text": … }`); Telegram/WhatsApp via a relay. */
    ONCALL_WEBHOOK_URL: z.url().optional(),
    ONCALL_MIN_SEVERITY: z.enum(["info", "warning", "critical"]).default("warning"),
    /** Refunds above this (minor units) need a second staff member's approval. */
    REFUND_APPROVAL_THRESHOLD_MINOR: z.coerce.number().int().min(0).default(100_000),
    /** Announcement emails to more tenants than this need a Super Admin's approval. */
    BULK_MESSAGE_APPROVAL_TENANTS: z.coerce.number().int().min(0).default(50),

    // --- Object storage (S3-compatible; files service) ---
    // Development defaults match compose.yaml (RustFS). Production sets everything explicitly;
    // without STORAGE_ENDPOINT it talks to AWS S3 in STORAGE_REGION.
    STORAGE_ENDPOINT: z.url().optional(),
    /** Endpoint written into pre-signed URLs when clients reach storage at another address. */
    STORAGE_PRESIGN_ENDPOINT: z.url().optional(),
    STORAGE_REGION: z.string().min(1).default("us-east-1"),
    STORAGE_ACCESS_KEY_ID: z.string().min(3).optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(8).optional(),
    STORAGE_FORCE_PATH_STYLE: booleanFlag.default(true),
    STORAGE_PRIVATE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .default("autoforce-files"),
    STORAGE_PUBLIC_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .default("autoforce-public"),
    /** Base URL of public files: a CDN in front of the public bucket, or the bucket itself. */
    FILES_PUBLIC_BASE_URL: z.url().optional(),

    // --- Mobile app connect (docs/23) ---
    /** The backend URL the app calls (put into connect links). Default: this server locally. */
    MOBILE_API_BASE_URL: z.url().optional(),
    /** The link domain (app links / universal links). Default: WEB_APP_URL. */
    MOBILE_LINK_BASE_URL: z.url().optional(),
    MOBILE_APP_SCHEME: z
      .string()
      .regex(/^[a-z][a-z0-9+.-]{1,30}$/)
      .default("autoforce"),
    /** Hosts the app may connect to: api.example.com, *.example.com, localhost:3000. */
    MOBILE_ALLOWED_API_HOSTS: list(
      /^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/,
      "must be comma-separated hosts like api.example.com or *.example.com",
    ),
    /** Ed25519 private key (PKCS#8 PEM) for signing connect links: a file, or the PEM itself. */
    MOBILE_CONNECT_KEY_FILE: z.string().min(1).optional(),
    MOBILE_CONNECT_PRIVATE_KEY: z.string().includes("PRIVATE KEY").optional(),
    MOBILE_ANDROID_PACKAGE: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/)
      .optional(),
    MOBILE_ANDROID_CERT_SHA256: list(
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/,
      "must be comma-separated SHA-256 fingerprints like AB:CD:…",
    ),
    MOBILE_IOS_APP_IDS: list(
      /^[A-Z0-9]{10}\.[a-zA-Z0-9.-]+$/,
      "must be comma-separated TEAMID.bundle.id values",
    ),
    MOBILE_ANDROID_STORE_URL: z.url().optional(),
    MOBILE_IOS_STORE_URL: z.url().optional(),
    MOBILE_MIN_APP_VERSION: semver.optional(),
    MOBILE_LATEST_APP_VERSION: semver.optional(),

    // --- Platform email (SMTP) ---
    // No defaults in production: host and sender must be chosen explicitly there.
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
    SMTP_SECURE: booleanFlag.default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: requiredSecret.optional(),
    EMAIL_FROM: z
      .string()
      .regex(
        /^[^<>]*<[^\s@<>]+@[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+$/,
        "must be an address or Name <address>",
      )
      .optional(),
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
    if (env.NODE_ENV === "production") {
      for (const variable of [
        "SMTP_HOST",
        "EMAIL_FROM",
        "STORAGE_ACCESS_KEY_ID",
        "STORAGE_SECRET_ACCESS_KEY",
        "FILES_PUBLIC_BASE_URL",
        "MOBILE_API_BASE_URL",
        "MOBILE_LINK_BASE_URL",
      ] as const) {
        if (env[variable] === undefined) {
          ctx.addIssue({ code: "custom", path: [variable], message: "must be set in production" });
        }
      }
    }
    if (env.BILLING_GATEWAY === "paystack" && env.PAYSTACK_SECRET_KEY === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["PAYSTACK_SECRET_KEY"],
        message: "must be set when BILLING_GATEWAY=paystack",
      });
    if (env.NODE_ENV === "production" && env.BILLING_GATEWAY === "fake")
      ctx.addIssue({
        code: "custom",
        path: ["BILLING_GATEWAY"],
        message: "the fake gateway is refused in production (use paystack)",
      });
    if (env.PUSH_PROVIDER === "fcm" && env.FCM_SERVICE_ACCOUNT_FILE === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["FCM_SERVICE_ACCOUNT_FILE"],
        message: "must be set when PUSH_PROVIDER=fcm",
      });
    if (env.NODE_ENV === "production") {
      if (env.MOBILE_CONNECT_KEY_FILE === undefined && env.MOBILE_CONNECT_PRIVATE_KEY === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["MOBILE_CONNECT_KEY_FILE"],
          message: "must be set in production (or MOBILE_CONNECT_PRIVATE_KEY)",
        });
      if (env.MOBILE_ALLOWED_API_HOSTS.length === 0)
        ctx.addIssue({
          code: "custom",
          path: ["MOBILE_ALLOWED_API_HOSTS"],
          message: "must be set in production",
        });
      for (const variable of ["MOBILE_API_BASE_URL", "MOBILE_LINK_BASE_URL"] as const) {
        const value = env[variable];
        if (value !== undefined && !value.startsWith("https://"))
          ctx.addIssue({
            code: "custom",
            path: [variable],
            message: "must use https in production",
          });
      }
    }
    if (
      env.MOBILE_API_BASE_URL !== undefined &&
      env.MOBILE_ALLOWED_API_HOSTS.length > 0 &&
      !new HostAllowList(env.MOBILE_ALLOWED_API_HOSTS).allowsUrl(env.MOBILE_API_BASE_URL)
    )
      ctx.addIssue({
        code: "custom",
        path: ["MOBILE_ALLOWED_API_HOSTS"],
        message: "must include the host of MOBILE_API_BASE_URL",
      });
    if (env.SMTP_USER !== undefined && env.SMTP_PASSWORD === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_PASSWORD"],
        message: "is required when SMTP_USER is set",
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
  connectTimeoutMs: number;
  platformDatabase: string;
  tenantTemplateDatabase: string;
  tenantDatabasePrefix: string;
  roles: Readonly<{
    platform: DatabaseRoleCredentials;
    tenant: DatabaseRoleCredentials;
    migrator: DatabaseRoleCredentials;
    backup: DatabaseRoleCredentials;
  }>;
  platformPoolMax: number;
  tenantPools: Readonly<{
    maxPools: number;
    maxConnections: number;
    maxTotalConnections: number;
    idleTimeoutMs: number;
  }>;
  statementTimeoutMs: number;
  migrationsDir: string;
}>;

export type LogLevel = (typeof logLevels)[number];

export type HttpConfig = Readonly<{
  trustProxyHops: number;
  corsAllowedOrigins: readonly string[];
  rateLimit: Readonly<{ windowMs: number; max: number }>;
  /** Stricter limit for credential endpoints (per 15 minutes). */
  authRateLimitMax: number;
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
  mfaEncryptionKey: string;
  platform: Readonly<{
    consoleUrl: string;
    accessTokenTtlSeconds: number;
    sessionIdleMinutes: number;
    sessionMaxHours: number;
  }>;
}>;

export type PublicConfig = Readonly<{ webAppUrl: string; smsProvider: "log" }>;

export type BackupConfig = Readonly<{
  directory: string;
  publicKeyFile: string | undefined;
  pgTools: Readonly<{ mode: "local" | "docker"; image: string }>;
  concurrency: number;
}>;

export type JobsConfig = Readonly<{ workerConcurrency: number; poolMax: number }>;

export type MobileConfig = Readonly<{
  apiBaseUrl: string;
  linkBaseUrl: string;
  scheme: string;
  allowedHosts: readonly string[];
  /** PEM of the signing key; null: the fixed development key (never in production). */
  connectPrivateKeyPem: string | null;
  android: Readonly<{
    packageName: string | null;
    certSha256: readonly string[];
    storeUrl: string | null;
  }>;
  ios: Readonly<{ appIds: readonly string[]; storeUrl: string | null }>;
  minVersion: string | null;
  latestVersion: string | null;
}>;

export type StorageConfig = Readonly<{
  endpoint: string | null;
  presignEndpoint: string | null;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  privateBucket: string;
  publicBucket: string;
  publicBaseUrl: string;
}>;

export type EmailConfig = Readonly<{
  smtp: Readonly<{
    host: string;
    port: number;
    secure: boolean;
    user: string | undefined;
    password: string | undefined;
  }>;
  from: string;
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
  jobs: JobsConfig;
  email: EmailConfig;
  backup: BackupConfig;
  storage: StorageConfig;
  mobile: MobileConfig;
  public: PublicConfig;
  push: PushConfig;
  billing: BillingGatewayConfig;
  operations: OperationsConfig;
}>;

export type OperationsConfig = Readonly<{
  onCallEmails: readonly string[];
  onCallWebhookUrl: string | null;
  onCallMinSeverity: "info" | "warning" | "critical";
  refundApprovalThresholdMinor: number;
  bulkMessageApprovalTenants: number;
}>;

export type BillingGatewayConfig = Readonly<{
  gateway: "fake" | "paystack";
  paystackSecretKey: string | null;
  paystackBaseUrl: string;
  fakeWebhookSecret: string;
  returnUrl: string;
}>;

export type PushConfig = Readonly<{
  provider: "log" | "fcm";
  serviceAccountFile: string | null;
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

const LOCAL_STORAGE_ENDPOINT = "http://localhost:9000";

function storageConfig(e: z.output<typeof envSchema>): StorageConfig {
  const production = e.NODE_ENV === "production";
  const endpoint = e.STORAGE_ENDPOINT ?? (production ? null : LOCAL_STORAGE_ENDPOINT);
  const presignEndpoint = e.STORAGE_PRESIGN_ENDPOINT ?? endpoint;
  return Object.freeze({
    endpoint,
    presignEndpoint,
    region: e.STORAGE_REGION,
    accessKeyId: e.STORAGE_ACCESS_KEY_ID ?? "autoforce",
    secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY ?? "autoforce_local_only",
    forcePathStyle: e.STORAGE_FORCE_PATH_STYLE,
    privateBucket: e.STORAGE_PRIVATE_BUCKET,
    publicBucket: e.STORAGE_PUBLIC_BUCKET,
    publicBaseUrl:
      e.FILES_PUBLIC_BASE_URL ??
      `${(presignEndpoint ?? LOCAL_STORAGE_ENDPOINT).replace(/\/$/, "")}/${e.STORAGE_PUBLIC_BUCKET}`,
  });
}

const origin = (url: string) => new URL(url).origin;

function mobileConfig(e: z.output<typeof envSchema>): MobileConfig {
  const apiBaseUrl = `${origin(e.MOBILE_API_BASE_URL ?? `http://localhost:${e.PORT}`)}/`;
  const keyPem =
    e.MOBILE_CONNECT_PRIVATE_KEY?.replaceAll("\\n", "\n") ??
    (e.MOBILE_CONNECT_KEY_FILE === undefined
      ? null
      : readFileSync(e.MOBILE_CONNECT_KEY_FILE, "utf8"));
  return Object.freeze({
    apiBaseUrl,
    linkBaseUrl: origin(e.MOBILE_LINK_BASE_URL ?? e.WEB_APP_URL),
    scheme: e.MOBILE_APP_SCHEME,
    allowedHosts: Object.freeze(
      e.MOBILE_ALLOWED_API_HOSTS.length > 0
        ? e.MOBILE_ALLOWED_API_HOSTS.map((h) => h.toLowerCase())
        : [new URL(apiBaseUrl).host],
    ),
    connectPrivateKeyPem: keyPem,
    android: Object.freeze({
      packageName: e.MOBILE_ANDROID_PACKAGE ?? null,
      certSha256: Object.freeze([...e.MOBILE_ANDROID_CERT_SHA256]),
      storeUrl: e.MOBILE_ANDROID_STORE_URL ?? null,
    }),
    ios: Object.freeze({
      appIds: Object.freeze([...e.MOBILE_IOS_APP_IDS]),
      storeUrl: e.MOBILE_IOS_STORE_URL ?? null,
    }),
    minVersion: e.MOBILE_MIN_APP_VERSION ?? null,
    latestVersion: e.MOBILE_LATEST_APP_VERSION ?? null,
  });
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
      authRateLimitMax: e.AUTH_RATE_LIMIT_MAX,
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
      mfaEncryptionKey: e.MFA_ENCRYPTION_KEY,
      platform: Object.freeze({
        consoleUrl: e.PLATFORM_CONSOLE_URL,
        accessTokenTtlSeconds: e.PLATFORM_ACCESS_TOKEN_TTL_SECONDS,
        sessionIdleMinutes: e.PLATFORM_SESSION_IDLE_MINUTES,
        sessionMaxHours: e.PLATFORM_SESSION_MAX_HOURS,
      }),
    }),
    public: Object.freeze({ webAppUrl: e.WEB_APP_URL, smsProvider: e.SMS_PROVIDER }),
    billing: Object.freeze({
      gateway: e.BILLING_GATEWAY,
      paystackSecretKey: e.PAYSTACK_SECRET_KEY ?? null,
      paystackBaseUrl: e.PAYSTACK_BASE_URL,
      fakeWebhookSecret: e.BILLING_FAKE_WEBHOOK_SECRET,
      returnUrl: e.BILLING_RETURN_URL ?? `${e.WEB_APP_URL}/billing/return`,
    }),
    operations: Object.freeze({
      onCallEmails: Object.freeze([...e.ONCALL_EMAILS]),
      onCallWebhookUrl: e.ONCALL_WEBHOOK_URL ?? null,
      onCallMinSeverity: e.ONCALL_MIN_SEVERITY,
      refundApprovalThresholdMinor: e.REFUND_APPROVAL_THRESHOLD_MINOR,
      bulkMessageApprovalTenants: e.BULK_MESSAGE_APPROVAL_TENANTS,
    }),
    push: Object.freeze({
      provider: e.PUSH_PROVIDER,
      serviceAccountFile: e.FCM_SERVICE_ACCOUNT_FILE ?? null,
    }),
    backup: Object.freeze({
      directory: e.BACKUP_DIR,
      publicKeyFile: e.BACKUP_PUBLIC_KEY_FILE,
      pgTools: Object.freeze({ mode: e.BACKUP_PG_TOOLS, image: e.BACKUP_PG_TOOLS_IMAGE }),
      concurrency: e.BACKUP_CONCURRENCY,
    }),
    jobs: Object.freeze({ workerConcurrency: e.JOB_WORKER_CONCURRENCY, poolMax: e.JOB_POOL_MAX }),
    storage: storageConfig(e),
    mobile: mobileConfig(e),
    email: Object.freeze({
      smtp: Object.freeze({
        host: e.SMTP_HOST ?? "localhost",
        port: e.SMTP_PORT,
        secure: e.SMTP_SECURE,
        user: e.SMTP_USER,
        password: e.SMTP_PASSWORD,
      }),
      from: e.EMAIL_FROM ?? "Autoforce Manager <no-reply@autoforce.localhost>",
    }),
    database: Object.freeze({
      host: e.DATABASE_HOST,
      port: e.DATABASE_PORT,
      ssl: e.DATABASE_SSL ?? "disable",
      sslCaFile: e.DATABASE_SSL_CA_FILE,
      connectTimeoutMs: e.DATABASE_CONNECT_TIMEOUT_MS,
      platformDatabase: e.PLATFORM_DATABASE_NAME,
      tenantTemplateDatabase: e.TENANT_TEMPLATE_DATABASE_NAME,
      tenantDatabasePrefix: e.TENANT_DATABASE_PREFIX,
      roles: Object.freeze({
        platform: Object.freeze({ user: e.PLATFORM_DB_USER, password: e.PLATFORM_DB_PASSWORD }),
        tenant: Object.freeze({ user: e.TENANT_DB_USER, password: e.TENANT_DB_PASSWORD }),
        migrator: Object.freeze({ user: e.MIGRATOR_DB_USER, password: e.MIGRATOR_DB_PASSWORD }),
        backup: Object.freeze({ user: e.BACKUP_DB_USER, password: e.BACKUP_DB_PASSWORD }),
      }),
      platformPoolMax: e.PLATFORM_POOL_MAX,
      tenantPools: Object.freeze({
        maxPools: e.TENANT_POOL_MAX_POOLS,
        maxConnections: e.TENANT_POOL_MAX_CONNECTIONS,
        maxTotalConnections: e.TENANT_POOL_MAX_TOTAL_CONNECTIONS,
        idleTimeoutMs: e.TENANT_POOL_IDLE_TIMEOUT_MS,
      }),
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      migrationsDir: e.MIGRATIONS_DIR,
    }),
  });
}
