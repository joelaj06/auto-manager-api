import { ApplicationError } from "./ApplicationError.js";

/** A partner submitted too many assisted applications today (429). */
export class PartnerRateLimitedError extends ApplicationError {
  readonly code = "PARTNER_RATE_LIMITED";
  constructor() {
    super("Too many new applications today. Contact your account manager to raise the limit.");
  }
}

/** Unknown application or wrong private-link token — the same answer for both (404). */
export class ApplicationNotFoundError extends ApplicationError {
  readonly code = "APPLICATION_NOT_FOUND";
  constructor() {
    super("Application not found");
  }
}

export class SlugTakenError extends ApplicationError {
  readonly code = "SLUG_TAKEN";
  constructor() {
    super("This name is already taken; choose another");
  }
}

/** An application with this email or phone is already being processed (409). */
export class ApplicationExistsError extends ApplicationError {
  readonly code = "APPLICATION_EXISTS";
  constructor() {
    super(
      "An application with this email or phone is already in progress. Check your email for its link.",
    );
  }
}

/** A recent rejection blocks new applications for a while (409). Deliberately unspecific. */
export class ReapplyLaterError extends ApplicationError {
  readonly code = "REAPPLY_LATER";
  constructor() {
    super(
      "An application with these details cannot be submitted right now. Please contact support.",
    );
  }
}

export class AlreadyVerifiedError extends ApplicationError {
  readonly code = "ALREADY_VERIFIED";
  constructor(readonly channel: "email" | "phone") {
    super(`Your ${channel === "email" ? "email address" : "phone number"} is already verified`);
  }
}
