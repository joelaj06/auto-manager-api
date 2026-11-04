import { randomBytes } from "node:crypto";
import { ClusterRuleError } from "../../../domain/console/Clusters.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IClusterRegistry } from "../../ports/IClusterRegistry.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { ISecretBox } from "../../ports/ISecretBox.js";
import type {
  ITenantDatabaseCredentials,
  ITenantDatabaseRoles,
  ITenantLoginCache,
} from "../../ports/ITenantDatabaseCredentials.js";
import type { EnterpriseGate } from "../integrations/EnterpriseGate.js";
import type { ApprovalExecutor, ApprovalWorkflow } from "../platform/ApprovalWorkflow.js";
import type { IAlerts } from "./PlatformAlerts.js";

export const DATABASE_LOGIN_ACTION = "tenant.database_credentials";
export type LoginAction = JobPayloads["tenant.database_credentials"]["action"];

const newPassword = () => randomBytes(32).toString("base64url");

const SUMMARY: Readonly<Record<LoginAction, string>> = {
  enable: "Give {slug} its own database login",
  rotate: "Change the password of {slug}'s database login",
  disable: "Take {slug}'s own database login back and use the shared one",
};

/**
 * A tenant's own PostgreSQL login (docs/22 §2.4 safeguard 4, decision 532): asked for and approved
 * by two staff members, then carried out by the job below. The login reaches this tenant's
 * database and no other, and the shared login loses that database, so a bug in the app physically
 * cannot cross between them.
 */
export class TenantDatabaseLogins {
  constructor(
    private readonly deps: Readonly<{
      credentials: ITenantDatabaseCredentials;
      registry: IClusterRegistry;
      gate: EnterpriseGate;
      approvals: ApprovalWorkflow;
      queue: IJobQueue;
    }>,
  ) {}

  async status(tenantId: string) {
    const record = await this.deps.credentials.find(tenantId);
    if (record === null) return { enabled: false as const };
    return {
      enabled: record.status !== "enabling",
      status: record.status,
      role: record.roleName,
      version: record.version,
      rotatedAt: record.rotatedAt,
      createdAt: record.createdAt,
    };
  }

  async request(
    actor: PlatformPrincipal,
    tenantId: string,
    input: Readonly<{ action: LoginAction; reason: string; ticket?: string | null }>,
  ): Promise<string> {
    const tenant = await this.check(tenantId, input.action);
    if (input.reason.trim().length < 3) throw new ClusterRuleError("Give a reason");
    return this.deps.approvals.request({
      action: DATABASE_LOGIN_ACTION,
      payload: { tenantId, action: input.action },
      summary: SUMMARY[input.action].replace("{slug}", tenant.slug),
      reason: input.reason,
      ticket: input.ticket ?? null,
      targetTenantId: tenantId,
      requestedBy: actor.userId,
    });
  }

  executor(): ApprovalExecutor {
    return {
      action: DATABASE_LOGIN_ACTION,
      approverSystemRole: null,
      execute: async (payload) => {
        const tenantId = String(payload.tenantId);
        const action = String(payload.action) as LoginAction;
        await this.check(tenantId, action);
        await this.deps.queue.enqueue("tenant.database_credentials", { tenantId, action });
        return { tenantId, action };
      },
    };
  }

  private async check(tenantId: string, action: LoginAction) {
    const tenant = await this.deps.registry.placement(tenantId);
    if (tenant === null) throw new ClusterRuleError("Unknown tenant");
    if (!tenant.hasDatabase) throw new ClusterRuleError("The tenant has no database");
    if (tenant.moving) throw new ClusterRuleError("The tenant is being moved");
    if (["provisioning", "provisioning_failed", "archived"].includes(tenant.status))
      throw new ClusterRuleError(`A ${tenant.status} tenant has no database to protect`);
    const record = await this.deps.credentials.find(tenantId);
    if (action === "enable") {
      await this.deps.gate.require(tenantId);
      if (record?.status === "active")
        throw new ClusterRuleError("The tenant already has its own login");
    } else if (record === null) {
      throw new ClusterRuleError("The tenant has no login of its own");
    }
    return tenant;
  }
}

/**
 * Carries a login change out so the tenant never loses its database: the new way in exists and
 * every process uses it before the old way closes. A worker lost half-way is retried, and each
 * step can be repeated. A password change is seen by every process within seconds; a pool opened
 * in those seconds with the old password fails and is opened again.
 */
export class ApplyTenantDatabaseLogin implements IJobHandler<"tenant.database_credentials"> {
  readonly job = "tenant.database_credentials" as const;

  constructor(
    private readonly deps: Readonly<{
      credentials: ITenantDatabaseCredentials;
      roles: ITenantDatabaseRoles;
      registry: IClusterRegistry;
      secrets: ISecretBox;
      logins: ITenantLoginCache;
      audit: IPlatformAuditTrail;
      alerts: IAlerts;
      clock: IClock;
      logger: ILogger;
      /** How long until every process sees a change of the tenant (its caches' lifetime). */
      settleMs: number;
      wait: (ms: number) => Promise<void>;
    }>,
  ) {}

  async handle(
    { tenantId, action }: JobPayloads["tenant.database_credentials"],
    context?: Readonly<{ attempt?: number }>,
  ): Promise<void> {
    const { deps } = this;
    const placement = await deps.registry.placement(tenantId);
    if (placement === null) throw new Error(`Tenant ${tenantId} not found`);
    try {
      if (placement.moving) throw new Error("The tenant is being moved");
      if (action === "enable") await this.enable(tenantId, placement.clusterId);
      else if (action === "rotate") await this.rotate(tenantId, placement.clusterId);
      else await this.disable(tenantId, placement.clusterId);
    } catch (error) {
      await deps.alerts.raise({
        key: `tenant.database_login:${tenantId}`,
        severity: "critical",
        source: "clusters",
        title: `A database login change failed (${action})`,
        detail: {
          tenantId,
          action,
          attempt: context?.attempt ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
        runbook: "The job is retried; look at the worker's log if this stays open",
      });
      throw error;
    }
    await deps.audit.record({
      actorType: "system",
      action: `tenant.database_login_${action}d`,
      entityType: "tenant",
      entityId: tenantId,
      targetTenantId: tenantId,
    });
    deps.logger.info("Tenant database login changed", { tenantId, action });
  }

  private async enable(tenantId: string, clusterId: string): Promise<void> {
    const { deps } = this;
    const existing = await deps.credentials.find(tenantId);
    const password = existing === null ? newPassword() : deps.secrets.open(existing.sealedPassword);
    if (existing === null) await this.store(tenantId, password, "enabling");
    await deps.roles.ensure(tenantId, clusterId, password);
    await deps.credentials.setStatus(tenantId, "active");
    deps.logins.forget(tenantId);
    await deps.wait(deps.settleMs);
    await deps.roles.closeShared(tenantId, clusterId);
  }

  private async rotate(tenantId: string, clusterId: string): Promise<void> {
    const { deps } = this;
    const password = newPassword();
    await deps.roles.ensure(tenantId, clusterId, password);
    await this.store(tenantId, password, "active");
    deps.logins.forget(tenantId);
  }

  private async disable(tenantId: string, clusterId: string): Promise<void> {
    const { deps } = this;
    if ((await deps.credentials.find(tenantId)) === null) return;
    await deps.credentials.setStatus(tenantId, "disabling");
    await deps.roles.openShared(tenantId, clusterId);
    await deps.credentials.remove(tenantId);
    deps.logins.forget(tenantId);
    await deps.wait(deps.settleMs);
    await deps.roles.drop(tenantId, clusterId);
  }

  private store(tenantId: string, password: string, status: "enabling" | "active") {
    const { deps } = this;
    return deps.credentials.save(
      {
        tenantId,
        roleName: deps.roles.roleNameOf(tenantId),
        sealedPassword: deps.secrets.seal(password),
        status,
      },
      deps.clock.now(),
    );
  }
}

/** What a tenant's own login needs when its database moves or goes (decision 532). */
export class TenantLoginPlacement {
  constructor(
    private readonly deps: Readonly<{
      credentials: ITenantDatabaseCredentials;
      roles: ITenantDatabaseRoles;
      secrets: ISecretBox;
      logins: ITenantLoginCache;
    }>,
  ) {}

  /** The login exists on a cluster before the tenant's database opens there. */
  async prepareOn(tenantId: string, clusterId: string): Promise<void> {
    const record = await this.deps.credentials.find(tenantId);
    if (record === null) return;
    await this.deps.roles.ensure(
      tenantId,
      clusterId,
      this.deps.secrets.open(record.sealedPassword),
    );
  }

  /** The cluster the tenant left keeps no way in. */
  removeFrom(tenantId: string, clusterId: string): Promise<void> {
    return this.deps.roles.drop(tenantId, clusterId);
  }

  /** The database is gone (cold archive): a restored tenant starts on the shared login. */
  async retire(tenantId: string, clusterId: string): Promise<void> {
    await this.deps.credentials.remove(tenantId);
    this.deps.logins.forget(tenantId);
    await this.deps.roles.drop(tenantId, clusterId);
  }
}
