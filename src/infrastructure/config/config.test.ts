import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const requiredSecrets = {
  PLATFORM_DB_PASSWORD: "platform-secret-1234",
  TENANT_DB_PASSWORD: "tenant-secret-12345",
  MIGRATOR_DB_PASSWORD: "migrator-secret-1234",
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
    const production = { ...requiredSecrets, NODE_ENV: "production", DATABASE_SSL: "require" };
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

  it("rejects short passwords", () => {
    const issues = issuesOf(() => loadConfig({ ...requiredSecrets, TENANT_DB_PASSWORD: "short" }));
    expect(issues).toEqual([expect.stringMatching(/^TENANT_DB_PASSWORD:/)]);
  });

  it("requires an explicit SSL mode in production", () => {
    const issues = issuesOf(() => loadConfig({ ...requiredSecrets, NODE_ENV: "production" }));
    expect(issues).toEqual([expect.stringMatching(/^DATABASE_SSL:/)]);
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
});
