import { ApplicationError } from "./ApplicationError.js";

export class UserNotFoundError extends ApplicationError {
  readonly code = "USER_NOT_FOUND";
  constructor() {
    super("User not found");
  }
}

export class UserExistsError extends ApplicationError {
  readonly code = "USER_EXISTS";
  constructor() {
    super("A user with this email or phone already exists in your business");
  }
}

export class TenantRoleNotFoundError extends ApplicationError {
  readonly code = "ROLE_NOT_FOUND";
  constructor() {
    super("Role not found");
  }
}

export type IdentityRule =
  | "CANNOT_CHANGE_OWN_ACCOUNT"
  | "OWNER_ROLE_PROTECTED"
  | "ROLE_EXCEEDS_OWN_PERMISSIONS"
  | "SYSTEM_ROLE_LOCKED"
  | "ROLE_IN_USE"
  | "ROLE_NAME_TAKEN"
  | "BRANCH_OUT_OF_SCOPE"
  | "INVALID_SCOPE"
  | "UNKNOWN_PERMISSION"
  | "UNKNOWN_BRANCH"
  | "BRANCH_CODE_TAKEN"
  | "INVALID_TIMEZONE"
  | "CONTACT_REQUIRED";

/** A rule of user, role or organisation management, each with its own code. */
export class IdentityRuleError extends ApplicationError {
  constructor(
    readonly code: IdentityRule,
    message: string,
  ) {
    super(message);
  }
}
