import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApiKeyNotFoundError, WebhookNotFoundError } from "../../errors/IntegrationErrors.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IApiKeys } from "../../ports/IApiKeys.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IWebhooks } from "../../ports/IWebhooks.js";

/**
 * The console's view of a tenant's keys and webhooks (docs/27 §5 item 14): what exists and how
 * much it is used, and the way to stop one when a customer reports a leak.
 */
export class TenantIntegrations {
  constructor(
    private readonly deps: Readonly<{
      tenants: ITenantDirectory;
      tenantContext: ITenantContext;
      unitOfWork: IUnitOfWork;
      keys: IApiKeys;
      webhooks: IWebhooks;
      audit: IPlatformAuditTrail;
      clock: IClock;
    }>,
  ) {}

  overview(tenantId: string) {
    return this.inTenant(tenantId, async () => ({
      apiKeys: await this.deps.keys.list(true),
      webhooks: await this.deps.webhooks.endpoints(),
    }));
  }

  async revokeKey(actor: PlatformPrincipal, tenantId: string, keyId: string, reason: string) {
    const { deps } = this;
    await this.inTenant(tenantId, async () => {
      if (!(await deps.keys.revoke(keyId, null, deps.clock.now()))) throw new ApiKeyNotFoundError();
    });
    await this.audit(actor, "tenant.api_key_revoked", "api_key", keyId, tenantId, reason);
  }

  async disableWebhook(
    actor: PlatformPrincipal,
    tenantId: string,
    endpointId: string,
    reason: string,
  ) {
    const { deps } = this;
    await this.inTenant(tenantId, async () => {
      if ((await deps.webhooks.endpoint(endpointId)) === null) throw new WebhookNotFoundError();
      await deps.webhooks.updateEndpoint(
        endpointId,
        { status: "disabled", disabledReason: "Switched off by Autoforce support" },
        deps.clock.now(),
      );
    });
    await this.audit(
      actor,
      "tenant.webhook_disabled",
      "webhook_endpoint",
      endpointId,
      tenantId,
      reason,
    );
  }

  private async inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const { deps } = this;
    if ((await deps.tenants.findById(tenantId)) === null) throw new TenantNotFoundForStaffError();
    return deps.tenantContext.runAs(TenantId.from(tenantId), () => deps.unitOfWork.run(fn));
  }

  private audit(
    actor: PlatformPrincipal,
    action: string,
    entityType: string,
    entityId: string,
    tenantId: string,
    reason: string,
  ) {
    return this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action,
      entityType,
      entityId,
      targetTenantId: tenantId,
      reason,
    });
  }
}
