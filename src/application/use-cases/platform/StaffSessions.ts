import { AuthSession } from "../../../domain/entities/AuthSession.js";
import type { StaffAccount } from "../../../domain/entities/StaffAccount.js";
import type { IPartnerRepository } from "../../../domain/repositories/IPartnerRepository.js";
import type { IStaffAccountRepository } from "../../../domain/repositories/IStaffAccountRepository.js";
import { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import {
  isPartnerCapability,
  STAFF_PERMISSION_KEYS,
  type PlatformPermissionKey,
} from "../../authorization/platformPermissionCatalog.js";
import type { AuthenticationResult } from "../../dto/AuthenticationResult.js";
import {
  InvalidAccessTokenError,
  InvalidRefreshTokenError,
  RefreshTokenReuseError,
} from "../../errors/AuthErrors.js";
import type { IAccessTokenService } from "../../ports/IAccessTokenService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformRoles } from "../../ports/IPlatformRoles.js";
import type { IPlatformSessions } from "../../ports/IPlatformSessions.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRefreshTokenService } from "../../ports/IRefreshTokenService.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";

export type StaffSessionSettings = Readonly<{
  /** No request for this long ends the session (docs/27 §2: 60 min). */
  idleMs: number;
  /** Absolute session lifetime. */
  maxMs: number;
  /** How long a step-up (re-authentication) counts as recent. */
  stepUpMs: number;
}>;

const TOUCH_INTERVAL_MS = 60_000;

/**
 * Staff sessions: issuing, refreshing (with rotation and reuse detection), ending, and turning
 * an access token into a PlatformPrincipal. Unlike tenant sessions, the session row is checked
 * on every console request, so sign-out, disabling and idle expiry take effect immediately.
 */
export class StaffSessions {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      accounts: IStaffAccountRepository;
      roles: IPlatformRoles;
      partners: IPartnerRepository;
      sessions: IPlatformSessions;
      accessTokens: IAccessTokenService;
      refreshTokens: IRefreshTokenService;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      settings: StaffSessionSettings;
    }>,
  ) {}

  get settings(): StaffSessionSettings {
    return this.deps.settings;
  }

  /** Opens a session after a complete sign-in (password + second factor). */
  async start(account: StaffAccount, userAgent: string | null): Promise<AuthenticationResult> {
    const { deps } = this;
    const now = deps.clock.now();
    const sessionId = deps.ids.next();
    const refresh = deps.refreshTokens.generate(sessionId);
    const session = AuthSession.start({
      id: sessionId,
      userId: account.id,
      refreshTokenHash: refresh.hash,
      now,
      ttlMs: deps.settings.maxMs,
      userAgent,
      ip: deps.requestContext.current()?.ip ?? null,
    });
    await deps.sessions.save(session, now);
    const access = await deps.accessTokens.issue({
      audience: "platform",
      userId: account.id,
      sessionId,
      permissionVersion: account.permissionVersion,
    });
    return {
      sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  async refresh(refreshToken: string): Promise<AuthenticationResult> {
    const { deps } = this;
    const presented = deps.refreshTokens.parse(refreshToken);
    if (presented === null) throw new InvalidRefreshTokenError();

    type Outcome =
      | { kind: "rotated"; token: string; expiresAt: Date; userId: string; version: number }
      | { kind: "reused" }
      | { kind: "rejected" };
    const outcome = await deps.unitOfWork.run(async (): Promise<Outcome> => {
      const now = deps.clock.now();
      const state = await deps.sessions.find(presented.sessionId);
      const session = await deps.sessions.lockById(presented.sessionId);
      if (state === null || session === null) return { kind: "rejected" };

      const match = session.matchRefreshToken(presented.hash);
      if (match === "reused" && session.isActive(now)) {
        session.revoke("refresh_token_reuse", now);
        await deps.sessions.save(session, now);
        await deps.audit.record({
          actorType: "system",
          action: "staff.refresh_token_reused",
          entityType: "platform_session",
          entityId: session.id,
          metadata: { userId: session.userId },
          ...this.requestMeta(),
        });
        return { kind: "reused" };
      }
      if (match !== "current" || !session.isActive(now)) return { kind: "rejected" };
      if (now.getTime() - state.lastSeenAt.getTime() >= deps.settings.idleMs) {
        session.revoke("idle_timeout", now);
        await deps.sessions.save(session, now);
        return { kind: "rejected" };
      }

      const account = await deps.accounts.findById(session.userId);
      if (account === null || account.status !== "active") {
        session.revoke("user_disabled", now);
        await deps.sessions.save(session, now);
        return { kind: "rejected" };
      }
      const next = deps.refreshTokens.generate(session.id);
      session.rotate(next.hash, now);
      await deps.sessions.save(session, now);
      return {
        kind: "rotated",
        token: next.token,
        expiresAt: session.expiresAt,
        userId: account.id,
        version: account.permissionVersion,
      };
    });

    if (outcome.kind === "reused") throw new RefreshTokenReuseError(presented.sessionId);
    if (outcome.kind === "rejected") throw new InvalidRefreshTokenError();
    const access = await deps.accessTokens.issue({
      audience: "platform",
      userId: outcome.userId,
      sessionId: presented.sessionId,
      permissionVersion: outcome.version,
    });
    return {
      sessionId: presented.sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: outcome.token,
      refreshTokenExpiresAt: outcome.expiresAt,
    };
  }

  async logout(principal: PlatformPrincipal): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const session = await deps.sessions.lockById(principal.sessionId);
      if (session === null) return;
      const now = deps.clock.now();
      session.revoke("logout", now);
      await deps.sessions.save(session, now);
      await deps.audit.record({
        actorType: "platform_staff",
        actorId: principal.userId,
        action: "staff.signed_out",
        entityType: "platform_session",
        entityId: session.id,
        ...this.requestMeta(),
      });
    });
  }

  /**
   * Turns a console access token into the acting staff member: signature and audience, then the
   * session (active, not idle), the account (active, current permission version) and the union
   * of the permissions of their roles. A reseller user instead gets their partner's capability
   * grants (never staff permissions), and nothing at all once the partner is terminated.
   */
  async authenticate(accessToken: string): Promise<PlatformPrincipal> {
    const { deps } = this;
    const subject = await deps.accessTokens.verify(accessToken, "platform");
    const now = deps.clock.now();

    const state = await deps.sessions.find(subject.sessionId);
    if (state === null || state.session.userId !== subject.userId || !state.session.isActive(now)) {
      throw new InvalidAccessTokenError("session_inactive");
    }
    if (now.getTime() - state.lastSeenAt.getTime() >= deps.settings.idleMs) {
      throw new InvalidAccessTokenError("session_idle");
    }
    const account = await deps.accounts.findById(subject.userId);
    if (account === null || account.status !== "active") {
      throw new InvalidAccessTokenError("staff_unavailable");
    }
    if (account.permissionVersion !== subject.permissionVersion) {
      throw new InvalidAccessTokenError("stale_permissions");
    }

    const permissions = new Set<PlatformPermissionKey>();
    const systemRoles = new Set<string>();
    if (account.partnerId !== null) {
      const partner = await deps.partners.findById(account.partnerId);
      if (partner === null || partner.status === "terminated") {
        throw new InvalidAccessTokenError("partner_terminated");
      }
      for (const key of partner.capabilities) if (isPartnerCapability(key)) permissions.add(key);
    } else {
      const roles = await deps.roles.rolesOfUser(account.id);
      for (const role of roles) {
        if (role.systemKey !== null) systemRoles.add(role.systemKey);
        // Keys removed from the catalogue (or partner capabilities) never grant anything.
        for (const key of role.permissions)
          if (STAFF_PERMISSION_KEYS.includes(key)) permissions.add(key);
      }
    }

    if (now.getTime() - state.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      await deps.sessions.touch(state.session.id, now);
    }
    return new PlatformPrincipal(
      account.id,
      state.session.id,
      account.email,
      account.name,
      systemRoles,
      permissions,
      state.stepUpAt,
      account.partnerId,
    );
  }

  requestMeta(): Readonly<{ requestId: string | null; ip: string | null }> {
    const request = this.deps.requestContext.current();
    return { requestId: request?.requestId ?? null, ip: request?.ip ?? null };
  }
}
