import type { IAuthSessionRepository } from "../../../domain/repositories/IAuthSessionRepository.js";
import type { AuthenticationResult } from "../../dto/AuthenticationResult.js";
import { InvalidRefreshTokenError, RefreshTokenReuseError } from "../../errors/AuthErrors.js";
import type { IAccessTokenService } from "../../ports/IAccessTokenService.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { IRefreshTokenService } from "../../ports/IRefreshTokenService.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

type Outcome =
  | Readonly<{
      kind: "rotated";
      userId: string;
      refreshToken: string;
      expiresAt: Date;
      version: number;
    }>
  | Readonly<{ kind: "reused" }>
  | Readonly<{ kind: "rejected" }>;

/**
 * Exchanges a refresh token for a new token pair (rotation). Presenting a token that was already
 * rotated away revokes the whole session: either the client or an attacker holds a stolen copy.
 * Runs in the current tenant context.
 *
 * Failures that change state (revocation) are committed before the error is thrown.
 */
export class RefreshAuthSession {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      tenantContext: ITenantContext;
      sessions: IAuthSessionRepository;
      accessTokens: IAccessTokenService;
      refreshTokens: IRefreshTokenService;
      permissions: IPermissionResolver;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  async execute(refreshToken: string): Promise<AuthenticationResult> {
    const { deps } = this;
    const presented = deps.refreshTokens.parse(refreshToken);
    if (presented === null) throw new InvalidRefreshTokenError();
    const tenantId = deps.tenantContext.currentTenantId().value;

    const outcome = await deps.unitOfWork.run(async (): Promise<Outcome> => {
      const session = await deps.sessions.lockById(presented.sessionId);
      if (session === null) return { kind: "rejected" };
      const now = deps.clock.now();

      const match = session.matchRefreshToken(presented.hash);
      if (match === "reused" && session.isActive(now)) {
        session.revoke("refresh_token_reuse", now);
        await deps.sessions.save(session);
        await this.audit("auth.refresh_token_reused", session.userId, session.id);
        return { kind: "reused" };
      }
      if (match !== "current" || !session.isActive(now)) return { kind: "rejected" };

      const version = await deps.permissions.currentVersion(tenantId, session.userId);
      if (version === null) {
        session.revoke("user_disabled", now);
        await deps.sessions.save(session);
        return { kind: "rejected" };
      }

      const next = deps.refreshTokens.generate(session.id);
      session.rotate(next.hash, now);
      await deps.sessions.save(session);
      return {
        kind: "rotated",
        userId: session.userId,
        refreshToken: next.token,
        expiresAt: session.expiresAt,
        version,
      };
    });

    if (outcome.kind === "reused") throw new RefreshTokenReuseError(presented.sessionId);
    if (outcome.kind === "rejected") throw new InvalidRefreshTokenError();

    const access = await deps.accessTokens.issue({
      audience: "tenant",
      tenantId,
      userId: outcome.userId,
      sessionId: presented.sessionId,
      permissionVersion: outcome.version,
    });
    return {
      sessionId: presented.sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: outcome.refreshToken,
      refreshTokenExpiresAt: outcome.expiresAt,
    };
  }

  private async audit(action: string, userId: string, sessionId: string): Promise<void> {
    const request = this.deps.requestContext.current();
    await this.deps.auditTrail.record({
      actorType: "system",
      action,
      entityType: "auth_session",
      entityId: sessionId,
      metadata: { userId },
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }
}
