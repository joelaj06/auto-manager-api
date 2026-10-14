import { ApplicationError } from "./ApplicationError.js";

export class InvalidCursorError extends ApplicationError {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("The pagination cursor is invalid or expired");
  }
}
