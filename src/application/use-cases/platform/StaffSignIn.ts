import { createHash } from "node:crypto";
import type { LockoutPolicy, StaffAccount } from "../../../domain/entities/StaffAccount.js";
import type { IStaffAccountRepository } from "../../../domain/repositories/IStaffAccountRepository.js";
import { SUPER_ADMIN_ROLE } from "../../authorization/platformPermissionCatalog.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { AuthenticationResult } from "../../dto/AuthenticationResult.js";
import {
  InvalidChallengeError,
  InvalidCredentialsError,
  InvalidMfaCodeError,
  InvitationInvalidError,
  TooManyAttemptsError,
} from "../../errors/StaffErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IKnownDevices } from "../../ports/IKnownDevices.js";
import type { IPasswordHasher } from "../../ports/IPasswordHasher.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformRoles } from "../../ports/IPlatformRoles.js";
import type { IPlatformSessions } from "../../ports/IPlatformSessions.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { ISecretBox } from "../../ports/ISecretBox.js";
import type { IStaffChallenges, StaffChallengePurpose } from "../../ports/IStaffChallenges.js";
import type { IStaffInvitations } from "../../ports/IStaffInvitations.js";
import type { ITotp } from "../../ports/ITotp.js";
import { assertAcceptablePassword } from "../../services/PasswordPolicy.js";
import type { StaffSessions } from "./StaffSessions.js";

export type SignInStep = Readonly<{
  /** `mfa`: enter the authenticator code. `enrol`: set up an authenticator first. */
  next: StaffChallengePurpose;
  challengeToken: string;
  expiresAt: Date;
}>;

export type TotpEnrolment = Readonly<{ secret: string; otpauthUri: string }>;

/**
 * Staff sign-in (docs/27 §2): password, then a mandatory authenticator code. New staff (and staff
 * whose MFA was reset) enrol an authenticator before their first session.
 *
 * Failures never reveal whether an account exists; repeated failures lock the account for a
 * while and alert the Super Admins. A sign-in from an unknown device sends the staff member an
 * email. Failed attempts are committed before the error is thrown.
 */
export class StaffSignIn {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      accounts: IStaffAccountRepository;
      invitations: IStaffInvitations;
      roles: IPlatformRoles;
      sessions: StaffSessions;
      sessionStore: IPlatformSessions;
      challenges: IStaffChallenges;
      passwords: IPasswordHasher;
      totp: ITotp;
      secrets: ISecretBox;
      devices: IKnownDevices;
      notifications: NotificationService;
      audit: IPlatformAuditTrail;
      clock: IClock;
      lockout: LockoutPolicy;
    }>,
  ) {}

  async acceptInvitation(token: string, password: string): Promise<SignInStep> {
    const { deps } = this;
    const tokenHash = sha256(token);
    const userId = await deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const invitation = await deps.invitations.lockValid(tokenHash, now);
      if (invitation === null) throw new InvitationInvalidError();
      const account = await deps.accounts.lockById(invitation.userId);
      if (account === null || account.status === "disabled") throw new InvitationInvalidError();

      assertAcceptablePassword(password, account.email);
      account.setPassword(await deps.passwords.hash(password));
      await deps.accounts.save(account);
      await deps.invitations.markAccepted(invitation.id, now);
      await this.audit("staff.invitation_accepted", account.id);
      return account.id;
    });
    return this.challenge(userId, "enrol");
  }

  async login(email: string, password: string): Promise<SignInStep> {
    const { deps } = this;
    type Outcome =
      { ok: true; account: StaffAccount } | { ok: false; locked: boolean; email?: string };
    const outcome = await deps.unitOfWork.run(async (): Promise<Outcome> => {
      const found = await deps.accounts.findByEmail(email.trim().toLowerCase());
      const account = found === null ? null : await deps.accounts.lockById(found.id);
      const now = deps.clock.now();
      if (account === null || account.passwordHash === null) {
        await deps.passwords.verify(await this.dummy(), password); // same timing as a real check
        return { ok: false, locked: false };
      }
      if (account.isLocked(now)) return { ok: false, locked: true };

      const valid = await deps.passwords.verify(account.passwordHash, password);
      if (valid && account.status !== "disabled") return { ok: true, account };

      const lockedNow = account.recordFailedAttempt(now, deps.lockout);
      await deps.accounts.save(account);
      await this.audit("staff.sign_in_failed", account.id, { step: "password" });
      return { ok: false, locked: lockedNow, ...(lockedNow ? { email: account.email } : {}) };
    });

    if (!outcome.ok) {
      if (outcome.email !== undefined) await this.alertLocked(outcome.email);
      throw outcome.locked ? new TooManyAttemptsError() : new InvalidCredentialsError();
    }
    return this.challenge(outcome.account.id, outcome.account.mfaEnrolled ? "mfa" : "enrol");
  }

  async completeMfa(
    challengeToken: string,
    code: string,
    userAgent: string | null,
  ): Promise<AuthenticationResult> {
    const userId = await this.deps.challenges.verify(challengeToken, "mfa");
    return this.verifyCodeAndStart(userId, code, userAgent, "mfa");
  }

  async beginTotpEnrolment(challengeToken: string): Promise<TotpEnrolment> {
    const { deps } = this;
    const userId = await deps.challenges.verify(challengeToken, "enrol");
    return deps.unitOfWork.run(async () => {
      const account = await deps.accounts.lockById(userId);
      if (account === null || account.status === "disabled" || account.mfaEnrolled) {
        throw new InvalidChallengeError("not_enrollable");
      }
      const secret = deps.totp.generateSecret();
      account.startTotpEnrolment(deps.secrets.seal(secret));
      await deps.accounts.save(account);
      return { secret, otpauthUri: deps.totp.provisioningUri(secret, account.email) };
    });
  }

  async confirmTotpEnrolment(
    challengeToken: string,
    code: string,
    userAgent: string | null,
  ): Promise<AuthenticationResult> {
    const userId = await this.deps.challenges.verify(challengeToken, "enrol");
    return this.verifyCodeAndStart(userId, code, userAgent, "enrol");
  }

  /** Re-authentication for sensitive actions: password and a fresh code. */
  async stepUp(principal: PlatformPrincipal, password: string, code: string): Promise<void> {
    const { deps } = this;
    type Outcome = { ok: true } | { ok: false; locked: boolean; email?: string };
    const outcome = await deps.unitOfWork.run(async (): Promise<Outcome> => {
      const now = deps.clock.now();
      const account = await deps.accounts.lockById(principal.userId);
      if (account === null || account.passwordHash === null || account.totpSecretSealed === null) {
        return { ok: false, locked: false };
      }
      if (account.isLocked(now)) return { ok: false, locked: true };
      const passwordOk = await deps.passwords.verify(account.passwordHash, password);
      const step = passwordOk
        ? deps.totp.verify(
            deps.secrets.open(account.totpSecretSealed),
            code,
            account.totpLastStep,
            now,
          )
        : null;
      if (step === null) {
        const lockedNow = account.recordFailedAttempt(now, deps.lockout);
        await deps.accounts.save(account);
        await this.audit("staff.step_up_failed", account.id);
        return { ok: false, locked: lockedNow, ...(lockedNow ? { email: account.email } : {}) };
      }
      account.acceptTotpStep(step);
      await deps.accounts.save(account);
      await deps.sessionStore.markStepUp(principal.sessionId, now);
      await this.audit("staff.stepped_up", account.id);
      return { ok: true };
    });
    if (!outcome.ok) {
      if (outcome.email !== undefined) await this.alertLocked(outcome.email);
      throw outcome.locked ? new TooManyAttemptsError() : new InvalidCredentialsError();
    }
  }

  private async verifyCodeAndStart(
    userId: string,
    code: string,
    userAgent: string | null,
    purpose: StaffChallengePurpose,
  ): Promise<AuthenticationResult> {
    const { deps } = this;
    type Outcome =
      | { ok: true; account: StaffAccount; newDevice: boolean; tokens: AuthenticationResult }
      | { ok: false; locked: boolean; email?: string };
    const outcome = await deps.unitOfWork.run(async (): Promise<Outcome> => {
      const now = deps.clock.now();
      const account = await deps.accounts.lockById(userId);
      if (account === null || account.status === "disabled" || account.totpSecretSealed === null) {
        throw new InvalidChallengeError("account_unavailable");
      }
      if (purpose === "mfa" && !account.mfaEnrolled)
        throw new InvalidChallengeError("not_enrolled");
      if (purpose === "enrol" && account.mfaEnrolled)
        throw new InvalidChallengeError("already_enrolled");
      if (account.isLocked(now)) return { ok: false, locked: true };

      const secret = deps.secrets.open(account.totpSecretSealed);
      const step = deps.totp.verify(secret, code, account.totpLastStep, now);
      if (step === null) {
        const lockedNow = account.recordFailedAttempt(now, deps.lockout);
        await deps.accounts.save(account);
        await this.audit("staff.sign_in_failed", account.id, { step: purpose });
        return { ok: false, locked: lockedNow, ...(lockedNow ? { email: account.email } : {}) };
      }

      if (purpose === "enrol") account.confirmTotpEnrolment(step, now);
      else account.acceptTotpStep(step);
      account.recordSuccessfulLogin(now);
      await deps.accounts.save(account);
      const newDevice = await deps.devices.remember(account.id, deviceHash(userAgent), now);
      await this.audit(purpose === "enrol" ? "staff.mfa_enrolled" : "staff.signed_in", account.id, {
        newDevice,
      });
      const tokens = await deps.sessions.start(account, userAgent);
      return { ok: true, account, newDevice, tokens };
    });

    if (!outcome.ok) {
      if (outcome.email !== undefined) await this.alertLocked(outcome.email);
      throw outcome.locked ? new TooManyAttemptsError() : new InvalidMfaCodeError();
    }
    // The first device (enrolment) is expected; later unknown devices get a security email.
    if (purpose === "mfa" && outcome.newDevice) {
      const meta = deps.sessions.requestMeta();
      await deps.notifications
        .sendEmail({
          to: outcome.account.email,
          template: "platform.new_sign_in",
          data: {
            name: outcome.account.name,
            at: deps.clock.now().toISOString(),
            ip: meta.ip,
            device: userAgent,
          },
          idempotencyKey: `staff-new-device:${outcome.tokens.sessionId}`,
        })
        .catch(() => undefined);
    }
    return outcome.tokens;
  }

  private async challenge(userId: string, purpose: StaffChallengePurpose): Promise<SignInStep> {
    const { token, expiresAt } = await this.deps.challenges.issue(userId, purpose);
    return { next: purpose, challengeToken: token, expiresAt };
  }

  private async alertLocked(staffEmail: string): Promise<void> {
    const { deps } = this;
    const at = deps.clock.now().toISOString();
    const supers = await deps.roles.activeUsersWithSystemRole(SUPER_ADMIN_ROLE);
    for (const admin of supers) {
      await deps.notifications
        .sendEmail({
          to: admin.email,
          template: "platform.staff_locked",
          data: { staffEmail, at, ip: deps.sessions.requestMeta().ip },
          idempotencyKey: `staff-locked:${staffEmail}:${at}:${admin.id}`,
        })
        .catch(() => undefined);
    }
  }

  private async audit(action: string, userId: string, metadata: Record<string, unknown> = {}) {
    await this.deps.audit.record({
      actorType: "platform_staff",
      actorId: userId,
      action,
      entityType: "platform_user",
      entityId: userId,
      metadata,
      ...this.deps.sessions.requestMeta(),
    });
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= this.deps.passwords.hash("timing-equaliser-not-a-password");
    return this.dummyHash;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Coarse device identity: the browser/app signature (no fingerprinting beyond that). */
function deviceHash(userAgent: string | null): string {
  return sha256(`ua:${(userAgent ?? "unknown").slice(0, 512)}`);
}
