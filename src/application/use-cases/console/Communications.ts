import type {
  Announcement,
  AnnouncementAudience,
  AnnouncementStatus,
  ICommunicationsRepository,
  MaintenanceWindow,
} from "../../../domain/repositories/ICommunicationsRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IMaintenanceState } from "../../ports/IOperationsGates.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantSeeder } from "../../ports/ITenantSeeder.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { ApprovalExecutor, ApprovalWorkflow } from "../platform/ApprovalWorkflow.js";
import { recordStaffAction } from "./consoleAudit.js";

export const PUBLISH_BULK_ACTION = "announcements.publish";

export class CommunicationNotFoundError extends ApplicationError {
  readonly code = "COMMUNICATION_NOT_FOUND";
  constructor() {
    super("Announcement or maintenance window not found");
  }
}

export class CommunicationRuleError extends ApplicationError {
  readonly code = "COMMUNICATION_RULE";
  constructor(message: string) {
    super(message);
  }
}

export type AnnouncementInput = Readonly<{
  title: string;
  body: string;
  severity: Announcement["severity"];
  audience: AnnouncementAudience;
  email: boolean;
  startsAt: Date;
  endsAt: Date;
}>;

/** What a tenant's apps show: live announcements and maintenance coming up (the countdown). */
export type TenantNotices = Readonly<{
  announcements: readonly (Announcement & Readonly<{ read: boolean }>)[];
  maintenance: readonly MaintenanceWindow[];
}>;

const DAY_MS = 86_400_000;
/** Maintenance shows in the apps from a week before. */
const COUNTDOWN_MS = 7 * DAY_MS;

/**
 * Communications (docs/27 §3.12): announcements to all tenants or a segment (status, licence
 * type, chosen tenants) as banners in the apps — read per user — and optionally by email to the
 * owners; emailing more tenants than the threshold needs a Super Admin's approval (four-eyes,
 * bulk messages). Maintenance windows show a countdown and can make every tenant read-only
 * while they are on (sign-in and paying still work).
 */
export class Communications {
  constructor(
    private readonly deps: Readonly<{
      store: ICommunicationsRepository;
      approvals: ApprovalWorkflow;
      queue: IJobQueue;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      bulkApprovalTenants: number;
      /** This process's read-only cache, forgotten after a change. */
      maintenance?: Readonly<{ forget(): void }>;
    }>,
  ) {}

  /** A bulk announcement goes out once a Super Admin approves it. */
  executor(): ApprovalExecutor {
    return {
      action: PUBLISH_BULK_ACTION,
      approverSystemRole: "super_admin",
      execute: async (payload) => {
        const id = String(payload.announcementId);
        const a = await this.deps.store.announcement(id, true);
        if (a === null) throw new CommunicationNotFoundError();
        await this.goLive(a);
        return { announcementId: id };
      },
    };
  }

  async create(input: AnnouncementInput, actor: PlatformPrincipal): Promise<Announcement> {
    const { deps } = this;
    const now = deps.clock.now();
    validate(input.title, input.body, input.startsAt, input.endsAt);
    const announcement: Announcement = {
      id: deps.ids.next(),
      title: input.title.trim(),
      body: input.body.trim(),
      severity: input.severity,
      audience: compact(input.audience),
      email: input.email,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: "draft",
      approvalId: null,
      emailedAt: null,
      createdBy: actor.userId,
      createdAt: now,
      publishedAt: null,
    };
    await deps.unitOfWork.run(async () => {
      await deps.store.saveAnnouncement(announcement);
      await recordStaffAction(deps, actor, {
        action: "announcement.created",
        entityType: "announcement",
        entityId: announcement.id,
        after: { title: announcement.title, audience: announcement.audience, email: input.email },
      });
    });
    return announcement;
  }

  /** Publishes now — or, emailing many tenants, asks a Super Admin first. */
  async publish(
    id: string,
    actor: PlatformPrincipal,
  ): Promise<Announcement & Readonly<{ tenants: number }>> {
    const { deps } = this;
    const result = await deps.unitOfWork.run(async () => {
      const a = await this.find(id, true);
      if (a.status !== "draft")
        throw new CommunicationRuleError(`This announcement is ${a.status.replace("_", " ")}`);
      const tenants = (await deps.store.audienceTenants(a.audience)).length;
      let saved: Announcement;
      if (a.email && tenants > deps.bulkApprovalTenants) {
        const approvalId = await deps.approvals.request({
          action: PUBLISH_BULK_ACTION,
          payload: { announcementId: a.id },
          summary: `Email "${a.title}" to the owners of ${tenants} tenants`,
          reason: `Announcement to ${tenants} tenants`,
          requestedBy: actor.userId,
        });
        saved = { ...a, status: "awaiting_approval", approvalId };
        await deps.store.saveAnnouncement(saved);
      } else {
        saved = await this.goLive(a);
      }
      await recordStaffAction(deps, actor, {
        action: "announcement.published",
        entityType: "announcement",
        entityId: a.id,
        after: { status: saved.status, tenants },
      });
      return { ...saved, tenants };
    });
    return result;
  }

  async withdraw(id: string, actor: PlatformPrincipal): Promise<Announcement> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const a = await this.find(id, true);
      const withdrawn: Announcement = { ...a, status: "withdrawn" };
      await deps.store.saveAnnouncement(withdrawn);
      await recordStaffAction(deps, actor, {
        action: "announcement.withdrawn",
        entityType: "announcement",
        entityId: id,
        before: { status: a.status },
      });
      return withdrawn;
    });
  }

  list(filter: Readonly<{ status?: AnnouncementStatus; limit: number }>): Promise<Announcement[]> {
    return this.deps.store.announcements(filter);
  }

  async get(id: string) {
    const a = await this.find(id);
    return {
      ...a,
      tenants: (await this.deps.store.audienceTenants(a.audience)).length,
      reads: await this.deps.store.readStats(id),
    };
  }

  // --- maintenance ---

  async schedule(
    input: Readonly<{
      title: string;
      message: string;
      startsAt: Date;
      endsAt: Date;
      readOnly: boolean;
    }>,
    actor: PlatformPrincipal,
  ): Promise<MaintenanceWindow> {
    const { deps } = this;
    validate(input.title, input.message, input.startsAt, input.endsAt);
    const window: MaintenanceWindow = {
      id: deps.ids.next(),
      title: input.title.trim(),
      message: input.message.trim(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      readOnly: input.readOnly,
      status: "scheduled",
      createdBy: actor.userId,
      createdAt: deps.clock.now(),
      cancelledAt: null,
    };
    await deps.unitOfWork.run(async () => {
      await deps.store.saveWindow(window);
      await recordStaffAction(deps, actor, {
        action: "maintenance.scheduled",
        entityType: "maintenance_window",
        entityId: window.id,
        after: { startsAt: window.startsAt, endsAt: window.endsAt, readOnly: window.readOnly },
      });
    });
    deps.maintenance?.forget();
    return window;
  }

  async cancel(id: string, actor: PlatformPrincipal): Promise<MaintenanceWindow> {
    const { deps } = this;
    return deps.unitOfWork
      .run(async () => {
        const w = await deps.store.window(id, true);
        if (w === null) throw new CommunicationNotFoundError();
        const cancelled: MaintenanceWindow = {
          ...w,
          status: "cancelled",
          cancelledAt: deps.clock.now(),
        };
        await deps.store.saveWindow(cancelled);
        await recordStaffAction(deps, actor, {
          action: "maintenance.cancelled",
          entityType: "maintenance_window",
          entityId: id,
        });
        return cancelled;
      })
      .finally(() => deps.maintenance?.forget());
  }

  windows(limit: number): Promise<MaintenanceWindow[]> {
    return this.deps.store.windows({ limit });
  }

  // --- the tenant's apps ---

  async forTenant(tenantId: string, userId: string): Promise<TenantNotices> {
    const now = this.deps.clock.now();
    return {
      announcements: await this.deps.store.liveFor(tenantId, userId, now),
      maintenance: await this.deps.store.upcoming(now, new Date(now.getTime() + COUNTDOWN_MS)),
    };
  }

  async markRead(id: string, tenantId: string, userId: string): Promise<void> {
    await this.find(id);
    await this.deps.store.markRead(id, tenantId, userId);
  }

  // --- helpers ---

  private async goLive(a: Announcement): Promise<Announcement> {
    const published: Announcement = {
      ...a,
      status: "published",
      publishedAt: this.deps.clock.now(),
    };
    await this.deps.store.saveAnnouncement(published);
    if (a.email) await this.deps.queue.enqueue("announcements.email", { announcementId: a.id });
    return published;
  }

  private async find(id: string, lock = false): Promise<Announcement> {
    const a = await this.deps.store.announcement(id, lock);
    if (a === null) throw new CommunicationNotFoundError();
    return a;
  }
}

/**
 * Whether every tenant is read-only for maintenance right now. Cached for a few seconds: every
 * tenant write asks.
 */
export class MaintenanceState implements IMaintenanceState {
  private cached: Readonly<{
    at: number;
    value: Readonly<{ title: string; endsAt: Date }> | null;
  }> | null = null;

  constructor(
    private readonly deps: Readonly<{
      store: ICommunicationsRepository;
      clock: IClock;
      ttlMs?: number;
    }>,
  ) {}

  async readOnlyNow(): Promise<Readonly<{ title: string; endsAt: Date }> | null> {
    const now = this.deps.clock.now();
    if (this.cached !== null && now.getTime() - this.cached.at < (this.deps.ttlMs ?? 5_000))
      return this.cached.value !== null && this.cached.value.endsAt > now
        ? this.cached.value
        : null;
    let windows: MaintenanceWindow[];
    try {
      windows = await this.deps.store.upcoming(now, new Date(now.getTime() + 1));
    } catch {
      // Fails open: maintenance that cannot be read never blocks the API.
      return null;
    }
    const on = windows.find((w) => w.readOnly && w.startsAt <= now);
    const value = on === undefined ? null : { title: on.title, endsAt: on.endsAt };
    this.cached = { at: now.getTime(), value };
    return value;
  }

  /** After scheduling or cancelling in this process. */
  forget(): void {
    this.cached = null;
  }
}

/** Emails a published announcement to the owner of every tenant in its audience, once each. */
export class AnnouncementMailer implements IJobHandler<"announcements.email"> {
  readonly job = "announcements.email" as const;

  constructor(
    private readonly deps: Readonly<{
      store: ICommunicationsRepository;
      tenantContext: ITenantContext;
      tenantUnitOfWork: IUnitOfWork;
      seeder: ITenantSeeder;
      email: NotificationService;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle({ announcementId }: Readonly<{ announcementId: string }>): Promise<void> {
    const { deps } = this;
    const a = await deps.store.announcement(announcementId);
    if (a === null || a.status !== "published" || a.emailedAt !== null) return;
    for (const tenantId of await deps.store.audienceTenants(a.audience)) {
      try {
        const owner = await deps.tenantContext.runAs(TenantId.from(tenantId), () =>
          deps.tenantUnitOfWork.run(() => deps.seeder.owner()),
        );
        if (owner === null || owner.email === null) continue;
        await deps.email.sendEmail({
          to: owner.email,
          template: "platform.announcement",
          data: { name: owner.name, title: a.title, body: a.body },
          idempotencyKey: `announcement:${a.id}:${tenantId}`,
          tenantId,
        });
      } catch (error) {
        deps.logger.warn("Could not email an announcement to a tenant", { tenantId, error });
      }
    }
    await deps.store.markEmailed(a.id, deps.clock.now());
  }
}

function validate(title: string, body: string, startsAt: Date, endsAt: Date): void {
  if (title.trim().length < 3) throw new CommunicationRuleError("A title of 3 characters or more");
  if (body.trim().length < 3) throw new CommunicationRuleError("Write the message");
  if (endsAt <= startsAt) throw new CommunicationRuleError("It must end after it starts");
}

/** Only the parts of an audience that narrow it. */
function compact(a: AnnouncementAudience): AnnouncementAudience {
  return {
    ...(a.statuses !== undefined && a.statuses.length > 0 ? { statuses: a.statuses } : {}),
    ...(a.licenceTypes !== undefined && a.licenceTypes.length > 0
      ? { licenceTypes: a.licenceTypes }
      : {}),
    ...(a.tenantIds !== undefined && a.tenantIds.length > 0 ? { tenantIds: a.tenantIds } : {}),
  };
}
