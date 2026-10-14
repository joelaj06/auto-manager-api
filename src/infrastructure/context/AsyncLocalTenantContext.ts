import { AsyncLocalStorage } from "node:async_hooks";
import { MissingTenantContextError } from "../../application/errors/TenantDatabaseErrors.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { TenantId } from "../../domain/value-objects/TenantId.js";

/** ITenantContext backed by AsyncLocalStorage: the tenant follows the async call chain. */
export class AsyncLocalTenantContext implements ITenantContext {
  private readonly storage = new AsyncLocalStorage<TenantId>();

  runAs<T>(tenantId: TenantId, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(tenantId, fn);
  }

  currentTenantId(): TenantId {
    const tenantId = this.storage.getStore();
    if (tenantId === undefined) throw new MissingTenantContextError();
    return tenantId;
  }
}
