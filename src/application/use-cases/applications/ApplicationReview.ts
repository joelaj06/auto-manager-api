import type {
  ApplicationStatus,
  ApprovalOptions,
  TenantApplication,
  TenantApplicationProps,
} from "../../../domain/entities/TenantApplication.js";
import type { IStaffAccountRepository } from "../../../domain/repositories/IStaffAccountRepository.js";
import type { ITenantApplicationRepository } from "../../../domain/repositories/ITenantApplicationRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationNotFoundError, SlugTakenError } from "../../errors/ApplicationErrors.js";
import { StaffNotFoundError } from "../../errors/StaffErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { ApplicationEvent, IApplicationEvents } from "../../ports/IApplicationEvents.js";
import type { IApplicationLookups, SimilarApplication } from "../../ports/IApplicationLookups.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ITenantProvisioning } from "../../ports/ITenantProvisioning.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { applicationUrl, newAccessToken } from "./applicantLinks.js";

export type ApplicationSummary = Readonly<{
  id: string;
  status: ApplicationStatus;
  source: TenantApplicationProps["source"];
  businessName: string;
  businessType: string;
  desiredSlug: string;
  contactEmail: string;
  riskLevel: TenantApplicationProps["riskLevel"];
  submittedAt: Date | null;
  createdAt: Date;
  assignedTo: string | null;
}>;

export type ApplicationDetailView = Omit<TenantApplicationProps, "accessTokenHash" | "details"> &
  TenantApplicationProps["details"] &
  Readonly<{ events: readonly ApplicationEvent[]; similar: readonly SimilarApplication[] }>;

export type ReviewSettings = Readonly<{
  webAppUrl: string;
  /** Timezone of new tenants (Ghana market; changeable in organisation settings). */
  defaultTimezone: string;
  defaultTrialDays: number;
  defaultReapplyAfterDays: number;
}>;

const DAY_MS = 86_400_000;

/**
 * The staff review queue (docs/27 §3.2): list and inspect applications (with timeline, risk
 * signals and similar applications), assign a reviewer, ask for more information, approve or
 * reject. Every decision is audited and the applicant is told by email. Approval reserves the
 * tenant (slug, `provisioning` status) in the same transaction and queues the provisioning saga;
 * if queueing fails, the provisioning sweep picks it up.
 */
export class ApplicationReview {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      applications: ITenantApplicationRepository;
      events: IApplicationEvents;
      lookups: IApplicationLookups;
      staff: IStaffAccountRepository;
      notifications: NotificationService;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      provisioning: ITenantProvisioning;
      queue: IJobQueue;
      ids: IIdGenerator;
      clock: IClock;
      settings: ReviewSettings;
    }>,
  ) {}

  async list(query: {
    status?: ApplicationStatus;
    search?: string;
    assignedTo?: string;
    limit: number;
    before?: string;
  }): Promise<ApplicationSummary[]> {
    const applications = await this.deps.applications.list(query);
    return applications.map((application) => {
      const s = application.snapshot();
      return {
        id: s.id,
        status: s.status,
        source: s.source,
        businessName: s.details.businessName,
        businessType: s.details.businessType,
        desiredSlug: s.details.desiredSlug,
        contactEmail: s.details.contactEmail,
        riskLevel: s.riskLevel,
        submittedAt: s.submittedAt,
        createdAt: s.createdAt,
        assignedTo: s.assignedTo,
      };
    });
  }

  async get(id: string): Promise<ApplicationDetailView> {
    const application = await this.deps.applications.findById(id);
    if (application === null) throw new ApplicationNotFoundError();
    const { accessTokenHash: _hidden, details, ...rest } = application.snapshot();
    const [events, similar] = await Promise.all([
      this.deps.events.list(id, true),
      this.deps.lookups.similar({
        excludeId: id,
        email: details.contactEmail,
        phone: details.contactPhone,
        businessName: details.businessName,
      }),
    ]);
    return { ...rest, ...details, events, similar };
  }

  async assign(id: string, assigneeId: string | null, actor: PlatformPrincipal): Promise<void> {
    if (assigneeId !== null) {
      const assignee = await this.deps.staff.findById(assigneeId);
      if (assignee === null || assignee.status !== "active") throw new StaffNotFoundError();
    }
    await this.change(id, actor, "assigned", null, true, (application) => {
      application.assign(assigneeId);
      return { assigneeId };
    });
  }

  async requestInfo(id: string, message: string, actor: PlatformPrincipal): Promise<void> {
    const { deps } = this;
    const link = newAccessToken();
    const application = await this.change(
      id,
      actor,
      "info_requested",
      message.trim(),
      false,
      (app) => {
        app.requestInfo(message);
        return {};
      },
      async (app) => {
        // The email carries a fresh private link; the previous one stops working.
        await deps.applications.rotateAccessToken(app.id, link.hash);
      },
    );
    const { details } = application;
    await deps.notifications.sendEmail({
      to: details.contactEmail,
      template: "application.info_requested",
      data: {
        contactName: details.contactName,
        businessName: details.businessName,
        message: message.trim(),
        applicationUrl: applicationUrl(deps.settings.webAppUrl, application.id, link.token),
      },
      idempotencyKey: `application-info:${application.id}:${link.hash}`,
    });
  }

  async approve(
    id: string,
    actor: PlatformPrincipal,
    params: Readonly<{ trialDays?: number; note?: string | null }>,
  ): Promise<void> {
    const { deps } = this;
    const options: ApprovalOptions = {
      plan: "standard",
      trialDays: params.trialDays ?? deps.settings.defaultTrialDays,
    };
    const tenantId = deps.ids.next();
    const application = await this.change(
      id,
      actor,
      "approved",
      "Your application was approved. We are setting up your account.",
      false,
      (app) => {
        app.approve(actor.userId, options, params.note ?? null, deps.clock.now(), tenantId);
        return { options, note: params.note ?? null, tenantId };
      },
      async (app) => {
        if (await deps.lookups.slugTaken(app.details.desiredSlug, app.id)) {
          throw new SlugTakenError();
        }
        // Reserves the slug and creates the saga record in the same transaction.
        await deps.provisioning.register({
          tenantId,
          slug: app.details.desiredSlug,
          name: app.details.businessName,
          timezone: deps.settings.defaultTimezone,
          applicationId: app.id,
        });
      },
    );
    await deps.queue
      .enqueue("tenant.provision", { tenantId }, { singletonKey: tenantId })
      .catch(() => undefined); // the provisioning sweep re-queues it within minutes
    await deps.notifications.sendEmail({
      to: application.details.contactEmail,
      template: "application.approved",
      data: {
        contactName: application.details.contactName,
        businessName: application.details.businessName,
      },
      idempotencyKey: `application-approved:${application.id}`,
    });
  }

  async reject(
    id: string,
    actor: PlatformPrincipal,
    params: Readonly<{
      reason: string;
      notifyApplicantOfReason: boolean;
      reapplyAfterDays?: number;
    }>,
  ): Promise<void> {
    const { deps } = this;
    const days = params.reapplyAfterDays ?? deps.settings.defaultReapplyAfterDays;
    const now = deps.clock.now();
    const shownReason = params.notifyApplicantOfReason ? params.reason.trim() : null;
    const application = await this.change(
      id,
      actor,
      "rejected",
      shownReason ?? "Your application was not accepted.",
      false,
      (app) => {
        app.reject(
          actor.userId,
          params.reason,
          days > 0 ? new Date(now.getTime() + days * DAY_MS) : null,
          now,
        );
        return {
          reason: params.reason.trim(),
          reapplyAfterDays: days,
          reasonShown: params.notifyApplicantOfReason,
        };
      },
    );
    await deps.notifications.sendEmail({
      to: application.details.contactEmail,
      template: "application.rejected",
      data: {
        contactName: application.details.contactName,
        businessName: application.details.businessName,
        reason: shownReason,
      },
      idempotencyKey: `application-rejected:${application.id}`,
    });
  }

  /** Locks, applies `mutate`, saves, and records the timeline event and the staff audit entry. */
  private async change(
    id: string,
    actor: PlatformPrincipal,
    type: ApplicationEvent["type"],
    message: string | null,
    internal: boolean,
    mutate: (application: TenantApplication) => Record<string, unknown>,
    beforeSave?: (application: TenantApplication) => Promise<void>,
  ): Promise<TenantApplication> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const application = await deps.applications.lockById(id);
      if (application === null) throw new ApplicationNotFoundError();
      const before = application.status;
      const details = mutate(application);
      await beforeSave?.(application);
      await deps.applications.save(application);
      await deps.events.append({
        applicationId: id,
        type,
        actorType: "platform_staff",
        actorId: actor.userId,
        message,
        internal,
        details,
      });
      const request = deps.requestContext.current();
      await deps.audit.record({
        actorType: "platform_staff",
        actorId: actor.userId,
        action: `application.${type}`,
        entityType: "tenant_application",
        entityId: id,
        before: { status: before },
        after: { status: application.status, ...details },
        reason: typeof details.reason === "string" ? details.reason : message,
        requestId: request?.requestId ?? null,
        ip: request?.ip ?? null,
      });
      return application;
    });
  }
}
