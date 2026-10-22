import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const requiredSecrets = {
  PLATFORM_DB_PASSWORD: "platform-secret-1234",
  TENANT_DB_PASSWORD: "tenant-secret-12345",
  MIGRATOR_DB_PASSWORD: "migrator-secret-1234",
  BACKUP_DB_PASSWORD: "backup-secret-12345",
  TENANT_JWT_SECRET: "t".repeat(40),
  PLATFORM_JWT_SECRET: "p".repeat(40),
  OTP_SECRET: "o".repeat(40),
  MFA_ENCRYPTION_KEY: "m".repeat(40),
};

/** Settings production requires on top of the secrets. */
const productionEmail = {
  SMTP_HOST: "smtp.example.com",
  EMAIL_FROM: "Autoforce <no-reply@example.com>",
  STORAGE_ACCESS_KEY_ID: "prod-access-key",
  STORAGE_SECRET_ACCESS_KEY: "prod-secret-access-key",
  FILES_PUBLIC_BASE_URL: "https://files.example.com",
  MOBILE_API_BASE_URL: "https://api.example.com",
  MOBILE_LINK_BASE_URL: "https://go.example.com",
  MOBILE_ALLOWED_API_HOSTS: "api.example.com",
  BILLING_GATEWAY: "paystack",
  PAYSTACK_SECRET_KEY: "sk_live_example_0123456789",
  MOBILE_CONNECT_PRIVATE_KEY: String(
    generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
  ),
};

function issuesOf(attempt: () => unknown): readonly string[] {
  try {
    attempt();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  it("applies safe defaults for non-sensitive settings", () => {
    const config = loadConfig(requiredSecrets);

    expect(config.env).toBe("development");
    expect(config.isProduction).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
    expect(config.logFormat).toBe("json");
    expect(config.shutdownTimeoutMs).toBe(15_000);
    expect(config.http).toEqual({
      trustProxyHops: 0,
      corsAllowedOrigins: [],
      rateLimit: { windowMs: 60_000, max: 300 },
      authRateLimitMax: 30,
      bodyLimitKb: 1_024,
      exposeOpenApi: true,
    });
    expect(config.database).toMatchObject({
      host: "localhost",
      port: 54320,
      ssl: "disable",
      platformDatabase: "autoforce_platform",
      tenantTemplateDatabase: "tenant_template",
      tenantDatabasePrefix: "t_",
      roles: {
        platform: { user: "platform_app" },
        tenant: { user: "tenant_app" },
        migrator: { user: "migrator" },
      },
      tenantPools: { maxPools: 200, maxConnections: 4, idleTimeoutMs: 300_000 },
      statementTimeoutMs: 15_000,
      migrationsDir: "db/migrations",
    });
  });

  it("reads and coerces values from the environment", () => {
    const config = loadConfig({
      ...requiredSecrets,
      ...productionEmail,
      NODE_ENV: "production",
      PORT: "8080",
      LOG_LEVEL: "warn",
      DATABASE_SSL: "require",
      TENANT_POOL_MAX_POOLS: "50",
    });

    expect(config.env).toBe("production");
    expect(config.isProduction).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("warn");
    expect(config.database.ssl).toBe("require");
    expect(config.database.tenantPools.maxPools).toBe(50);
  });

  it("parses the CORS allow-list, including wildcard subdomains", () => {
    const config = loadConfig({
      ...requiredSecrets,
      CORS_ALLOWED_ORIGINS:
        " https://Admin.Autoforce.app, https://*.autoforce.app ,http://localhost:5173",
    });
    expect(config.http.corsAllowedOrigins).toEqual([
      "https://admin.autoforce.app",
      "https://*.autoforce.app",
      "http://localhost:5173",
    ]);
  });

  it("rejects malformed CORS origins", () => {
    const issues = issuesOf(() =>
      loadConfig({ ...requiredSecrets, CORS_ALLOWED_ORIGINS: "*, https://ok.example.com/path" }),
    );
    expect(issues).toEqual([expect.stringMatching(/^CORS_ALLOWED_ORIGINS:/)]);
  });

  it("hides the OpenAPI document in production unless enabled explicitly", () => {
    const production = {
      ...requiredSecrets,
      ...productionEmail,
      NODE_ENV: "production",
      DATABASE_SSL: "require",
    };
    expect(loadConfig(production).http.exposeOpenApi).toBe(false);
    expect(loadConfig({ ...production, EXPOSE_OPENAPI: "true" }).http.exposeOpenApi).toBe(true);
  });

  it("returns frozen objects", () => {
    const config = loadConfig(requiredSecrets);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.database.roles.tenant)).toBe(true);
    expect(Object.isFrozen(config.http.corsAllowedOrigins)).toBe(true);
  });

  it("requires every database password, with no fallback", () => {
    const issues = issuesOf(() => loadConfig({}));

    expect(issues.some((i) => i.startsWith("PLATFORM_DB_PASSWORD:"))).toBe(true);
    expect(issues.some((i) => i.startsWith("TENANT_DB_PASSWORD:"))).toBe(true);
    expect(issues.some((i) => i.startsWith("MIGRATOR_DB_PASSWORD:"))).toBe(true);
  });

  it("requires long signing secrets and distinct token keys", () => {
    const short = issuesOf(() => loadConfig({ ...requiredSecrets, OTP_SECRET: "too-short" }));
    expect(short).toEqual([expect.stringMatching(/^OTP_SECRET:/)]);

    const same = issuesOf(() =>
      loadConfig({ ...requiredSecrets, PLATFORM_JWT_SECRET: requiredSecrets.TENANT_JWT_SECRET }),
    );
    expect(same).toEqual([expect.stringMatching(/^PLATFORM_JWT_SECRET: must differ/)]);
  });

  it("defaults token lifetimes and OTP limits", () => {
    expect(loadConfig(requiredSecrets).auth).toMatchObject({
      issuer: "autoforce",
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      otpTtlMinutes: 10,
      otpMaxAttempts: 5,
    });
  });

  it("rejects short passwords", () => {
    const issues = issuesOf(() => loadConfig({ ...requiredSecrets, TENANT_DB_PASSWORD: "short" }));
    expect(issues).toEqual([expect.stringMatching(/^TENANT_DB_PASSWORD:/)]);
  });

  it("requires an explicit SSL mode in production", () => {
    const issues = issuesOf(() =>
      loadConfig({ ...requiredSecrets, ...productionEmail, NODE_ENV: "production" }),
    );
    expect(issues).toEqual([expect.stringMatching(/^DATABASE_SSL:/)]);
  });

  it("defaults storage to the local RustFS outside production and to AWS in production", () => {
    expect(loadConfig(requiredSecrets).storage).toEqual({
      endpoint: "http://localhost:9000",
      presignEndpoint: "http://localhost:9000",
      region: "us-east-1",
      accessKeyId: "autoforce",
      secretAccessKey: "autoforce_local_only",
      forcePathStyle: true,
      privateBucket: "autoforce-files",
      publicBucket: "autoforce-public",
      publicBaseUrl: "http://localhost:9000/autoforce-public",
    });
    const production = loadConfig({
      ...requiredSecrets,
      ...productionEmail,
      NODE_ENV: "production",
      DATABASE_SSL: "require",
    }).storage;
    expect(production).toMatchObject({
      endpoint: null,
      presignEndpoint: null,
      publicBaseUrl: "https://files.example.com",
    });
  });

  it("connects the mobile app to this server locally, with the development key", () => {
    const mobile = loadConfig(requiredSecrets).mobile;
    expect(mobile).toMatchObject({
      apiBaseUrl: "http://localhost:3000/",
      linkBaseUrl: "http://localhost:5174",
      scheme: "autoforce",
      allowedHosts: ["localhost:3000"],
      connectPrivateKeyPem: null,
      android: { packageName: null, certSha256: [], storeUrl: null },
    });
  });

  it("checks mobile settings: https in production, the API host in the allow-list", () => {
    const production = {
      ...requiredSecrets,
      ...productionEmail,
      NODE_ENV: "production",
      DATABASE_SSL: "require",
    };
    expect(loadConfig(production).mobile).toMatchObject({
      apiBaseUrl: "https://api.example.com/",
      allowedHosts: ["api.example.com"],
    });
    expect(
      issuesOf(() => loadConfig({ ...production, MOBILE_API_BASE_URL: "http://api.example.com" })),
    ).toEqual([expect.stringMatching(/^MOBILE_API_BASE_URL: must use https/)]);
    expect(
      issuesOf(() =>
        loadConfig({ ...production, MOBILE_API_BASE_URL: "https://elsewhere.example.com" }),
      ),
    ).toEqual([expect.stringMatching(/^MOBILE_ALLOWED_API_HOSTS: must include/)]);
    expect(
      issuesOf(() => loadConfig({ ...requiredSecrets, MOBILE_ANDROID_CERT_SHA256: "nope" })),
    ).toEqual([expect.stringMatching(/^MOBILE_ANDROID_CERT_SHA256:/)]);
  });

  it("defaults email to the local Mailpit outside production", () => {
    const config = loadConfig(requiredSecrets);
    expect(config.email.smtp).toMatchObject({ host: "localhost", port: 1025, secure: false });
    expect(config.email.from).toMatch(/<no-reply@/);
    expect(config.jobs).toEqual({ workerConcurrency: 4, poolMax: 5 });
  });

  it("requires an SMTP host and sender in production, and a password with an SMTP user", () => {
    const issues = issuesOf(() =>
      loadConfig({ ...requiredSecrets, NODE_ENV: "production", DATABASE_SSL: "require" }),
    );
    expect(issues).toEqual([
      expect.stringMatching(/^SMTP_HOST:/),
      expect.stringMatching(/^EMAIL_FROM:/),
      expect.stringMatching(/^STORAGE_ACCESS_KEY_ID:/),
      expect.stringMatching(/^STORAGE_SECRET_ACCESS_KEY:/),
      expect.stringMatching(/^FILES_PUBLIC_BASE_URL:/),
      expect.stringMatching(/^MOBILE_API_BASE_URL:/),
      expect.stringMatching(/^MOBILE_LINK_BASE_URL:/),
      expect.stringMatching(/^BILLING_GATEWAY:/),
      expect.stringMatching(/^MOBILE_CONNECT_KEY_FILE:/),
      expect.stringMatching(/^MOBILE_ALLOWED_API_HOSTS:/),
    ]);
    const auth = issuesOf(() => loadConfig({ ...requiredSecrets, SMTP_USER: "mailer" }));
    expect(auth).toEqual([expect.stringMatching(/^SMTP_PASSWORD:/)]);
    const from = issuesOf(() => loadConfig({ ...requiredSecrets, EMAIL_FROM: "not an address" }));
    expect(from).toEqual([expect.stringMatching(/^EMAIL_FROM:/)]);
  });

  it("requires a CA file for verify-full", () => {
    const issues = issuesOf(() => loadConfig({ ...requiredSecrets, DATABASE_SSL: "verify-full" }));
    expect(issues).toEqual([expect.stringMatching(/^DATABASE_SSL_CA_FILE:/)]);
  });

  it("rejects role and database names that are not plain identifiers", () => {
    const issues = issuesOf(() =>
      loadConfig({
        ...requiredSecrets,
        TENANT_DB_USER: 'evil"; drop',
        PLATFORM_DATABASE_NAME: "Has-Dash",
        TENANT_DATABASE_PREFIX: "t",
      }),
    );
    expect(issues).toHaveLength(3);
  });

  it("reports every invalid variable by name", () => {
    const issues = issuesOf(() =>
      loadConfig({ ...requiredSecrets, NODE_ENV: "staging", PORT: "not-a-port" }),
    );

    expect(issues).toHaveLength(2);
    expect(issues.some((issue) => issue.startsWith("NODE_ENV:"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("PORT:"))).toBe(true);
  });

  it("never echoes rejected or secret values in the error message", () => {
    const leaked = "s3cr3t-value-that-must-not-leak";
    let message = "";
    try {
      loadConfig({ LOG_LEVEL: leaked, TENANT_DB_PASSWORD: "tiny" });
    } catch (error) {
      message = (error as ConfigError).message;
    }

    expect(message).toContain("LOG_LEVEL");
    expect(message).not.toContain(leaked);
    expect(message).not.toContain("tiny");
  });

  it("rejects out-of-range ports", () => {
    expect(() => loadConfig({ ...requiredSecrets, PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...requiredSecrets, DATABASE_PORT: "0" })).toThrow(ConfigError);
  });

  it("uses the fake gateway outside production and needs Paystack's key to use Paystack", () => {
    expect(loadConfig(requiredSecrets).billing).toMatchObject({
      gateway: "fake",
      returnUrl: "http://localhost:5174/billing/return",
    });
    const issues = issuesOf(() => loadConfig({ ...requiredSecrets, BILLING_GATEWAY: "paystack" }));
    expect(issues).toEqual([expect.stringMatching(/^PAYSTACK_SECRET_KEY:/)]);
    expect(
      loadConfig({
        ...requiredSecrets,
        BILLING_GATEWAY: "paystack",
        PAYSTACK_SECRET_KEY: "sk_test_0123456789",
      }).billing,
    ).toMatchObject({ gateway: "paystack", paystackBaseUrl: "https://api.paystack.co" });
  });
});
