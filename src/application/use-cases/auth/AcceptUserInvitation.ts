import { createHash } from "node:crypto";
import type { AuthenticationResult } from "../../dto/AuthenticationResult.js";
import { InvitationInvalidError } from "../../errors/StaffErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPasswordHasher } from "../../ports/IPasswordHasher.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantUserAccounts } from "../../ports/ITenantUserAccounts.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IUserInvitations } from "../../ports/IUserInvitations.js";
import { assertAcceptablePassword } from "../../services/PasswordPolicy.js";
import type { StartAuthSession } from "./StartAuthSession.js";

/**
 * A tenant user's first sign-in (the owner's welcome link; staff invitations in P1-5): checks
 * the one-time link, sets the password, activates the user and opens a session. Runs in the
 * tenant context of the request (X-Tenant).
 */
export class AcceptUserInvitation {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      invitations: IUserInvitations;
      users: ITenantUserAccounts;
      passwords: IPasswordHasher;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      startSession: StartAuthSession;
      clock: IClock;
    }>,
  ) {}

  async execute(
    token: string,
    password: string,
    userAgent: string | null,
  ): Promise<AuthenticationResult> {
    const { deps } = this;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const user = await deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const invitation = await deps.invitations.lockValid(tokenHash, now);
      if (invitation === null) throw new InvitationInvalidError();
      const account = await deps.users.lockById(invitation.userId);
      if (account === null || account.status === "disabled") throw new InvitationInvalidError();

      assertAcceptablePassword(password, account.email ?? "");
      await deps.users.activate(account.id, await deps.passwords.hash(password), now);
      await deps.users.recordLogin(account.id, now);
      await deps.invitations.markAccepted(invitation.id, now);
      const request = deps.requestContext.current();
      await deps.auditTrail.record({
        actorType: "user",
        actorId: account.id,
        action: "user.invitation_accepted",
        entityType: "user",
        entityId: account.id,
        requestId: request?.requestId ?? null,
        ip: request?.ip ?? null,
        userAgent,
      });
      return account;
    });
    return deps.startSession.execute({
      userId: user.id,
      permissionVersion: user.permissionVersion,
      userAgent,
    });
  }
}
