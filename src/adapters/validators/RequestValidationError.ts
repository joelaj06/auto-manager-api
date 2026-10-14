export type ValidationIssue = Readonly<{
  /** Where the problem is, e.g. "body.email" or "query.limit". */
  field: string;
  message: string;
}>;

/** The request did not match its schema (400). Issues never include the submitted values. */
export class RequestValidationError extends Error {
  readonly code = "VALIDATION_FAILED";

  constructor(readonly issues: readonly ValidationIssue[]) {
    super("The request is invalid");
    this.name = "RequestValidationError";
  }
}
