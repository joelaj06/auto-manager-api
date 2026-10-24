import {
  SupportSession,
  type SupportMode,
  type SupportSessionProps,
  type SupportStatus,
} from "../../../domain/console/SupportSession.js";
import type {
  ISupportSessionRepository,
  SupportRequestRecord,
  SupportSessionRow,
} from "../../../domain/repositories/ISupportSessionRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { SupportActor } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { StepUpRequiredError } from "../../errors/StaffErrors.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IAccessTokenService } from "../../ports/IAccessTokenService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ISupportAccess } from "../../ports/ISupportAccess.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { ITenantSeeder } from "../../ports/ITenantSeeder.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { ApprovalExecutor, ApprovalWorkflow } from "../platform/ApprovalWorkflow.js";
import { recordStaffAction } from "./consoleAudit.js";
import type { IAlerts } from "./PlatformAlerts.js";

export const SUPPORT_WRITE_ACTION = "support.write_access";

export class SupportSessionNotFoundError extends ApplicationError {
  readonly code = "SUPPORT_SESSION_NOT_FOUND";
  constructor() {
    super("Support session not found");
  }
}

/** The tenant cannot be entered (no owner to act as, or not usable). */
export class SupportUnavailableError extends ApplicationError {
  readonly code = "SUPPORT_UNAVAILABLE";
  constructor(message: string) {
    super(message);
  }
}

export type SupportToken = Readonly<{
  accessToken: string;
  /** The token's own expiry (refresh with a new token while the session lasts). */
  expiresAt: Date;
  sessionExpiresAt: Date;
  tenant: Readonly<{ id: string; slug: string }>;
  mode: SupportMode;
}>;

/** What the tenant's owner sees of support access (its "Support access log"). */
export type TenantSupportLogEntry = Readonly<{
  id: string;
  staffName: string;
  mode: SupportMode;
  reason: string;
  ticket: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  expiresAt: Date | null;
  requestCount: number;
}>;

const HOUR_MS = 3_600_000;
/** Opening more tenants than this within an hour is unusual (docs/27 §3.8). */
const BURST_LIMIT = 5;
/** Normal hours in Africa/Accra (UTC+0). */
const WORKDAY = { from: 7, to: 20 } as const;

/**
 * Support access to a tenant (docs/27 §3.8, decision 34): any console user with the support
 * permission opens a tenant in support mode — no tenant consent — after giving a reason (and an
 * optional ticket). Read-only by default; write mode needs the write permission, a recent
 * step-up and a second staff member's approval (four-eyes). The staff member acts with the
 * owner's permissions through a short-lived token bound to the session; sessions are
 * time-boxed, extendable to two hours, end when staff end them or sign out of the console.
 * Every request is logged against the session; tenant audit entries name the staff member.
 * Unusual patterns (many tenants in an hour, outside normal hours, write mode) raise alerts.
 */
export class SupportAccess implements ISupportAccess {
  constructor(
    private readonly deps: Readonly<{
      sessions: ISupportSessionRepository;
      approvals: ApprovalWorkflow;
      directory: ITenantDirectory;
      tenantContext: ITenantContext;
      tenantUnitOfWork: IUnitOfWork;
      seeder: ITenantSeeder;
      permissions: IPermissionResolver;
      accessTokens: IAccessTokenService;
      alerts: IAlerts;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
      stepUpMs: number;
    }>,
  ) {}

  /** Write mode runs once a second staff member approves it. */
  executor(): ApprovalExecutor {
    return {
      action: SUPPORT_WRITE_ACTION,
      approverSystemRole: null,
      execute: async (payload, context) => {
        const session = await this.deps.sessions.find(String(payload.sessionId), true);
        if (session === null) throw new SupportSessionNotFoundError();
        session.approve(context.approvedBy);
        await this.deps.sessions.save(session);
        return { sessionId: session.id };
      },
    };
  }

  async open(
    tenantId: string,
    input: Readonly<{
      mode: SupportMode;
      reason: string;
      ticket?: string | null;
      durationMinutes?: number;
    }>,
    actor: PlatformPrincipal,
  ): Promise<SupportSessionProps> {
    const { deps } = this;
    const now = deps.clock.now();
    if (input.mode === "write") {
      if (!actor.has("platform.support.access_tenant_write"))
        throw new PermissionDeniedError("platform.support.access_tenant_write");
      if (!actor.hasRecentStepUp(now, deps.stepUpMs)) throw new StepUpRequiredError();
    }
    const tenant = await deps.directory.findById(tenantId);
    if (tenant === null) throw new TenantNotFoundForStaffError();
    const session = SupportSession.request({
      id: deps.ids.next(),
      staffId: actor.userId,
      staffSessionId: actor.sessionId,
      tenantId,
      mode: input.mode,
      reason: input.reason,
      ticket: input.ticket ?? null,
      ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }),
      now,
    });
    await deps.unitOfWork.run(async () => {
      await deps.sessions.save(session);
      if (input.mode === "write") {
        const approvalId = await deps.approvals.request({
          action: SUPPORT_WRITE_ACTION,
          payload: { sessionId: session.id },
          summary: `Write-mode support access to ${tenant.slug} for ${session.snapshot().durationMinutes} minutes`,
          reason: session.snapshot().reason,
          ticket: session.snapshot().ticket,
          targetTenantId: tenantId,
          requestedBy: actor.userId,
        });
        session.awaitApproval(approvalId);
        await deps.sessions.save(session);
      }
      await recordStaffAction(deps, actor, {
        action: "support.session_opened",
        entityType: "support_session",
        entityId: session.id,
        targetTenantId: tenantId,
        reason: session.snapshot().reason,
        after: { mode: input.mode, ticket: session.snapshot().ticket },
      });
    });
    await this.watch(actor, tenant.slug, session, now);
    return session.snapshot();
  }

  /** A token for the session (the clock starts with the first one). */
  async token(id: string, actor: PlatformPrincipal): Promise<SupportToken> {
    const { deps } = this;
    const now = deps.clock.now();
    const session = await deps.unitOfWork.run(async () => {
      const s = await this.own(id, actor);
      s.start(now);
      await deps.sessions.save(s);
      return s;
    });
    const s = session.snapshot();
    const tenant = await deps.directory.findById(s.tenantId);
    if (tenant === null) throw new TenantNotFoundForStaffError();
    const owner = await deps.tenantContext.runAs(TenantId.from(s.tenantId), () =>
      deps.tenantUnitOfWork.run(() => deps.seeder.owner()),
    );
    if (owner === null || owner.status !== "active")
      throw new SupportUnavailableError("The tenant has no active owner to act as");
    const version = await deps.permissions.currentVersion(s.tenantId, owner.id);
    if (version === null) throw new SupportUnavailableError("The tenant owner cannot be used");
    const issued = await deps.accessTokens.issue({
      audience: "tenant",
      tenantId: s.tenantId,
      userId: owner.id,
      sessionId: s.id,
      permissionVersion: version,
      support: true,
    });
    return {
      accessToken: issued.token,
      expiresAt: issued.expiresAt < s.expiresAt! ? issued.expiresAt : s.expiresAt!,
      sessionExpiresAt: s.expiresAt!,
      tenant: { id: tenant.id, slug: tenant.slug },
      mode: s.mode,
    };
  }

  async extend(
    id: string,
    minutes: number,
    actor: PlatformPrincipal,
  ): Promise<SupportSessionProps> {
    return this.change(id, actor, "support.session_extended", (s, now) => s.extend(minutes, now));
  }

  async end(id: string, actor: PlatformPrincipal): Promise<SupportSessionProps> {
    return this.change(id, actor, "support.session_ended", (s, now) => s.end("ended", now));
  }

  list(
    filter: Readonly<{
      staffId?: string;
      tenantId?: string;
      status?: SupportStatus;
      limit: number;
    }>,
  ): Promise<SupportSessionRow[]> {
    return this.deps.sessions.list(filter);
  }

  async get(
    id: string,
  ): Promise<SupportSessionProps & Readonly<{ requests: SupportRequestRecord[] }>> {
    const session = await this.deps.sessions.find(id);
    if (session === null) throw new SupportSessionNotFoundError();
    return { ...session.snapshot(), requests: await this.deps.sessions.requests(id, 1_000) };
  }

  // --- the tenant's own view (docs/27 §3.8: optional, on by default) ---

  async tenantLog(
    tenantId: string,
  ): Promise<Readonly<{ visible: boolean; sessions: TenantSupportLogEntry[] }>> {
    const visible = await this.deps.sessions.logVisible(tenantId);
    if (!visible) return { visible, sessions: [] };
    const rows = await this.deps.sessions.list({ tenantId, limit: 100 });
    return {
      visible,
      sessions: rows
        .filter((r) => r.startedAt !== null)
        .map((r) => ({
          id: r.id,
          staffName: r.staffName,
          mode: r.mode,
          reason: r.reason,
          ticket: r.ticket,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          expiresAt: r.expiresAt,
          requestCount: r.requestCount,
        })),
    };
  }

  setTenantLogVisible(tenantId: string, visible: boolean): Promise<void> {
    return this.deps.sessions.setLogVisible(tenantId, visible);
  }

  // --- ISupportAccess (the tenant API) ---

  async live(sessionId: string, tenantId: string): Promise<SupportActor | null> {
    const live = await this.deps.sessions.live(sessionId, this.deps.clock.now());
    if (live === null || live.tenantId !== tenantId) return null;
    return {
      sessionId: live.id,
      staffId: live.staffId,
      staffName: live.staffName,
      mode: live.mode,
    };
  }

  async record(
    sessionId: string,
    request: Readonly<{
      method: string;
      path: string;
      statusCode: number;
      requestId: string | null;
    }>,
  ): Promise<void> {
    try {
      await this.deps.sessions.recordRequest(sessionId, { ...request, at: this.deps.clock.now() });
    } catch (error) {
      this.deps.logger.error("Could not log a support-access request", { sessionId, error });
    }
  }

  // --- helpers ---

  private async own(id: string, actor: PlatformPrincipal): Promise<SupportSession> {
    const session = await this.deps.sessions.find(id, true);
    // Only the staff member who opened it uses a session.
    if (session === null || session.snapshot().staffId !== actor.userId)
      throw new SupportSessionNotFoundError();
    return session;
  }

  private async change(
    id: string,
    actor: PlatformPrincipal,
    action: string,
    apply: (s: SupportSession, now: Date) => void,
  ): Promise<SupportSessionProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const s = await this.own(id, actor);
      apply(s, deps.clock.now());
      await deps.sessions.save(s);
      await recordStaffAction(deps, actor, {
        action,
        entityType: "support_session",
        entityId: id,
        targetTenantId: s.snapshot().tenantId,
        after: { status: s.snapshot().status, expiresAt: s.snapshot().expiresAt },
      });
      return s.snapshot();
    });
  }

  /** Unusual support access reaches the alerts centre. */
  private async watch(
    actor: PlatformPrincipal,
    slug: string,
    session: SupportSession,
    now: Date,
  ): Promise<void> {
    const { deps } = this;
    const s = session.snapshot();
    const opened = await deps.sessions.openedBy(actor.userId, new Date(now.getTime() - HOUR_MS));
    if (opened > BURST_LIMIT)
      await deps.alerts.raise({
        key: `support.burst:${actor.userId}:${now.toISOString().slice(0, 13)}`,
        severity: "warning",
        source: "support",
        title: `${actor.name} opened ${opened} tenants in support mode within an hour`,
        detail: { staffId: actor.userId, opened },
      });
    const hour = now.getUTCHours();
    if (hour < WORKDAY.from || hour >= WORKDAY.to)
      await deps.alerts.raise({
        key: `support.off_hours:${s.id}`,
        severity: "info",
        source: "support",
        title: `${actor.name} opened ${slug} in support mode outside normal hours`,
        detail: { staffId: actor.userId, sessionId: s.id },
        tenantId: s.tenantId,
      });
    if (s.mode === "write")
      await deps.alerts.raise({
        key: `support.write:${s.id}`,
        severity: "info",
        source: "support",
        title: `${actor.name} asked for write-mode support access to ${slug}`,
        detail: { staffId: actor.userId, sessionId: s.id },
        tenantId: s.tenantId,
      });
  }
}
