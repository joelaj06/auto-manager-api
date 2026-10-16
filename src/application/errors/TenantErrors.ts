import { ApplicationError } from "./ApplicationError.js";

/** A tenant-scoped request did not say which tenant it is for (400). */
export class TenantRequiredError extends ApplicationError {
  readonly code = "TENANT_REQUIRED";

  constructor() {
    super("The X-Tenant header is required");
  }
}

export class TenantNotFoundError extends ApplicationError {
  readonly code = "TENANT_NOT_FOUND";

  constructor() {
    super("Unknown business account");
  }
}

/** The tenant exists but is not allowed to use the system now (403). */
export class TenantInactiveError extends ApplicationError {
  readonly code = "TENANT_DEACTIVATED";

  constructor(readonly status: string) {
    super("This business account is deactivated. Please contact support.");
  }
}

/** The token belongs to a different tenant than the one addressed (401, security alert). */
export class TenantMismatchError extends ApplicationError {
  readonly code = "TENANT_MISMATCH";

  constructor() {
    super("The credentials do not belong to this business account");
  }
}
