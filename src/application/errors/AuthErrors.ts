import { ApplicationError } from "./ApplicationError.js";

/** No (or an unusable) credential was presented (401). */
export class AuthenticationRequiredError extends ApplicationError {
  readonly code = "UNAUTHENTICATED";

  constructor() {
    super("Authentication is required");
  }
}

/** The access token is invalid or expired (401). The precise reason is only logged. */
export class InvalidAccessTokenError extends ApplicationError {
  readonly code = "INVALID_TOKEN";

  constructor(readonly reason: string) {
    super("The access token is invalid or has expired");
  }
}

export class InvalidRefreshTokenError extends ApplicationError {
  readonly code = "INVALID_REFRESH_TOKEN";

  constructor() {
    super("The session has expired. Please sign in again.");
  }
}

/** A rotated-away refresh token was used again: the session was revoked (possible theft). */
export class RefreshTokenReuseError extends ApplicationError {
  readonly code = "REFRESH_TOKEN_REUSED";

  constructor(readonly sessionId: string) {
    super("The session has expired. Please sign in again.");
  }
}

/** The caller lacks the permission (or scope) for this action (403). */
export class PermissionDeniedError extends ApplicationError {
  readonly code = "FORBIDDEN";

  constructor(readonly permission: string) {
    super("You do not have permission to perform this action");
  }
}

export type OtpFailureReason = "invalid" | "expired" | "locked" | "not_found";

export class OtpVerificationFailedError extends ApplicationError {
  readonly code: string;

  constructor(
    readonly reason: OtpFailureReason,
    readonly remainingAttempts?: number,
  ) {
    super(
      reason === "locked"
        ? "Too many attempts. Request a new code."
        : reason === "invalid"
          ? "The code is incorrect"
          : "The code has expired. Request a new code.",
    );
    this.code =
      reason === "locked" ? "OTP_LOCKED" : reason === "invalid" ? "OTP_INVALID" : "OTP_EXPIRED";
  }
}
