import {
  TenantApplication,
  type ApplicationCorrections,
  type ApplicationDetails,
  type ApplicationStatus,
} from "../../../domain/entities/TenantApplication.js";
import type { OtpPurpose } from "../../../domain/enums/OtpPurpose.js";
import type { ITenantApplicationRepository } from "../../../domain/repositories/ITenantApplicationRepository.js";
import { PhoneNumber } from "../../../domain/value-objects/PhoneNumber.js";
import { TenantSlug } from "../../../domain/value-objects/TenantSlug.js";
import {
  AlreadyVerifiedError,
  ApplicationExistsError,
  ApplicationNotFoundError,
  ReapplyLaterError,
  SlugTakenError,
} from "../../errors/ApplicationErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IApplicationEvents } from "../../ports/IApplicationEvents.js";
import type { IApplicationLookups } from "../../ports/IApplicationLookups.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { ISmsSender } from "../../ports/ISmsSender.js";
import type { ApplicationRiskAssessor } from "../../services/ApplicationRiskAssessor.js";
import type { IssueOtpChallenge } from "../auth/IssueOtpChallenge.js";
import type { VerifyOtpChallenge } from "../auth/VerifyOtpChallenge.js";
import { accessTokenMatches, applicationUrl, newAccessToken } from "./applicantLinks.js";

export type SignupInput = Readonly<{
  businessName: string;
  businessType: ApplicationDetails["businessType"];
  country: string;
  desiredSlug: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  tin?: string | null;
  registrationNumber?: string | null;
  expectedBranches: number;
  expectedVehicles: number;
  heardAbout?: string | null;
  referralCode?: string | null;
}>;

export type SignupResult = Readonly<{
  applicationId: string;
  status: ApplicationStatus;
  /** Private link token; returned to self-signup only (assisted signups get it by email). */
  accessToken?: string;
}>;

export type ApplicantView = Readonly<{
  id: string;
  status: ApplicationStatus;
  businessName: string;
  desiredSlug: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  messages: readonly Readonly<{
    type: string;
    from: "us" | "you";
    message: string | null;
    at: Date;
  }>[];
}>;

export type SignupSettings = Readonly<{ webAppUrl: string; otpTtlMinutes: number }>;

type Channel = "email" | "phone";
const PURPOSE: Readonly<Record<Channel, OtpPurpose>> = {
  email: "email_verification",
  phone: "phone_verification",
};
const subjectOf = (applicationId: string, channel: Channel) =>
  `application:${applicationId}:${channel}`;

/**
 * Public signup (docs/27 §3.2): an application is created, its email and phone are verified with
 * one-time codes, and it enters the staff review queue. The applicant follows it through a private
 * link (token stored only as a hash), where they also answer information requests.
 */
export class ApplicationSignup {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      applications: ITenantApplicationRepository;
      events: IApplicationEvents;
      lookups: IApplicationLookups;
      risk: ApplicationRiskAssessor;
      issueOtp: IssueOtpChallenge;
      verifyOtp: VerifyOtpChallenge;
      notifications: NotificationService;
      sms: ISmsSender;
      audit: IPlatformAuditTrail;
      ids: IIdGenerator;
      clock: IClock;
      settings: SignupSettings;
    }>,
  ) {}

  async slugAvailable(slug: string): Promise<boolean> {
    return !(await this.deps.lookups.slugTaken(TenantSlug.parse(slug).value));
  }

  /**
   * Creates an application and sends both verification codes. `staffId` marks an assisted signup:
   * the private link then goes only to the applicant's email.
   */
  async submit(
    input: SignupInput,
    context: Readonly<{ ip: string | null; userAgent: string | null; staffId?: string | null }>,
  ): Promise<SignupResult> {
    const { deps } = this;
    const now = deps.clock.now();
    const details: ApplicationDetails = {
      businessName: input.businessName.trim(),
      businessType: input.businessType,
      country: input.country.toUpperCase(),
      desiredSlug: TenantSlug.parse(input.desiredSlug).value,
      contactName: input.contactName.trim(),
      contactEmail: input.contactEmail.trim().toLowerCase(),
      contactPhone: PhoneNumber.parse(input.contactPhone, input.country.toUpperCase()).value,
      tin: input.tin?.trim() || null,
      registrationNumber: input.registrationNumber?.trim() || null,
      expectedBranches: input.expectedBranches,
      expectedVehicles: input.expectedVehicles,
      heardAbout: input.heardAbout?.trim() || null,
      referralCode: input.referralCode?.trim() || null,
    };

    const staffId = context.staffId ?? null;
    const link = newAccessToken();
    const application = await deps.unitOfWork.run(async () => {
      if (await deps.lookups.slugTaken(details.desiredSlug)) throw new SlugTakenError();
      if (await deps.lookups.openApplicationExists(details.contactEmail, details.contactPhone)) {
        throw new ApplicationExistsError();
      }
      if (
        (await deps.lookups.reapplyBlockedUntil(
          details.contactEmail,
          details.contactPhone,
          now,
        )) !== null
      ) {
        throw new ReapplyLaterError();
      }
      const risk = await deps.risk.assess({
        email: details.contactEmail,
        phone: details.contactPhone,
        businessName: details.businessName,
        ip: context.ip,
        now,
      });
      const created = TenantApplication.submit({
        id: deps.ids.next(),
        details,
        source: staffId === null ? "self" : "assisted",
        createdByStaffId: staffId,
        accessTokenHash: link.hash,
        risk,
        ip: context.ip,
        userAgent: context.userAgent,
        now,
      });
      await deps.applications.save(created);
      await deps.events.append({
        applicationId: created.id,
        type: "submitted",
        actorType: staffId === null ? "applicant" : "platform_staff",
        actorId: staffId,
        message: null,
        internal: true,
        details: { source: created.snapshot().source, riskLevel: risk.level },
      });
      if (staffId !== null) {
        await deps.audit.record({
          actorType: "platform_staff",
          actorId: staffId,
          action: "application.created_assisted",
          entityType: "tenant_application",
          entityId: created.id,
          after: { businessName: details.businessName, slug: details.desiredSlug },
          ip: context.ip,
        });
      }
      return created;
    });

    await this.sendCode(application, "email", link.token);
    await this.sendCode(application, "phone", link.token);
    return {
      applicationId: application.id,
      status: application.status,
      ...(staffId === null ? { accessToken: link.token } : {}),
    };
  }

  async resendCode(applicationId: string, token: string, channel: Channel): Promise<void> {
    const application = await this.authorise(applicationId, token);
    if (application.isVerified(channel)) throw new AlreadyVerifiedError(channel);
    await this.sendCode(application, channel, token);
  }

  /** Checks a code; when both channels are verified the application enters review. */
  async verify(
    applicationId: string,
    token: string,
    channel: Channel,
    code: string,
  ): Promise<ApplicantView> {
    const { deps } = this;
    const application = await this.authorise(applicationId, token);
    if (application.isVerified(channel)) throw new AlreadyVerifiedError(channel);
    // Commits the attempt (and throws) on a wrong code.
    await deps.verifyOtp.execute({
      subject: subjectOf(application.id, channel),
      purpose: PURPOSE[channel],
      code,
    });

    const enteredReview = await deps.unitOfWork.run(async () => {
      const locked = await deps.applications.lockById(application.id);
      if (locked === null) throw new ApplicationNotFoundError();
      const entered = locked.markVerified(channel, deps.clock.now());
      await deps.applications.save(locked);
      await deps.events.append({
        applicationId: locked.id,
        type: "verified",
        actorType: "applicant",
        actorId: null,
        message: null,
        internal: true,
        details: { channel, enteredReview: entered },
      });
      return entered;
    });

    if (enteredReview) {
      const { details } = application;
      await deps.notifications.sendEmail({
        to: details.contactEmail,
        template: "application.received",
        data: {
          contactName: details.contactName,
          businessName: details.businessName,
          applicationUrl: applicationUrl(deps.settings.webAppUrl, application.id, token),
        },
        idempotencyKey: `application-received:${application.id}`,
      });
    }
    return this.view(applicationId, token);
  }

  /** The applicant's view: status and the messages exchanged with our team. */
  async view(applicationId: string, token: string): Promise<ApplicantView> {
    const application = await this.authorise(applicationId, token);
    const events = await this.deps.events.list(application.id, false);
    return {
      id: application.id,
      status: application.status,
      businessName: application.details.businessName,
      desiredSlug: application.details.desiredSlug,
      emailVerified: application.isVerified("email"),
      phoneVerified: application.isVerified("phone"),
      messages: events.map((e) => ({
        type: e.type,
        from: e.actorType === "applicant" ? "you" : "us",
        message: e.message,
        at: e.createdAt,
      })),
    };
  }

  /** Answers an information request (and optionally corrects some details). */
  async reply(
    applicationId: string,
    token: string,
    message: string,
    corrections: ApplicationCorrections,
  ): Promise<ApplicantView> {
    const { deps } = this;
    const application = await this.authorise(applicationId, token);
    await deps.unitOfWork.run(async () => {
      const locked = await deps.applications.lockById(application.id);
      if (locked === null) throw new ApplicationNotFoundError();
      locked.reply(message, corrections);
      await deps.applications.save(locked);
      await deps.events.append({
        applicationId: locked.id,
        type: "applicant_replied",
        actorType: "applicant",
        actorId: null,
        message: message.trim(),
        internal: false,
        details: { corrections },
      });
    });
    return this.view(applicationId, token);
  }

  private async authorise(applicationId: string, token: string): Promise<TenantApplication> {
    const application = await this.deps.applications.findById(applicationId);
    if (application === null || !accessTokenMatches(token, application.accessTokenHash)) {
      throw new ApplicationNotFoundError();
    }
    return application;
  }

  private async sendCode(
    application: TenantApplication,
    channel: Channel,
    token: string,
  ): Promise<void> {
    const { deps } = this;
    const issued = await deps.issueOtp.execute({
      subject: subjectOf(application.id, channel),
      purpose: PURPOSE[channel],
    });
    const { details } = application;
    if (channel === "email") {
      await deps.notifications.sendEmail({
        to: details.contactEmail,
        template: "application.verify_email",
        data: {
          contactName: details.contactName,
          businessName: details.businessName,
          code: issued.code,
          expiresInMinutes: deps.settings.otpTtlMinutes,
          applicationUrl: applicationUrl(deps.settings.webAppUrl, application.id, token),
        },
        idempotencyKey: `application-email-code:${issued.challengeId}`,
      });
    } else {
      await deps.sms.send(
        details.contactPhone,
        `${issued.code} is your Autoforce Manager verification code. It expires in ${deps.settings.otpTtlMinutes} minutes.`,
      );
    }
  }
}
