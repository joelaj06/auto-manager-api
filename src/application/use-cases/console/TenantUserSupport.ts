import type { TenantUser } from "../../../domain/entities/TenantUser.js";
import type { ITenantUserRepository } from "../../../domain/repositories/ITenantUserRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPermissionCache } from "../../ports/IPermissionCache.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { ITenantSessions } from "../../ports/ITenantSessions.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IUserDirectory } from "../../ports/IUserDirectory.js";
import type { TenantSignIn } from "../identity/TenantSignIn.js";
import type { ApprovalExecutor, ApprovalWorkflow } from "../platform/ApprovalWorkflow.js";
import { recordStaffAction } from "./consoleAudit.js";

export const RECOVER_OWNER_ACTION = "users.recover_owner";

export class TenantUserNotFoundError extends ApplicationError {
  readonly code = "TENANT_USER_NOT_FOUND";
  constructor() {
    super("User not found in this tenant");
  }
}

export class UserSupportError extends ApplicationError {
  constructor(
    readonly code: "NO_EMAIL" | "EMAIL_TAKEN" | "NOT_OWNER",
    message: string,
  ) {
    super(message);
  }
}

/** What support sees of a tenant user: no business data, no secrets. */
export type SupportUserView = Readonly<{
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  isOwner: boolean;
  locked: boolean;
  lastLoginAt: Date | null;
}>;

export type UserSupportAction = "reset_password" | "unlock" | "force_logout" | "disable" | "enable";

/**
 * Users & access support (docs/27 §3.7): find a person across tenants (the user directory), see
 * a tenant's users (no business data), and help them — send a password reset code, lift a
 * lockout, sign them out everywhere, disable or enable them. Owner recovery gives an owner who
 * lost access a new sign-in email after identity checks, and needs a Super Admin's approval
 * (four-eyes). Every action is in the platform audit log and the tenant's, with staff as actor.
 */
export class TenantUserSupport {
  constructor(
    private readonly deps: Readonly<{
      directory: ITenantDirectory;
      userDirectory: IUserDirectory;
      tenantContext: ITenantContext;
      tenantUnitOfWork: IUnitOfWork;
      users: ITenantUserRepository;
      sessions: ITenantSessions;
      tenantAudit: IAuditTrail;
      permissionCache: IPermissionCache;
      signIn: TenantSignIn;
      approvals: ApprovalWorkflow;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  /** Recovery runs once a Super Admin approves it. */
  executor(): ApprovalExecutor {
    return {
      action: RECOVER_OWNER_ACTION,
      approverSystemRole: "super_admin",
      execute: async (payload, context) => {
        const tenantId = String(payload.tenantId);
        const email = String(payload.newEmail);
        await this.inTenant(tenantId, async () => {
          const owner = (await this.deps.users.list({ branchIds: "all", limit: 500 })).find(
            (u) => u.isOwner,
          );
          if (owner === undefined)
            throw new UserSupportError("NOT_OWNER", "The tenant has no owner");
          const taken = await this.deps.users.findByEmail(email.trim().toLowerCase());
          if (taken !== null && taken.id !== owner.id)
            throw new UserSupportError("EMAIL_TAKEN", "Another user of this tenant has this email");
          const locked = (await this.deps.users.lockById(owner.id))!;
          const before = locked.email;
          locked.changeEmail(email);
          await this.deps.users.save(locked);
          await this.deps.sessions.revokeForUser(locked.id, "admin_revoked", this.deps.clock.now());
          await this.tenantAudit(context.approvedBy, "user.owner_recovered", locked.id, {
            from: before,
            to: locked.email,
            approval: context.approvalId,
          });
          await this.deps.userDirectory.upsert({
            tenantId,
            tenantUserId: locked.id,
            email: locked.email,
            phone: locked.phone,
            status: "active",
          });
        });
        this.deps.permissionCache.forgetTenant(tenantId);
        // The owner sets a new password with the code sent to the new address.
        await this.deps.tenantContext.runAs(TenantId.from(tenantId), () =>
          this.deps.signIn.requestPasswordReset(email),
        );
        return { tenantId, email: email.trim().toLowerCase() };
      },
    };
  }

  /** Who a person is across tenants (email or phone). */
  async search(
    identifier: string,
  ): Promise<
    Readonly<{ tenantId: string; slug: string; tenantName: string; user: SupportUserView | null }>[]
  > {
    const kind = identifier.includes("@") ? "email" : "phone";
    const value =
      kind === "email" ? identifier.trim().toLowerCase() : identifier.replace(/\s/g, "");
    const tenants = await this.deps.userDirectory.tenantsFor(kind, value);
    const found = [];
    for (const t of tenants) {
      const user = await this.inTenant(t.tenantId, () =>
        kind === "email" ? this.deps.users.findByEmail(value) : this.deps.users.findByPhone(value),
      );
      found.push({
        tenantId: t.tenantId,
        slug: t.slug,
        tenantName: t.name,
        user: user === null ? null : this.view(user),
      });
    }
    return found;
  }

  async users(tenantId: string): Promise<SupportUserView[]> {
    await this.assertTenant(tenantId);
    const users = await this.inTenant(tenantId, () =>
      this.deps.users.list({ branchIds: "all", limit: 500 }),
    );
    return users.map((u) => this.view(u));
  }

  async act(
    tenantId: string,
    userId: string,
    action: UserSupportAction,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<SupportUserView> {
    const { deps } = this;
    await this.assertTenant(tenantId);
    const now = deps.clock.now();
    let resetTo: string | null = null;
    const user = await this.inTenant(tenantId, async () => {
      const u = await deps.users.lockById(userId);
      if (u === null) throw new TenantUserNotFoundError();
      switch (action) {
        case "reset_password":
          if (u.email === null)
            throw new UserSupportError(
              "NO_EMAIL",
              "This user has no email to send a reset code to",
            );
          resetTo = u.email;
          break;
        case "unlock":
          u.unlock();
          break;
        case "force_logout":
          u.bumpPermissionVersion();
          await deps.sessions.revokeForUser(u.id, "admin_revoked", now);
          break;
        case "disable":
          u.disable();
          await deps.sessions.revokeForUser(u.id, "user_disabled", now);
          break;
        case "enable":
          u.enable();
          break;
      }
      await deps.users.save(u);
      await this.tenantAudit(actor.userId, `user.support_${action}`, u.id, { reason });
      if (action === "disable" || action === "enable")
        await deps.userDirectory.upsert({
          tenantId,
          tenantUserId: u.id,
          email: u.email,
          phone: u.phone,
          status: action === "disable" ? "disabled" : "active",
        });
      return u;
    });
    deps.permissionCache.forgetTenant(tenantId);
    if (resetTo !== null) {
      const email = resetTo;
      await deps.tenantContext.runAs(TenantId.from(tenantId), () =>
        deps.signIn.requestPasswordReset(email),
      );
    }
    await deps.unitOfWork.run(() =>
      recordStaffAction(deps, actor, {
        action: `users.${action}`,
        entityType: "tenant_user",
        entityId: userId,
        targetTenantId: tenantId,
        reason,
      }),
    );
    return this.view(user);
  }

  /** Owner recovery: identity checks recorded, a Super Admin approves (four-eyes). */
  async requestOwnerRecovery(
    tenantId: string,
    input: Readonly<{
      newEmail: string;
      identityChecks: string;
      reason: string;
      ticket?: string | null;
    }>,
    actor: PlatformPrincipal,
  ): Promise<string> {
    const tenant = await this.deps.directory.findById(tenantId);
    if (tenant === null) throw new TenantNotFoundForStaffError();
    return this.deps.approvals.request({
      action: RECOVER_OWNER_ACTION,
      payload: {
        tenantId,
        newEmail: input.newEmail.trim().toLowerCase(),
        identityChecks: input.identityChecks.trim(),
      },
      summary: `Owner recovery for ${tenant.slug}: new sign-in email ${input.newEmail.trim().toLowerCase()}`,
      reason: input.reason,
      ticket: input.ticket ?? null,
      targetTenantId: tenantId,
      requestedBy: actor.userId,
    });
  }

  private async assertTenant(tenantId: string): Promise<void> {
    if ((await this.deps.directory.findById(tenantId)) === null)
      throw new TenantNotFoundForStaffError();
  }

  private inTenant<T>(tenantId: string, body: () => Promise<T>): Promise<T> {
    return this.deps.tenantContext.runAs(TenantId.from(tenantId), () =>
      this.deps.tenantUnitOfWork.run(body),
    );
  }

  private async tenantAudit(
    staffId: string,
    action: string,
    userId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    const request = this.deps.requestContext.current();
    await this.deps.tenantAudit.record({
      actorType: "platform_staff",
      actorId: staffId,
      action,
      entityType: "user",
      entityId: userId,
      after,
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }

  private view(u: TenantUser): SupportUserView {
    const s = u.snapshot();
    return {
      id: s.id,
      name: s.name,
      email: s.email,
      phone: s.phone,
      status: s.status,
      isOwner: s.isOwner,
      locked: u.isLocked(this.deps.clock.now()),
      lastLoginAt: s.lastLoginAt,
    };
  }
}
