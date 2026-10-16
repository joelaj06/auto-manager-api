import type { LockoutPolicy } from "../../../domain/entities/StaffAccount.js";
import type { TenantUser } from "../../../domain/entities/TenantUser.js";
import type { ITenantUserRepository } from "../../../domain/repositories/ITenantUserRepository.js";
import { PhoneNumber } from "../../../domain/value-objects/PhoneNumber.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { Principal } from "../../authorization/Principal.js";
import type { AuthenticationResult } from "../../dto/AuthenticationResult.js";
import { InvalidCredentialsError, TooManyAttemptsError } from "../../errors/StaffErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPasswordHasher } from "../../ports/IPasswordHasher.js";
import type { IPermissionCache } from "../../ports/IPermissionCache.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantSessions } from "../../ports/ITenantSessions.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IUserDirectory } from "../../ports/IUserDirectory.js";
import { assertAcceptablePassword } from "../../services/PasswordPolicy.js";
import type { StartAuthSession } from "../auth/StartAuthSession.js";
import type { IssueOtpChallenge } from "../auth/IssueOtpChallenge.js";
import type { VerifyOtpChallenge } from "../auth/VerifyOtpChallenge.js";

export type DiscoveredTenant = Readonly<{ slug: string; name: string }>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An email or a phone number, normalised; null when it is neither. */
export function parseIdentifier(
  input: string,
): Readonly<{ kind: "email" | "phone"; value: string }> | null {
  const trimmed = input.trim();
  if (EMAIL.test(trimmed)) return { kind: "email", value: trimmed.toLowerCase() };
  try {
    return { kind: "phone", value: PhoneNumber.parse(trimmed).value };
  } catch {
    return null;
  }
}

/**
 * Tenant sign-in and credentials (docs/16, docs/23): password sign-in with lockout, multi-business
 * discovery for the mobile app, password reset by emailed code, and password change. Wrong email,
 * wrong password and unknown accounts get the same answer; password reset requests always look
 * successful.
 */
export class TenantSignIn {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      tenantContext: ITenantContext;
      users: ITenantUserRepository;
      sessions: ITenantSessions;
      startSession: StartAuthSession;
      passwords: IPasswordHasher;
      issueOtp: IssueOtpChallenge;
      verifyOtp: VerifyOtpChallenge;
      organisation: IOrganisationSettings;
      directory: IUserDirectory;
      permissionCache: IPermissionCache;
      notifications: NotificationService;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
      logger: ILogger;
      lockout: LockoutPolicy;
      otpTtlMinutes: number;
    }>,
  ) {}

  /** Runs in the tenant context of the request (X-Tenant). */
  async login(
    identifier: string,
    password: string,
    userAgent: string | null,
  ): Promise<AuthenticationResult> {
    const { deps } = this;
    type Outcome = { ok: true; user: TenantUser } | { ok: false; locked: boolean };
    const outcome = await deps.unitOfWork.run(async (): Promise<Outcome> => {
      const now = deps.clock.now();
      const found = await this.findUser(identifier);
      const user = found === null ? null : await deps.users.lockById(found.id);
      if (user === null || user.passwordHash === null) {
        await deps.passwords.verify(await this.dummy(), password);
        return { ok: false, locked: false };
      }
      if (user.isLocked(now)) return { ok: false, locked: true };
      const valid = await deps.passwords.verify(user.passwordHash, password);
      if (valid && user.status === "active") {
        user.recordSuccessfulLogin(now);
        await deps.users.save(user);
        await this.audit("user.signed_in", user.id, { userAgent });
        return { ok: true, user };
      }
      const locked = user.recordFailedAttempt(now, deps.lockout);
      await deps.users.save(user);
      await this.audit("user.sign_in_failed", user.id, { locked });
      return { ok: false, locked };
    });
    if (!outcome.ok)
      throw outcome.locked ? new TooManyAttemptsError() : new InvalidCredentialsError();
    return deps.startSession.execute({
      userId: outcome.user.id,
      permissionVersion: outcome.user.permissionVersion,
      userAgent,
    });
  }

  /**
   * Which businesses this person can sign in to (mobile app, before choosing one). Only
   * businesses where the password is correct are returned, so it reveals nothing about an email
   * or phone to someone who does not know the password. No tenant context.
   */
  async discover(identifier: string, password: string): Promise<DiscoveredTenant[]> {
    const { deps } = this;
    const parsed = parseIdentifier(identifier);
    const candidates =
      parsed === null ? [] : await deps.directory.tenantsFor(parsed.kind, parsed.value);
    const found: DiscoveredTenant[] = [];
    for (const tenant of candidates.slice(0, 20)) {
      const user = await deps.tenantContext.runAs(TenantId.from(tenant.tenantId), () =>
        deps.unitOfWork.run(() => this.findUser(identifier)),
      );
      if (
        user !== null &&
        user.status === "active" &&
        user.passwordHash !== null &&
        (await deps.passwords.verify(user.passwordHash, password))
      ) {
        found.push({ slug: tenant.slug, name: tenant.name });
      }
    }
    if (found.length === 0) await deps.passwords.verify(await this.dummy(), password);
    return found;
  }

  /** Emails a reset code if the account exists and can receive email. Always looks the same. */
  async requestPasswordReset(identifier: string): Promise<void> {
    const { deps } = this;
    const user = await deps.unitOfWork.run(() => this.findUser(identifier));
    if (user === null || user.status === "disabled") return;
    if (user.email === null) {
      // Phone-only users reset through their administrator until tenant SMS exists.
      deps.logger.info("Password reset requested for a user without email", { userId: user.id });
      return;
    }
    const issued = await deps.issueOtp.execute({ subject: user.id, purpose: "password_reset" });
    const organisation = await deps.unitOfWork.run(() => deps.organisation.get());
    await deps.notifications.sendEmail({
      to: user.email,
      template: "auth.otp_code",
      data: {
        recipientName: user.name,
        code: issued.code,
        purpose: "password_reset",
        expiresInMinutes: deps.otpTtlMinutes,
        businessName: organisation.name,
      },
      idempotencyKey: `password-reset:${issued.challengeId}`,
      tenantId: deps.tenantContext.currentTenantId().value,
    });
  }

  /** Sets a new password with the emailed code and signs the user out everywhere. */
  async confirmPasswordReset(identifier: string, code: string, newPassword: string): Promise<void> {
    const { deps } = this;
    const user = await deps.unitOfWork.run(() => this.findUser(identifier));
    if (user === null) {
      // Same failure as a wrong code, without revealing that no such account exists.
      await deps.verifyOtp.execute({ subject: "unknown-user", purpose: "password_reset", code });
      return;
    }
    assertAcceptablePassword(newPassword, user.email ?? "");
    await deps.verifyOtp.execute({ subject: user.id, purpose: "password_reset", code });
    await this.setPassword(user.id, newPassword, "user.password_reset");
  }

  async changePassword(
    principal: Principal,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const { deps } = this;
    const user = await deps.unitOfWork.run(() => deps.users.findById(principal.userId));
    if (user === null || user.passwordHash === null) throw new InvalidCredentialsError();
    if (!(await deps.passwords.verify(user.passwordHash, currentPassword)))
      throw new InvalidCredentialsError();
    assertAcceptablePassword(newPassword, user.email ?? "");
    await this.setPassword(user.id, newPassword, "user.password_changed");
  }

  private async setPassword(userId: string, password: string, action: string): Promise<void> {
    const { deps } = this;
    const hash = await deps.passwords.hash(password);
    await deps.unitOfWork.run(async () => {
      const user = await deps.users.lockById(userId);
      if (user === null) throw new InvalidCredentialsError();
      user.setPassword(hash);
      await deps.users.save(user);
      await deps.sessions.revokeForUser(user.id, "password_changed", deps.clock.now());
      await this.audit(action, user.id, {});
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
  }

  private async findUser(identifier: string): Promise<TenantUser | null> {
    const parsed = parseIdentifier(identifier);
    if (parsed === null) return null;
    return parsed.kind === "email"
      ? this.deps.users.findByEmail(parsed.value)
      : this.deps.users.findByPhone(parsed.value);
  }

  private async audit(action: string, userId: string, metadata: Record<string, unknown>) {
    const request = this.deps.requestContext.current();
    await this.deps.auditTrail.record({
      actorType: "user",
      actorId: userId,
      action,
      entityType: "user",
      entityId: userId,
      metadata,
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= this.deps.passwords.hash("timing-equaliser-not-a-password");
    return this.dummyHash;
  }
}
