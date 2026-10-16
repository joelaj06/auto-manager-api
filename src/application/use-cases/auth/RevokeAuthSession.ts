import type { SessionRevocationReason } from "../../../domain/entities/AuthSession.js";
import type { IAuthSessionRepository } from "../../../domain/repositories/IAuthSessionRepository.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export type RevokeAuthSessionCommand = Readonly<{
  sessionId: string;
  reason: SessionRevocationReason;
  /** The user performing the revocation (the owner on logout, an admin otherwise). */
  actorId: string;
}>;

/**
 * Ends a session: its refresh token stops working at once. Access tokens already issued stay
 * valid until they expire (at most ACCESS_TOKEN_TTL_SECONDS); disabling a user or changing their
 * roles bumps the permission version, which rejects those tokens immediately.
 * Idempotent; unknown sessions are ignored. Runs in the current tenant context.
 */
export class RevokeAuthSession {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      sessions: IAuthSessionRepository;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  async execute(command: RevokeAuthSessionCommand): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const session = await deps.sessions.lockById(command.sessionId);
      if (session === null || session.revocationReason !== null) return;

      session.revoke(command.reason, deps.clock.now());
      await deps.sessions.save(session);
      const request = deps.requestContext.current();
      await deps.auditTrail.record({
        actorType: "user",
        actorId: command.actorId,
        action: "auth.session_revoked",
        entityType: "auth_session",
        entityId: session.id,
        metadata: { reason: command.reason, userId: session.userId },
        requestId: request?.requestId ?? null,
        ip: request?.ip ?? null,
      });
    });
  }
}
