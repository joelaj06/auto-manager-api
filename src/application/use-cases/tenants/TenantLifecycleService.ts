import type {
  DeactivationReason,
  StatusTransition,
  TenantLifecycle,
} from "../../../domain/entities/TenantLifecycle.js";
import type {
  ITenantLifecycleRepository,
  StatusHistoryEntry,
} from "../../../domain/repositories/ITenantLifecycleRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { ITenantSeeder } from "../../ports/ITenantSeeder.js";
import type { ITenantSessionRevoker } from "../../ports/ITenantSessionRevoker.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export type DeactivateTenantInput = Readonly<{
  reasonCategory: Extract<DeactivationReason, "requested_pause" | "abuse" | "legal" | "other">;
  /** Internal reason, for staff and the audit log. */
  reason: string;
  /** Shown to the tenant's users on the blocking screen and in tenant-config. */
  message: string | null;
}>;

/**
 * Manual tenant lifecycle actions by platform staff (docs/27 §3.3) — special cases only; billing
 * automates the rest (P1-10).
 *
 * Deactivation blocks every user at once: the status is committed, this process forgets its
 * cached tenant status (other instances follow within seconds), and every session in the tenant
 * database is revoked so no refresh token works. Jobs and schedules skip the tenant. Restore
 * returns the previous status; users sign in again. Every transition is written to the status
 * history and the audit log, and the owner is emailed.
 */
export class TenantLifecycleService {
  constructor(
    private readonly deps: Readonly<{
      platformUnitOfWork: IPlatformUnitOfWork;
      tenants: ITenantLifecycleRepository;
      directory: ITenantDirectory;
      tenantContext: ITenantContext;
      tenantUnitOfWork: IUnitOfWork;
      sessions: ITenantSessionRevoker;
      seeder: ITenantSeeder;
      notifications: NotificationService;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  history(tenantId: string): Promise<StatusHistoryEntry[]> {
    return this.deps.tenants.history(tenantId);
  }

  async deactivate(
    tenantId: string,
    input: DeactivateTenantInput,
    actor: PlatformPrincipal,
  ): Promise<void> {
    const { deps } = this;
    const tenant = await this.transition(
      tenantId,
      actor,
      input.reason,
      "tenant.deactivated",
      (t, now) => t.deactivate(input.reasonCategory, input.message, true, now),
    );
    const revoked = await deps.tenantContext.runAs(TenantId.from(tenantId), () =>
      deps.tenantUnitOfWork.run(() =>
        deps.sessions.revokeAll("tenant_deactivated", deps.clock.now()),
      ),
    );
    deps.logger.info("Tenant deactivated", { tenantId, revokedSessions: revoked });
    await this.notifyOwner(tenant, "tenant.deactivated", input.message);
  }

  async restore(tenantId: string, reason: string, actor: PlatformPrincipal): Promise<void> {
    const tenant = await this.transition(tenantId, actor, reason, "tenant.restored", (t, now) =>
      t.reactivate(now),
    );
    await this.notifyOwner(tenant, "tenant.restored", null);
  }

  async setReadOnly(
    tenantId: string,
    reason: string,
    message: string | null,
    actor: PlatformPrincipal,
  ) {
    await this.transition(tenantId, actor, reason, "tenant.read_only_set", (t, now) =>
      t.setReadOnly(message, now),
    );
  }

  async clearReadOnly(tenantId: string, reason: string, actor: PlatformPrincipal) {
    await this.transition(tenantId, actor, reason, "tenant.read_only_cleared", (t, now) =>
      t.clearReadOnly(now),
    );
  }

  private async transition(
    tenantId: string,
    actor: PlatformPrincipal,
    reason: string,
    action: string,
    change: (tenant: TenantLifecycle, now: Date) => StatusTransition,
  ): Promise<TenantLifecycle> {
    const { deps } = this;
    const tenant = await deps.platformUnitOfWork.run(async () => {
      const locked = await deps.tenants.lockById(tenantId);
      if (locked === null) throw new TenantNotFoundForStaffError();
      const transition = change(locked, deps.clock.now());
      await deps.tenants.save(locked);
      await deps.tenants.appendHistory({
        tenantId,
        transition,
        reason,
        actorType: "platform_staff",
        actorId: actor.userId,
      });
      const request = deps.requestContext.current();
      await deps.audit.record({
        actorType: "platform_staff",
        actorId: actor.userId,
        action,
        entityType: "tenant",
        entityId: tenantId,
        targetTenantId: tenantId,
        before: { status: transition.from },
        after: {
          status: transition.to,
          reasonCategory: transition.reasonCategory,
          message: transition.message,
        },
        reason,
        requestId: request?.requestId ?? null,
        ip: request?.ip ?? null,
      });
      return locked;
    });
    deps.directory.invalidate();
    return tenant;
  }

  private async notifyOwner(
    tenant: TenantLifecycle,
    template: "tenant.deactivated" | "tenant.restored",
    message: string | null,
  ): Promise<void> {
    const { deps } = this;
    try {
      const owner = await deps.tenantContext.runAs(TenantId.from(tenant.id), () =>
        deps.tenantUnitOfWork.run(() => deps.seeder.owner()),
      );
      if (owner === null || owner.email === null) return;
      const { name, statusChangedAt } = tenant.snapshot();
      await deps.notifications.sendEmail({
        to: owner.email,
        template,
        data: { ownerName: owner.name, businessName: name, message },
        idempotencyKey: `${template}:${tenant.id}:${statusChangedAt?.toISOString() ?? ""}`,
        tenantId: tenant.id,
      });
    } catch (error) {
      deps.logger.warn("Could not email the tenant owner about a status change", {
        tenantId: tenant.id,
        error,
      });
    }
  }
}
