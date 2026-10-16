import { USABLE_TENANT_STATUSES } from "../../../application/authorization/TenantAccessRules.js";
import type { ITenantRoster, RosterTenant } from "../../../application/ports/ITenantRoster.js";
import type { Queryable } from "../postgres/Queryable.js";

export class PostgresTenantRoster implements ITenantRoster {
  constructor(private readonly platform: Queryable) {}

  async listUsable(afterId: string | null, limit: number): Promise<RosterTenant[]> {
    const { rows } = await this.platform.query<RosterTenant>(
      `select id, status, timezone
         from tenants
        where status = any($1) and ($2::uuid is null or id > $2)
        order by id
        limit $3`,
      [USABLE_TENANT_STATUSES, afterId, limit],
    );
    return rows;
  }
}
