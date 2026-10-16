import { TenantInactiveError, TenantNotFoundError } from "../errors/TenantErrors.js";
import type { TenantStatus, TenantSummary } from "../ports/ITenantDirectory.js";

/** Statuses in which the tenant's users may use the system (docs/25 tenant lifecycle). */
const USABLE: ReadonlySet<TenantStatus> = new Set(["trialing", "active", "past_due", "read_only"]);
/** Tenants that do not exist yet as far as their users are concerned. */
const NOT_READY: ReadonlySet<TenantStatus> = new Set(["provisioning", "provisioning_failed"]);

/**
 * Whether a tenant may be used at all. Write-blocking for `read_only` tenants belongs to the
 * billing phase and is enforced separately.
 */
export function assertTenantUsable(tenant: TenantSummary): void {
  if (USABLE.has(tenant.status)) return;
  if (NOT_READY.has(tenant.status)) throw new TenantNotFoundError();
  throw new TenantInactiveError(tenant.status);
}
