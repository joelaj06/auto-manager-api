/**
 * Errors raised by the database layer. Each has a stable `code`; the HTTP error mapper (P0-6)
 * turns them into responses (e.g. TENANT_SCHEMA_OUTDATED → 503 "upgrading").
 */

export class TenantDatabaseUnavailableError extends Error {
  readonly code = "TENANT_DATABASE_UNAVAILABLE";

  constructor(
    readonly tenantId: string,
    options?: { cause?: unknown },
  ) {
    super(`Database for tenant ${tenantId} is unavailable`, options);
    this.name = "TenantDatabaseUnavailableError";
  }
}

/** The database reached does not belong to the tenant it was opened for. Treat as a security alert. */
export class TenantDatabaseMismatchError extends Error {
  readonly code = "TENANT_DATABASE_MISMATCH";

  constructor(
    readonly expectedTenantId: string,
    readonly actualTenantId: string | null,
    readonly databaseName: string,
  ) {
    super(
      `Database ${databaseName} belongs to tenant ${actualTenantId ?? "(none)"}, expected ${expectedTenantId}`,
    );
    this.name = "TenantDatabaseMismatchError";
  }
}

export class TenantSchemaOutdatedError extends Error {
  readonly code = "TENANT_SCHEMA_OUTDATED";

  constructor(
    readonly tenantId: string,
    readonly currentVersion: string | null,
    readonly requiredVersion: string,
  ) {
    super(
      `Tenant ${tenantId} database schema is at ${currentVersion ?? "(none)"}, requires ${requiredVersion}`,
    );
    this.name = "TenantSchemaOutdatedError";
  }
}

const PG_ERROR_CODE = /^[0-9A-Z]{5}$/;

/** PostgreSQL SQLSTATE of an error thrown by node-postgres, if any. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string" && PG_ERROR_CODE.test(code)) return code;
  }
  return undefined;
}

export const PgErrorCodes = Object.freeze({
  duplicateDatabase: "42P04",
  invalidCatalogName: "3D000",
  undefinedTable: "42P01",
  objectInUse: "55006",
  insufficientPrivilege: "42501",
  uniqueViolation: "23505",
});
