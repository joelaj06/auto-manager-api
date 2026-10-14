/**
 * Base class for violations of business rules and invariants. Every domain error carries a
 * stable machine-readable `code` that the presentation layer maps to a response.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
