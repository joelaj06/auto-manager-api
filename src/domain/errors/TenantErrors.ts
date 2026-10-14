import { DomainError } from "./DomainError.js";

export class InvalidTenantIdError extends DomainError {
  readonly code = "INVALID_TENANT_ID";

  constructor() {
    super("Tenant id must be a UUID");
  }
}
