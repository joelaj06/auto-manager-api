import { assertTenantUsable } from "../../authorization/TenantAccessRules.js";
import { TenantNotFoundError, TenantRequiredError } from "../../errors/TenantErrors.js";
import type { ITenantDirectory, TenantSummary } from "../../ports/ITenantDirectory.js";

/**
 * Resolves the tenant addressed by an unauthenticated tenant request (sign-in, password reset,
 * OTP) from its slug and checks that it may be used.
 */
export class ResolveTenant {
  constructor(private readonly tenants: ITenantDirectory) {}

  async execute(slug: string | null | undefined): Promise<TenantSummary> {
    if (slug === undefined || slug === null || slug.length === 0) throw new TenantRequiredError();
    const tenant = await this.tenants.findBySlug(slug);
    if (tenant === null) throw new TenantNotFoundError();
    assertTenantUsable(tenant);
    return tenant;
  }
}
