import { DomainError } from "../errors/DomainError.js";

export class InvalidSlugError extends DomainError {
  readonly code = "INVALID_SLUG";
  constructor(message: string) {
    super(message);
  }
}

const PATTERN = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;
/** Names that could be confused with our own hosts or services. */
const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "apps",
  "auth",
  "autoforce",
  "billing",
  "blog",
  "cdn",
  "console",
  "dashboard",
  "dev",
  "docs",
  "help",
  "internal",
  "login",
  "mail",
  "manager",
  "mobile",
  "partner",
  "partners",
  "platform",
  "portal",
  "root",
  "signup",
  "staging",
  "static",
  "status",
  "support",
  "system",
  "test",
  "web",
  "www",
]);

/** A tenant's address name (alpha → alpha.<domain>, X-Tenant: alpha). */
export class TenantSlug {
  private constructor(readonly value: string) {}

  static parse(input: string): TenantSlug {
    const value = input.trim().toLowerCase();
    if (value.length < 3 || !PATTERN.test(value) || value.includes("--")) {
      throw new InvalidSlugError(
        "Use 3–40 lowercase letters, digits or single hyphens, starting and ending with a letter or digit",
      );
    }
    if (RESERVED.has(value)) throw new InvalidSlugError("This name is reserved; choose another");
    return new TenantSlug(value);
  }
}
