import type { IAuthSessionRepository } from "../../../domain/repositories/IAuthSessionRepository.js";
import type { ITenantUserRepository } from "../../../domain/repositories/ITenantUserRepository.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { Principal } from "../../authorization/Principal.js";
import { UserNotFoundError } from "../../errors/IdentityErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantSessions, SessionView } from "../../ports/ITenantSessions.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IUserMemberships } from "../../ports/IUserMemberships.js";

/** "Where am I signed in" for users, and signing other users out (sessions.revoke). */
export class SessionManagement {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      sessions: ITenantSessions;
      sessionRepository: IAuthSessionRepository;
      users: ITenantUserRepository;
      memberships: IUserMemberships;
      policy: AuthorizationPolicy;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  async mine(principal: Principal): Promise<(SessionView & { current: boolean })[]> {
    const sessions = await this.deps.unitOfWork.run(() =>
      this.deps.sessions.listActive(principal.userId, this.deps.clock.now()),
    );
    return sessions.map((s) => ({ ...s, current: s.id === principal.sessionId }));
  }

  /** Ends one of the caller's own sessions (unknown ids are ignored). */
  async revokeMine(principal: Principal, sessionId: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const session = await deps.sessionRepository.lockById(sessionId);
      if (session === null || session.userId !== principal.userId) return;
      session.revoke("logout", deps.clock.now());
      await deps.sessionRepository.save(session);
    });
  }

  /** Signs a user out everywhere (within the caller's branch scope for sessions.revoke). */
  async revokeAllFor(principal: Principal, userId: string): Promise<number> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const user = await deps.users.findById(userId);
      if (user === null) throw new UserNotFoundError();
      const branches = await deps.memberships.branchesOf(userId);
      const reachable = deps.policy.branchesFor(principal, "sessions.revoke");
      if (reachable !== "all" && !branches.some((b) => reachable.includes(b)))
        throw new UserNotFoundError();
      const count = await deps.sessions.revokeForUser(userId, "admin_revoked", deps.clock.now());
      const request = deps.requestContext.current();
      await deps.auditTrail.record({
        actorType: "user",
        actorId: principal.userId,
        action: "user.sessions_revoked",
        entityType: "user",
        entityId: userId,
        metadata: { count },
        requestId: request?.requestId ?? null,
        ip: request?.ip ?? null,
      });
      return count;
    });
  }
}
