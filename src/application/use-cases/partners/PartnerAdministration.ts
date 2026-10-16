import { randomBytes } from "node:crypto";
import {
  Partner,
  PartnerInactiveError,
  type PartnerProfile,
  type PartnerProps,
} from "../../../domain/entities/Partner.js";
import type { IPartnerRepository } from "../../../domain/repositories/IPartnerRepository.js";
import type { IStaffAccountRepository } from "../../../domain/repositories/IStaffAccountRepository.js";
import { PhoneNumber } from "../../../domain/value-objects/PhoneNumber.js";
import { ReferralCode } from "../../../domain/value-objects/ReferralCode.js";
import {
  DEFAULT_PARTNER_CAPABILITIES,
  isPartnerCapability,
  PARTNER_CAPABILITY_KEYS,
  PLATFORM_PERMISSION_CATALOG,
} from "../../authorization/platformPermissionCatalog.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type {
  IPartnerAttributions,
  IPartnerQueries,
  PartnerListItem,
  PartnerTenantFilter,
  PartnerTenantRow,
} from "../../ports/IPartnerQueries.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformSessions } from "../../ports/IPlatformSessions.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type {
  StaffAdministration,
  StaffInvitationResult,
} from "../platform/StaffAdministration.js";

export class PartnerNotFoundError extends ApplicationError {
  readonly code = "PARTNER_NOT_FOUND";
  constructor() {
    super("Partner not found");
  }
}

/** Partner profile rules: duplicate email or code, unknown capability (409 / 400). */
export class PartnerRuleError extends ApplicationError {
  constructor(
    readonly code: "PARTNER_EMAIL_TAKEN" | "REFERRAL_CODE_TAKEN" | "UNKNOWN_CAPABILITY",
    message: string,
  ) {
    super(message);
  }
}

export type PartnerInput = Omit<PartnerProfile, "phone"> & Readonly<{ phone: string }>;

export type PartnerUserView = Readonly<{
  id: string;
  email: string;
  name: string;
  status: string;
  mfaEnrolled: boolean;
  lastLoginAt: Date | null;
}>;

export type PartnerDetail = Omit<PartnerProps, "capabilities" | "version"> &
  Readonly<{
    capabilities: readonly Readonly<{ key: string; description: string; granted: boolean }>[];
    users: readonly PartnerUserView[];
  }>;

const CODE_ATTEMPTS = 5;

/**
 * Staff side of the reseller programme (docs/29 §2, §3, §7): partner profiles, status,
 * capability grants, partner console users and tenant attribution. Every change is audited.
 */
export class PartnerAdministration {
  constructor(
    private readonly deps: Readonly<{
      partners: IPartnerRepository;
      queries: IPartnerQueries;
      attributions: IPartnerAttributions;
      accounts: IStaffAccountRepository;
      sessions: IPlatformSessions;
      staff: StaffAdministration;
      directory: ITenantDirectory;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  list(filter: Parameters<IPartnerQueries["list"]>[0]): Promise<PartnerListItem[]> {
    return this.deps.queries.list(filter);
  }

  async get(partnerId: string): Promise<PartnerDetail> {
    const partner = await this.partner(partnerId);
    const { capabilities, version: _version, ...props } = partner.snapshot();
    const users = await this.deps.accounts.listByPartner(partnerId);
    return {
      ...props,
      capabilities: PARTNER_CAPABILITY_KEYS.map((key) => ({
        key,
        description: PLATFORM_PERMISSION_CATALOG[key].description,
        granted: capabilities.includes(key),
      })),
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        mfaEnrolled: u.mfaEnrolled,
        lastLoginAt: u.snapshot().lastLoginAt,
      })),
    };
  }

  async create(
    input: PartnerInput & Readonly<{ referralCode?: string | null }>,
    actor: PlatformPrincipal,
  ): Promise<string> {
    const { deps } = this;
    const profile = this.profile(input);
    return deps.unitOfWork.run(async () => {
      if (await deps.partners.emailTaken(profile.email)) throw this.emailTaken();
      const referralCode = await this.referralCode(input.referralCode ?? null, profile.name);
      const partner = Partner.create({
        id: deps.ids.next(),
        profile,
        referralCode,
        capabilities: DEFAULT_PARTNER_CAPABILITIES,
        now: deps.clock.now(),
      });
      await deps.partners.save(partner, actor.userId);
      await this.audit(actor, "partner.created", partner.id, null, null, partner.snapshot());
      return partner.id;
    });
  }

  async update(
    partnerId: string,
    changes: Partial<PartnerInput> & Readonly<{ trusted?: boolean; referralCode?: string }>,
    actor: PlatformPrincipal,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const partner = await this.locked(partnerId);
      const before = partner.snapshot();
      const { referralCode: code, trusted, ...profileChanges } = changes;
      if (profileChanges.phone !== undefined)
        profileChanges.phone = PhoneNumber.parse(profileChanges.phone, "GH").value;
      if (
        profileChanges.email !== undefined &&
        (await deps.partners.emailTaken(profileChanges.email, partnerId))
      )
        throw this.emailTaken();
      let referralCode: ReferralCode | undefined;
      if (code !== undefined) {
        referralCode = ReferralCode.parse(code);
        if (await deps.partners.referralCodeTaken(referralCode.value, partnerId))
          throw new PartnerRuleError("REFERRAL_CODE_TAKEN", "This referral code is in use");
      }
      partner.update({
        ...profileChanges,
        ...(trusted === undefined ? {} : { trusted }),
        ...(referralCode === undefined ? {} : { referralCode }),
      });
      await deps.partners.save(partner, actor.userId);
      await this.audit(actor, "partner.updated", partnerId, null, before, partner.snapshot());
    });
  }

  async setCapabilities(
    partnerId: string,
    capabilities: readonly string[],
    actor: PlatformPrincipal,
    reason: string,
  ): Promise<void> {
    const unknown = capabilities.filter((key) => !isPartnerCapability(key));
    if (unknown.length > 0)
      throw new PartnerRuleError(
        "UNKNOWN_CAPABILITY",
        `Unknown capabilities: ${unknown.join(", ")}`,
      );
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const partner = await this.locked(partnerId);
      const before = partner.capabilities;
      if (!partner.setCapabilities(capabilities)) return;
      await deps.partners.save(partner, actor.userId);
      // The partner's users get the new capabilities on their next token.
      await this.bumpUsers(partnerId);
      await this.audit(
        actor,
        "partner.capabilities_changed",
        partnerId,
        reason,
        before,
        partner.capabilities,
      );
    });
  }

  async pause(partnerId: string, reason: string, actor: PlatformPrincipal): Promise<void> {
    await this.changeStatus(partnerId, reason, actor, "partner.paused", (p, now) =>
      p.pause(reason, now),
    );
  }

  async resume(partnerId: string, reason: string, actor: PlatformPrincipal): Promise<void> {
    await this.changeStatus(partnerId, reason, actor, "partner.resumed", (p, now) =>
      p.resume(reason, now),
    );
  }

  /** Final: every partner user is disabled and signed out; attributed tenants keep the partner. */
  async terminate(partnerId: string, reason: string, actor: PlatformPrincipal): Promise<void> {
    await this.changeStatus(partnerId, reason, actor, "partner.terminated", async (p, now) => {
      p.terminate(reason, now);
      for (const user of await this.deps.accounts.listByPartner(partnerId)) {
        const account = await this.deps.accounts.lockById(user.id);
        if (account === null) continue;
        account.disable();
        await this.deps.accounts.save(account);
        await this.deps.sessions.revokeAllForUser(account.id, "user_disabled", now);
      }
    });
  }

  async inviteUser(
    partnerId: string,
    params: Readonly<{ email: string; name: string }>,
    actor: PlatformPrincipal,
  ): Promise<StaffInvitationResult> {
    const partner = await this.partner(partnerId);
    if (partner.status === "terminated") throw new PartnerInactiveError("terminated");
    return this.deps.staff.invite({ ...params, roleIds: [], actor, partnerId });
  }

  async tenants(partnerId: string, filter: PartnerTenantFilter): Promise<PartnerTenantRow[]> {
    await this.partner(partnerId);
    return this.deps.queries.tenants(partnerId, filter);
  }

  /**
   * Manual attribution (docs/29 §3): assigns a tenant to a partner, moves it to another one, or
   * (partnerId null) removes the attribution. Needs a reason; audited with before and after.
   */
  async assignTenant(
    tenantId: string,
    partnerId: string | null,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<void> {
    const { deps } = this;
    if ((await deps.directory.findById(tenantId)) === null) throw new TenantNotFoundForStaffError();
    await deps.unitOfWork.run(async () => {
      const before = await deps.attributions.find(tenantId);
      if (partnerId === null) {
        if (before === null) return;
        await deps.attributions.remove(tenantId);
      } else {
        const partner = await this.partner(partnerId);
        partner.assertCanOnboard();
        if (before?.partnerId === partnerId) return;
        await deps.attributions.attribute({
          tenantId,
          partnerId,
          source: "manual",
          applicationId: null,
          actorId: actor.userId,
          reason,
        });
      }
      await recordStaffAction(deps, actor, {
        action: "tenant.partner_changed",
        entityType: "tenant",
        entityId: tenantId,
        targetTenantId: tenantId,
        reason,
        before: before === null ? null : { partnerId: before.partnerId, source: before.source },
        after: partnerId === null ? null : { partnerId, source: "manual" },
      });
    });
  }

  // --- helpers ---

  private async changeStatus(
    partnerId: string,
    reason: string,
    actor: PlatformPrincipal,
    action: string,
    change: (partner: Partner, now: Date) => void | Promise<void>,
  ): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      const partner = await this.locked(partnerId);
      const before = partner.status;
      await change(partner, this.deps.clock.now());
      await this.deps.partners.save(partner, actor.userId);
      await this.audit(
        actor,
        action,
        partnerId,
        reason,
        { status: before },
        { status: partner.status },
      );
    });
  }

  private async bumpUsers(partnerId: string): Promise<void> {
    for (const user of await this.deps.accounts.listByPartner(partnerId)) {
      const account = await this.deps.accounts.lockById(user.id);
      if (account === null) continue;
      account.bumpPermissionVersion();
      await this.deps.accounts.save(account);
    }
  }

  private profile(input: PartnerInput): PartnerProfile {
    return { ...input, phone: PhoneNumber.parse(input.phone, "GH").value };
  }

  private async referralCode(requested: string | null, name: string): Promise<ReferralCode> {
    const { partners } = this.deps;
    if (requested !== null) {
      const code = ReferralCode.parse(requested);
      if (await partners.referralCodeTaken(code.value))
        throw new PartnerRuleError("REFERRAL_CODE_TAKEN", "This referral code is in use");
      return code;
    }
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = ReferralCode.generate(name, (n) => randomBytes(n));
      if (!(await partners.referralCodeTaken(code.value))) return code;
    }
    throw new PartnerRuleError("REFERRAL_CODE_TAKEN", "Choose a referral code for this partner");
  }

  private async partner(partnerId: string): Promise<Partner> {
    const partner = await this.deps.partners.findById(partnerId);
    if (partner === null) throw new PartnerNotFoundError();
    return partner;
  }

  private async locked(partnerId: string): Promise<Partner> {
    const partner = await this.deps.partners.lockById(partnerId);
    if (partner === null) throw new PartnerNotFoundError();
    return partner;
  }

  private emailTaken(): PartnerRuleError {
    return new PartnerRuleError("PARTNER_EMAIL_TAKEN", "Another partner uses this email");
  }

  private audit(
    actor: PlatformPrincipal,
    action: string,
    partnerId: string,
    reason: string | null,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    return recordStaffAction(this.deps, actor, {
      action,
      entityType: "partner",
      entityId: partnerId,
      reason,
      before,
      after,
    });
  }
}
