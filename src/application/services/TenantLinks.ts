import type { TenantAddressing } from "../../domain/value-objects/TenantAddressing.js";
import { TenantNotFoundError } from "../errors/TenantErrors.js";
import type { ITenantDirectory } from "../ports/ITenantDirectory.js";

/** Links to a business's own address for work that knows its id, not its slug (jobs, billing). */
export class TenantLinks {
  constructor(
    private readonly deps: Readonly<{
      addressing: Pick<TenantAddressing, "urlOf">;
      tenants: Pick<ITenantDirectory, "findById">;
    }>,
  ) {}

  async urlOf(tenantId: string, path: string): Promise<string> {
    const tenant = await this.deps.tenants.findById(tenantId);
    if (tenant === null) throw new TenantNotFoundError();
    return this.deps.addressing.urlOf(tenant.slug, path);
  }
}
