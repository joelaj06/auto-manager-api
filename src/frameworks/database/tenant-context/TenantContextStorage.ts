import { AsyncLocalStorage } from "node:async_hooks";
import { TenantModel } from "../mongodb/tenant/TenantModelFactory";

export interface RequestTenantContext {
  tenant: any;
  connection: any;
  models: TenantModel;
  requestId: string;
}

export const tenantContextStorage =
  new AsyncLocalStorage<RequestTenantContext>();

export const getTenantContext = (): RequestTenantContext => {
  const ctx = tenantContextStorage.getStore();
  if (!ctx) {
    throw new Error(
      "Tenant context not found — was this called outside a request, or before tenantResolutionMiddleware ran?",
    );
  }
  return ctx;
};

export const getTenantModels = (): TenantModel => getTenantContext().models;
