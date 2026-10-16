import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantProvisioning, ProvisioningRecord } from "../../ports/ITenantProvisioning.js";

export class ProvisioningNotFoundError extends ApplicationError {
  readonly code = "PROVISIONING_NOT_FOUND";
  constructor() {
    super("No provisioning record for this tenant");
  }
}

export class ProvisioningNotRetryableError extends ApplicationError {
  readonly code = "PROVISIONING_NOT_RETRYABLE";
  constructor(status: string) {
    super(`Provisioning is ${status}; only failed provisioning can be retried`);
  }
}

/** Console view of a tenant's provisioning saga, and the staff "retry" action. */
export class ProvisioningConsole {
  constructor(
    private readonly deps: Readonly<{
      provisioning: ITenantProvisioning;
      queue: IJobQueue;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  async status(tenantId: string): Promise<ProvisioningRecord> {
    const record = await this.deps.provisioning.find(tenantId);
    if (record === null) throw new ProvisioningNotFoundError();
    return record;
  }

  async retry(tenantId: string, actor: PlatformPrincipal): Promise<void> {
    const record = await this.status(tenantId);
    if (record.status !== "failed") throw new ProvisioningNotRetryableError(record.status);
    await this.deps.queue.enqueue("tenant.provision", { tenantId }, { singletonKey: tenantId });
    const request = this.deps.requestContext.current();
    await this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "tenant.provisioning_retried",
      entityType: "tenant",
      entityId: tenantId,
      targetTenantId: tenantId,
      before: { step: record.step, error: record.lastError },
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }
}
