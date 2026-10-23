import { TenantInactiveError, TenantNotFoundError } from "../errors/TenantErrors.js";
import type { TenantStatus, TenantSummary } from "../ports/ITenantDirectory.js";

/** Statuses in which the tenant's users may use the system (docs/25 tenant lifecycle). */
export const USABLE_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze([
  "trialing",
  "active",
  "past_due",
  "read_only",
]);
const USABLE: ReadonlySet<TenantStatus> = new Set(USABLE_TENANT_STATUSES);
/** Tenants that do not exist yet as far as their users are concerned. */
const NOT_READY: ReadonlySet<TenantStatus> = new Set(["provisioning", "provisioning_failed"]);

/**
 * Whether a tenant may be used at all. Write-blocking for `read_only` tenants is enforced by the
 * access guard. With `billingOnly`, a tenant deactivated by billing passes too: its users may
 * sign in to pay, and the guard keeps them to billing (docs/25 §5.4). Jobs never pass it.
 */
export function assertTenantUsable(
  tenant: TenantSummary,
  options: Readonly<{ billingOnly?: boolean }> = {},
): void {
  if (USABLE.has(tenant.status)) return;
  if (options.billingOnly === true && tenant.billingOnly === true) return;
  if (NOT_READY.has(tenant.status)) throw new TenantNotFoundError();
  throw new TenantInactiveError(tenant.status);
}
