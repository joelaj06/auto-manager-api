import { ApplicationError } from "./ApplicationError.js";

export class TenantDatabaseUnavailableError extends ApplicationError {
  readonly code = "TENANT_DATABASE_UNAVAILABLE";

  constructor(
    readonly tenantId: string,
    options?: { cause?: unknown },
  ) {
    super(`Database for tenant ${tenantId} is unavailable`, options);
  }
}

/** The database reached does not belong to the tenant it was opened for. Treat as a security alert. */
export class TenantDatabaseMismatchError extends ApplicationError {
  readonly code = "TENANT_DATABASE_MISMATCH";

  constructor(
    readonly expectedTenantId: string,
    readonly actualTenantId: string | null,
    readonly databaseName: string,
  ) {
    super(
      `Database ${databaseName} belongs to tenant ${actualTenantId ?? "(none)"}, expected ${expectedTenantId}`,
    );
  }
}

/** The tenant's database has not been migrated to the schema this build needs yet (503). */
export class TenantSchemaOutdatedError extends ApplicationError {
  readonly code = "TENANT_SCHEMA_OUTDATED";

  constructor(
    readonly tenantId: string,
    readonly currentVersion: string | null,
    readonly requiredVersion: string,
  ) {
    super(
      `Tenant ${tenantId} database schema is at ${currentVersion ?? "(none)"}, requires ${requiredVersion}`,
    );
  }
}

/** A tenant-scoped operation ran outside a tenant context (programming error). */
export class MissingTenantContextError extends ApplicationError {
  readonly code = "TENANT_CONTEXT_MISSING";

  constructor() {
    super("No tenant is set for the current operation");
  }
}

/** A repository was used outside IUnitOfWork.run (programming error). */
export class NoActiveTransactionError extends ApplicationError {
  readonly code = "NO_ACTIVE_TRANSACTION";

  constructor() {
    super("This operation must run inside a unit of work");
  }
}
