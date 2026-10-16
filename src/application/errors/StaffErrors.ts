import { ApplicationError } from "./ApplicationError.js";

/** Wrong email or password — deliberately vague so accounts cannot be discovered (401). */
export class InvalidCredentialsError extends ApplicationError {
  readonly code = "INVALID_CREDENTIALS";
  constructor() {
    super("The email or password is incorrect");
  }
}

/** Account temporarily locked after repeated failures (429). */
export class TooManyAttemptsError extends ApplicationError {
  readonly code = "TOO_MANY_ATTEMPTS";
  constructor() {
    super("Too many failed attempts. Try again later.");
  }
}

export class InvalidMfaCodeError extends ApplicationError {
  readonly code = "INVALID_MFA_CODE";
  constructor() {
    super("The authentication code is incorrect or was already used");
  }
}

/** The sign-in step token is missing, expired or for another step (401). */
export class InvalidChallengeError extends ApplicationError {
  readonly code = "INVALID_CHALLENGE";
  constructor(readonly reason: string) {
    super("This sign-in step has expired. Please start again.");
  }
}

export class InvitationInvalidError extends ApplicationError {
  readonly code = "INVITATION_INVALID";
  constructor() {
    super("This invitation link is invalid or has expired. Ask for a new one.");
  }
}

/** A sensitive action needs a recent re-authentication (403). */
export class StepUpRequiredError extends ApplicationError {
  readonly code = "STEP_UP_REQUIRED";
  constructor() {
    super("Confirm your password and authentication code to continue");
  }
}

export class WeakPasswordError extends ApplicationError {
  readonly code = "WEAK_PASSWORD";
  constructor(readonly problem: string) {
    super(problem);
  }
}

export class StaffNotFoundError extends ApplicationError {
  readonly code = "STAFF_NOT_FOUND";
  constructor() {
    super("Staff member not found");
  }
}

export class StaffAlreadyExistsError extends ApplicationError {
  readonly code = "STAFF_EXISTS";
  constructor() {
    super("A staff account with this email already exists");
  }
}

export class RoleNotFoundError extends ApplicationError {
  readonly code = "ROLE_NOT_FOUND";
  constructor() {
    super("Role not found");
  }
}

export class ApprovalNotFoundError extends ApplicationError {
  readonly code = "APPROVAL_NOT_FOUND";
  constructor() {
    super("Approval request not found");
  }
}

/** Business rules of staff administration, each with its own code (422). */
export class StaffRuleViolationError extends ApplicationError {
  constructor(
    readonly code:
      | "CANNOT_CHANGE_OWN_ACCOUNT"
      | "LAST_SUPER_ADMIN"
      | "SYSTEM_ROLE_LOCKED"
      | "ROLE_EXCEEDS_OWN_PERMISSIONS"
      | "SUPER_ADMIN_NEEDS_APPROVAL"
      | "APPROVER_ROLE_REQUIRED"
      | "UNKNOWN_PERMISSION",
    message: string,
  ) {
    super(message);
  }
}
