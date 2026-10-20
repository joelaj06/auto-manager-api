import { ApplicationError } from "./ApplicationError.js";

/**
 * The business's SMS provider refused or could not be reached (502). `permanent` failures (wrong
 * credentials, unknown sender ID, no balance) are not retried.
 */
export class SmsProviderError extends ApplicationError {
  readonly code = "SMS_PROVIDER_FAILED";
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** The business has no SMS provider set up (409). */
export class SmsNotConfiguredError extends ApplicationError {
  readonly code = "SMS_NOT_CONFIGURED";
  constructor() {
    super("Set up your SMS provider first (Settings › Notifications)");
  }
}
