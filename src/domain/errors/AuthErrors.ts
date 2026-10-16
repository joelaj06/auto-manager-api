import { DomainError } from "./DomainError.js";

export class SessionNotActiveError extends DomainError {
  readonly code = "SESSION_NOT_ACTIVE";

  constructor() {
    super("The session has expired or was signed out");
  }
}

export class OtpChallengeClosedError extends DomainError {
  readonly code = "OTP_CHALLENGE_CLOSED";

  constructor() {
    super("This code can no longer be used");
  }
}
