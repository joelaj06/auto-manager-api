import { AuthSession } from "../../../domain/entities/AuthSession.js";
import type { IAuthSessionRepository } from "../../../domain/repositories/IAuthSessionRepository.js";
import type { AuthenticationResult } from "../../dto/AuthenticationResult.js";
import type { IAccessTokenService } from "../../ports/IAccessTokenService.js";
import { TenantBillingOnlyError } from "../../errors/TenantErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { IRefreshTokenService } from "../../ports/IRefreshTokenService.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export type StartAuthSessionCommand = Readonly<{
  userId: string;
  permissionVersion: number;
  userAgent?: string | null;
}>;

export type AuthSessionSettings = Readonly<{ refreshTokenTtlMs: number }>;

/**
 * Opens a session for a tenant user whose credentials were already checked (password login,
 * OTP login, mobile QR connect — added with the identity module in P1-5) and returns its tokens.
 * Runs in the current tenant context. A tenant deactivated by billing only lets users with
 * billing access in (docs/25 §5.2).
 */
export class StartAuthSession {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      tenantContext: ITenantContext;
      sessions: IAuthSessionRepository;
      accessTokens: IAccessTokenService;
      refreshTokens: IRefreshTokenService;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      settings: AuthSessionSettings;
      /** Billing-only mode: who may still sign in. */
      billingOnly?: Readonly<{ tenants: ITenantDirectory; permissions: IPermissionResolver }>;
    }>,
  ) {}

  async execute(command: StartAuthSessionCommand): Promise<AuthenticationResult> {
    const { deps } = this;
    const tenantId = deps.tenantContext.currentTenantId().value;
    await this.assertMaySignIn(tenantId, command);
    const request = deps.requestContext.current();
    const sessionId = deps.ids.next();
    const refresh = deps.refreshTokens.generate(sessionId);
    const session = AuthSession.start({
      id: sessionId,
      userId: command.userId,
      refreshTokenHash: refresh.hash,
      now: deps.clock.now(),
      ttlMs: deps.settings.refreshTokenTtlMs,
      userAgent: command.userAgent ?? null,
      ip: request?.ip ?? null,
    });

    await deps.unitOfWork.run(async () => {
      await deps.sessions.save(session);
      await deps.auditTrail.record({
        actorType: "user",
        actorId: command.userId,
        action: "auth.session_started",
        entityType: "auth_session",
        entityId: sessionId,
        requestId: request?.requestId ?? null,
        ip: request?.ip ?? null,
        userAgent: command.userAgent ?? null,
      });
    });

    const access = await deps.accessTokens.issue({
      audience: "tenant",
      tenantId,
      userId: command.userId,
      sessionId,
      permissionVersion: command.permissionVersion,
    });
    return {
      sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  private async assertMaySignIn(tenantId: string, command: StartAuthSessionCommand) {
    const gate = this.deps.billingOnly;
    if (gate === undefined) return;
    const tenant = await gate.tenants.findById(tenantId);
    if (tenant?.billingOnly !== true) return;
    const grants = await gate.permissions.resolve(
      tenantId,
      command.userId,
      command.permissionVersion,
    );
    const billing =
      grants?.permissions.has("billing.view") === true ||
      grants?.permissions.has("billing.manage") === true;
    if (!billing) throw new TenantBillingOnlyError();
  }
}
