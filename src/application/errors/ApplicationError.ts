/**
 * Base class for failures of a use case or an application port that are not business-rule
 * violations (e.g. a tenant database that cannot be reached). Each carries a stable `code`.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
