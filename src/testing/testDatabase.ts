import pg from "pg";
import { loadConfig, type AppConfig } from "../infrastructure/config/config.js";

/**
 * Integration-test database settings. Tests use their own roles and databases (suffix _test,
 * tenant prefix tt_) so they never touch development data, and can run against the compose
 * cluster locally or the PostgreSQL service in CI. Where the cluster is comes from POSTGRES_*,
 * which the integration global setup sets when it starts a test container (testInfrastructure).
 */
export const TEST_DATABASE = Object.freeze({
  platformDatabase: "autoforce_platform_test",
  templateDatabase: "tenant_template_test",
  tenantPrefix: "tt_",
  roles: Object.freeze({
    platform: Object.freeze({ user: "test_platform_app", password: "test_platform_app_pw" }),
    tenant: Object.freeze({ user: "test_tenant_app", password: "test_tenant_app_pw" }),
    migrator: Object.freeze({ user: "test_migrator", password: "test_migrator_pw" }),
    backup: Object.freeze({ user: "test_backup", password: "test_backup_pw" }),
  }),
});

/** Superuser connection to the test cluster (compose locally, service container in CI). */
export function adminClientConfig(database = "postgres"): pg.ClientConfig {
  return {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 54320),
    user: process.env.POSTGRES_USER ?? "autoforce",
    password: process.env.POSTGRES_PASSWORD ?? "autoforce_local_only",
    database,
    application_name: "autoforce-tests",
  };
}

export async function connectAdmin(database = "postgres"): Promise<pg.Client> {
  const client = new pg.Client(adminClientConfig(database));
  await client.connect();
  return client;
}

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  const admin = adminClientConfig();
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_HOST: admin.host,
    DATABASE_PORT: String(admin.port),
    DATABASE_SSL: "disable",
    PLATFORM_DATABASE_NAME: TEST_DATABASE.platformDatabase,
    TENANT_TEMPLATE_DATABASE_NAME: TEST_DATABASE.templateDatabase,
    TENANT_DATABASE_PREFIX: TEST_DATABASE.tenantPrefix,
    PLATFORM_DB_USER: TEST_DATABASE.roles.platform.user,
    PLATFORM_DB_PASSWORD: TEST_DATABASE.roles.platform.password,
    TENANT_DB_USER: TEST_DATABASE.roles.tenant.user,
    TENANT_DB_PASSWORD: TEST_DATABASE.roles.tenant.password,
    MIGRATOR_DB_USER: TEST_DATABASE.roles.migrator.user,
    MIGRATOR_DB_PASSWORD: TEST_DATABASE.roles.migrator.password,
    BACKUP_DB_USER: TEST_DATABASE.roles.backup.user,
    BACKUP_DB_PASSWORD: TEST_DATABASE.roles.backup.password,
    TENANT_POOL_IDLE_TIMEOUT_MS: "5000",
    LOG_LEVEL: "silent",
    TENANT_JWT_SECRET: "test-tenant-jwt-secret-0123456789-abcdef",
    PLATFORM_JWT_SECRET: "test-platform-jwt-secret-0123456789-abcdef",
    OTP_SECRET: "test-otp-secret-0123456789-abcdefghijklmn",
    MFA_ENCRYPTION_KEY: "test-mfa-encryption-key-0123456789-abcdef",
    // Mailpit: a test container's mapped port, or the compose / CI service.
    SMTP_HOST: process.env.SMTP_HOST ?? "localhost",
    SMTP_PORT: process.env.SMTP_PORT ?? "1025",
    ...overrides,
  });
}
