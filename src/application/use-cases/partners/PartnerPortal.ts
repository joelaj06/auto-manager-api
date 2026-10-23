import type { CommissionTerms } from "../../../domain/partners/Commissions.js";
import type {
  ApplicationCorrections,
  ApplicationStatus,
} from "../../../domain/entities/TenantApplication.js";
import type { IPartnerRepository } from "../../../domain/repositories/IPartnerRepository.js";
import type { IStaffAccountRepository } from "../../../domain/repositories/IStaffAccountRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationNotFoundError } from "../../errors/ApplicationErrors.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import { StaffNotFoundError, StaffRuleViolationError } from "../../errors/StaffErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  IPartnerQueries,
  PartnerApplicationMessage,
  PartnerApplicationRow,
  PartnerDashboardCounts,
  PartnerTenantFilter,
  PartnerTenantRow,
  PartnerTenantStatusChange,
} from "../../ports/IPartnerQueries.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformSessions } from "../../ports/IPlatformSessions.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type {
  ApplicationSignup,
  SignupInput,
  SignupResult,
} from "../applications/ApplicationSignup.js";
import type {
  StaffAdministration,
  StaffInvitationResult,
} from "../platform/StaffAdministration.js";
import { PartnerNotFoundError, type PartnerUserView } from "./PartnerAdministration.js";

/** What a reseller sees of a tenant: optional parts only with the matching capability. */
export type PartnerTenantView = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: PartnerTenantRow["status"];
  source: PartnerTenantRow["source"];
  attributedAt: Date;
  signedUpAt: Date | null;
  activatedAt: Date | null;
  trialEndsAt: Date | null;
  /** With `platform.partner.tenants.view_billing_state`. */
  deactivationReason?: string | null;
  /** With `platform.partner.tenants.view_owner_contact`. */
  owner?: PartnerTenantRow["owner"];
}>;

export type PartnerApplicationView = PartnerApplicationRow &
  Readonly<{ messages?: readonly PartnerApplicationMessage[] }>;

export type PartnerProfileView = Readonly<{
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  region: string | null;
  status: string;
  capabilities: readonly string[];
  /** With `platform.partner.referral_tools.view`. */
  referral?: Readonly<{ code: string; link: string }>;
  /** With `platform.partner.terms.view`: the terms in force (null until set). */
  commissionTerms?: Readonly<{
    version: number;
    standardPercent: string | null;
    enterprisePercent: string | null;
    holdDays: number;
    minPayoutMinor: number;
    capPerTenantMinor: number | null;
    effectiveFrom: Date;
  }> | null;
}>;

/**
 * The reseller's own console (docs/29 §6). The partner always comes from the signed-in user,
 * never from the request; anything of another partner is "not found", and fields the partner
 * lacks the capability for are left out of responses.
 */
export class PartnerPortal {
  constructor(
    private readonly deps: Readonly<{
      queries: IPartnerQueries;
      partners: IPartnerRepository;
      accounts: IStaffAccountRepository;
      sessions: IPlatformSessions;
      signup: ApplicationSignup;
      staff: StaffAdministration;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
      settings: Readonly<{ signupUrl: string }>;
      commissionTerms: (partnerId: string) => Promise<CommissionTerms | null>;
    }>,
  ) {}

  dashboard(user: PlatformPrincipal): Promise<PartnerDashboardCounts> {
    return this.deps.queries.dashboard(partnerOf(user), this.deps.clock.now());
  }

  async tenants(
    user: PlatformPrincipal,
    filter: PartnerTenantFilter,
  ): Promise<PartnerTenantView[]> {
    const rows = await this.deps.queries.tenants(partnerOf(user), filter);
    return rows.map((row) => this.tenantView(user, row));
  }

  async tenant(
    user: PlatformPrincipal,
    tenantId: string,
  ): Promise<
    PartnerTenantView & Readonly<{ statusHistory: readonly PartnerTenantStatusChange[] }>
  > {
    const partnerId = partnerOf(user);
    const row = await this.deps.queries.tenant(partnerId, tenantId);
    if (row === null) throw new TenantNotFoundForStaffError();
    const billing = user.has("platform.partner.tenants.view_billing_state");
    const history = await this.deps.queries.statusHistory(partnerId, tenantId);
    return {
      ...this.tenantView(user, row),
      statusHistory: history.map((h) => (billing ? h : { ...h, reasonCategory: null })),
    };
  }

  applications(
    user: PlatformPrincipal,
    filter: Readonly<{ status?: ApplicationStatus; limit: number; before?: string }>,
  ): Promise<PartnerApplicationRow[]> {
    return this.deps.queries.applications(partnerOf(user), filter);
  }

  async application(
    user: PlatformPrincipal,
    applicationId: string,
  ): Promise<PartnerApplicationView> {
    const row = await this.deps.queries.application(partnerOf(user), applicationId);
    if (row === null) throw new ApplicationNotFoundError();
    return { ...row, messages: await this.deps.queries.applicationMessages(applicationId) };
  }

  /** Assisted signup for a client; the client verifies email and phone themselves. */
  createApplication(
    user: PlatformPrincipal,
    input: Omit<SignupInput, "referralCode">,
    context: Readonly<{ ip: string | null; userAgent: string | null }>,
  ): Promise<SignupResult> {
    return this.deps.signup.submit(
      { ...input, referralCode: null },
      { ...context, staffId: user.userId, partnerId: partnerOf(user) },
    );
  }

  async respond(
    user: PlatformPrincipal,
    applicationId: string,
    message: string,
    corrections: ApplicationCorrections,
  ): Promise<PartnerApplicationView> {
    await this.deps.signup.replyForPartner(
      applicationId,
      { partnerId: partnerOf(user), userId: user.userId },
      message,
      corrections,
    );
    return this.application(user, applicationId);
  }

  async profile(user: PlatformPrincipal): Promise<PartnerProfileView> {
    const partner = await this.deps.partners.findById(partnerOf(user));
    if (partner === null) throw new PartnerNotFoundError();
    const p = partner.snapshot();
    return {
      id: p.id,
      name: p.profile.name,
      contactName: p.profile.contactName,
      email: p.profile.email,
      phone: p.profile.phone,
      region: p.profile.region,
      status: p.status,
      capabilities: user.permissionKeys,
      ...(user.has("platform.partner.referral_tools.view")
        ? { referral: { code: p.referralCode, link: this.referralLink(p.referralCode) } }
        : {}),
      ...(user.has("platform.partner.terms.view")
        ? { commissionTerms: termsView(await this.deps.commissionTerms(p.id)) }
        : {}),
    };
  }

  async users(user: PlatformPrincipal): Promise<PartnerUserView[]> {
    const accounts = await this.deps.accounts.listByPartner(partnerOf(user));
    return accounts.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      mfaEnrolled: u.mfaEnrolled,
      lastLoginAt: u.snapshot().lastLoginAt,
    }));
  }

  async inviteUser(
    user: PlatformPrincipal,
    params: Readonly<{ email: string; name: string }>,
  ): Promise<StaffInvitationResult> {
    const partner = await this.deps.partners.findById(partnerOf(user));
    if (partner === null) throw new PartnerNotFoundError();
    partner.assertCanOnboard();
    return this.deps.staff.invite({ ...params, roleIds: [], actor: user, partnerId: partner.id });
  }

  async setUserEnabled(
    user: PlatformPrincipal,
    userId: string,
    enabled: boolean,
    reason: string,
  ): Promise<void> {
    const { deps } = this;
    if (userId === user.userId)
      throw new StaffRuleViolationError(
        "CANNOT_CHANGE_OWN_ACCOUNT",
        "Ask a colleague or Autoforce support to do this",
      );
    await deps.unitOfWork.run(async () => {
      const account = await deps.accounts.lockById(userId);
      if (account === null || account.partnerId !== partnerOf(user)) throw new StaffNotFoundError();
      const before = account.status;
      const now = deps.clock.now();
      if (enabled) account.enable();
      else {
        account.disable();
        await deps.sessions.revokeAllForUser(account.id, "user_disabled", now);
      }
      await deps.accounts.save(account);
      const request = deps.requestContext.current();
      await deps.audit.record({
        actorType: "partner",
        actorId: user.userId,
        action: enabled ? "partner_user.enabled" : "partner_user.disabled",
        entityType: "platform_user",
        entityId: account.id,
        reason,
        before: { status: before },
        after: { status: account.status },
        metadata: { partnerId: account.partnerId },
        requestId: request?.requestId ?? null,
        ip: request?.ip ?? null,
      });
    });
  }

  private tenantView(user: PlatformPrincipal, row: PartnerTenantRow): PartnerTenantView {
    return {
      id: row.tenantId,
      name: row.name,
      slug: row.slug,
      status: row.status,
      source: row.source,
      attributedAt: row.attributedAt,
      signedUpAt: row.signedUpAt,
      activatedAt: row.activatedAt,
      trialEndsAt: row.trialEndsAt,
      ...(user.has("platform.partner.tenants.view_billing_state")
        ? { deactivationReason: row.deactivationReason }
        : {}),
      ...(user.has("platform.partner.tenants.view_owner_contact") ? { owner: row.owner } : {}),
    };
  }

  private referralLink(code: string): string {
    return `${this.deps.settings.signupUrl.replace(/\/$/, "")}/signup?ref=${encodeURIComponent(code)}`;
  }
}

/** The reseller's own terms, without staff's internal reason. */
const termsView = (t: CommissionTerms | null) =>
  t === null
    ? null
    : {
        version: t.version,
        standardPercent: t.standardPercent,
        enterprisePercent: t.enterprisePercent,
        holdDays: t.holdDays,
        minPayoutMinor: t.minPayoutMinor,
        capPerTenantMinor: t.capPerTenantMinor,
        effectiveFrom: t.effectiveFrom,
      };

/** The signed-in user's partner; partner routes only admit partner users. */
function partnerOf(user: PlatformPrincipal): string {
  if (user.partnerId === null) throw new PermissionDeniedError("platform.partner");
  return user.partnerId;
}
