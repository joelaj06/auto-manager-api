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

/** Deactivated by billing: only billing (and signing in and out) works until it is paid (403). */
export class TenantBillingOnlyError extends ApplicationError {
  readonly code = "TENANT_DEACTIVATED";

  constructor() {
    super(
      "This business account is deactivated for an unpaid invoice. Only billing is available until it is paid.",
    );
  }
}

/** The tenant is read-only: reads work, changes are refused (403). */
export class TenantReadOnlyError extends ApplicationError {
  readonly code = "TENANT_READ_ONLY";

  constructor() {
    super("This business account is read-only at the moment. Changes are not possible.");
  }
}

/** The addressed branch is deactivated, or all of the user's branches are (403). */
export class BranchDeactivatedError extends ApplicationError {
  readonly code = "BRANCH_DEACTIVATED";

  constructor() {
    super("Your branch is deactivated. Contact your administrator.");
  }
}

export class BranchNotFoundError extends ApplicationError {
  readonly code = "BRANCH_NOT_FOUND";

  constructor() {
    super("Branch not found");
  }
}

/** A branch cannot be deactivated yet (422); `blockers` say what to resolve first. */
export class BranchDeactivationBlockedError extends ApplicationError {
  readonly code = "BRANCH_DEACTIVATION_BLOCKED";

  constructor(readonly blockers: readonly string[]) {
    super(`This branch cannot be deactivated yet: ${blockers.join("; ")}`);
  }
}

export class TenantNotFoundForStaffError extends ApplicationError {
  readonly code = "TENANT_NOT_FOUND";

  constructor() {
    super("Tenant not found");
  }
}

/** The token belongs to a different tenant than the one addressed (401, security alert). */
export class TenantMismatchError extends ApplicationError {
  readonly code = "TENANT_MISMATCH";

  constructor() {
    super("The credentials do not belong to this business account");
  }
}
