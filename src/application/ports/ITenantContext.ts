import type { TenantId } from "../../domain/value-objects/TenantId.js";

/**
 * The tenant the current operation acts for. Set once per request (or job) by the adapters
 * layer and read by tenant-scoped infrastructure such as the unit of work.
 */
export interface ITenantContext {
  /** Runs `fn` with `tenantId` as the current tenant. */
  runAs<T>(tenantId: TenantId, fn: () => Promise<T>): Promise<T>;
  /** The current tenant; throws MissingTenantContextError when none is set. */
  currentTenantId(): TenantId;
}
