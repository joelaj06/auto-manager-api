import { createHash, randomBytes } from "node:crypto";
import { TenantUser } from "../../../domain/entities/TenantUser.js";
import type { ITenantUserRepository } from "../../../domain/repositories/ITenantUserRepository.js";
import { PhoneNumber } from "../../../domain/value-objects/PhoneNumber.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { EscalationGuard } from "../../authorization/EscalationGuard.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { OWNER_ROLE } from "../../authorization/tenantRoleTemplates.js";
import {
  IdentityRuleError,
  TenantRoleNotFoundError,
  UserExistsError,
  UserNotFoundError,
} from "../../errors/IdentityErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IBranches } from "../../ports/IBranches.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPermissionCache } from "../../ports/IPermissionCache.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantRoles } from "../../ports/ITenantRoles.js";
import type { ITenantSessions } from "../../ports/ITenantSessions.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IUserDirectory } from "../../ports/IUserDirectory.js";
import type { IUserInvitations } from "../../ports/IUserInvitations.js";
import type {
  IUserMemberships,
  RoleAssignment,
  RoleAssignmentView,
} from "../../ports/IUserMemberships.js";

export type UserView = Readonly<{
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: TenantUser["status"];
  isOwner: boolean;
  lastLoginAt: Date | null;
  branchIds: readonly string[];
  roles?: readonly RoleAssignmentView[];
}>;

export type InviteUserInput = Readonly<{
  name: string;
  email: string;
  phone?: string | null;
  branchIds: readonly string[];
  roles: readonly RoleAssignment[];
}>;

export type UserAdministrationSettings = Readonly<{ webAppUrl: string; invitationTtlMs: number }>;

/**
 * Tenant user management (docs/28, docs/16): list and view (within the caller's branch scope),
 * invite (emailed link), update, disable/enable and role assignment. Rules: nobody changes their
 * own access; the owner cannot be disabled or have roles changed; roles can only be assigned
 * within the caller's own permissions and branches. Changes that affect access bump the user's
 * permission version (and disabling ends every session).
 */
export class UserAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      tenantContext: ITenantContext;
      users: ITenantUserRepository;
      memberships: IUserMemberships;
      roles: ITenantRoles;
      branches: IBranches;
      invitations: IUserInvitations;
      sessions: ITenantSessions;
      organisation: IOrganisationSettings;
      directory: IUserDirectory;
      policy: AuthorizationPolicy;
      escalation: EscalationGuard;
      permissionCache: IPermissionCache;
      notifications: NotificationService;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      settings: UserAdministrationSettings;
    }>,
  ) {}

  async list(
    actor: Principal,
    query: Readonly<{
      status?: TenantUser["status"];
      search?: string;
      limit: number;
      before?: string;
    }>,
  ): Promise<UserView[]> {
    const { deps } = this;
    const branchIds = deps.policy.branchesFor(actor, "users.list");
    return deps.unitOfWork.run(async () => {
      const users = await deps.users.list({ ...query, branchIds, includeUserId: actor.userId });
      return Promise.all(users.map(async (u) => this.view(u, false)));
    });
  }

  async get(actor: Principal, id: string): Promise<UserView> {
    return this.deps.unitOfWork.run(async () => {
      const user = await this.reach(actor, id, "users.view");
      return this.view(user, true);
    });
  }

  async invite(actor: Principal, input: InviteUserInput, tenantSlug: string): Promise<string> {
    const { deps } = this;
    const email = input.email.trim().toLowerCase();
    const phone =
      input.phone === undefined || input.phone === null || input.phone.trim() === ""
        ? null
        : PhoneNumber.parse(input.phone).value;
    const token = randomBytes(32).toString("base64url");

    const user = await deps.unitOfWork.run(async () => {
      if (
        (await deps.users.findByEmail(email)) !== null ||
        (phone !== null && (await deps.users.findByPhone(phone)) !== null)
      ) {
        throw new UserExistsError();
      }
      await this.assertBranches(actor, "users.invite", input.branchIds);
      if (input.roles.length > 0) await this.assertAssignable(actor, input.roles);

      const created = TenantUser.invite({ id: deps.ids.next(), name: input.name, email, phone });
      await deps.users.save(created, actor.userId);
      await deps.memberships.setBranches(created.id, input.branchIds);
      if (input.roles.length > 0)
        await deps.memberships.setAssignments(created.id, input.roles, actor.userId);
      await deps.invitations.create({
        userId: created.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(deps.clock.now().getTime() + deps.settings.invitationTtlMs),
      });
      await this.audit(actor, "user.invited", created.id, {
        email,
        branchIds: input.branchIds,
        roles: input.roles,
      });
      return created;
    });
    await this.sendInvitation(user, token, tenantSlug, actor);
    return user.id;
  }

  async resendInvitation(actor: Principal, id: string, tenantSlug: string): Promise<void> {
    const { deps } = this;
    const token = randomBytes(32).toString("base64url");
    const user = await deps.unitOfWork.run(async () => {
      const found = await this.reach(actor, id, "users.invite");
      if (found.status !== "invited")
        throw new IdentityRuleError("CONTACT_REQUIRED", "This user has already joined");
      await deps.invitations.create({
        userId: found.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(deps.clock.now().getTime() + deps.settings.invitationTtlMs),
      });
      return found;
    });
    await this.sendInvitation(user, token, tenantSlug, actor);
  }

  async update(
    actor: Principal,
    id: string,
    changes: Readonly<{ name?: string; phone?: string | null; branchIds?: readonly string[] }>,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const user = await this.reach(actor, id, "users.update", true);
      if (changes.branchIds !== undefined) {
        if (id === actor.userId) {
          throw new IdentityRuleError(
            "CANNOT_CHANGE_OWN_ACCOUNT",
            "Ask another administrator to change your branches",
          );
        }
        await this.assertBranches(actor, "users.update", changes.branchIds);
        await deps.memberships.setBranches(id, changes.branchIds);
        user.bumpPermissionVersion();
      }
      user.update({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.phone === undefined
          ? {}
          : { phone: changes.phone === null ? null : PhoneNumber.parse(changes.phone).value }),
      });
      await deps.users.save(user);
      await this.audit(actor, "user.updated", id, changes);
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
  }

  async disable(actor: Principal, id: string, reason: string): Promise<void> {
    await this.changeStatus(
      actor,
      id,
      reason,
      (user) => user.disable(),
      "user.disabled",
      "disabled",
    );
  }

  async enable(actor: Principal, id: string, reason: string): Promise<void> {
    await this.changeStatus(actor, id, reason, (user) => user.enable(), "user.enabled", "active");
  }

  async setRoles(
    actor: Principal,
    id: string,
    assignments: readonly RoleAssignment[],
    reason: string | null,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      if (id === actor.userId) {
        throw new IdentityRuleError(
          "CANNOT_CHANGE_OWN_ACCOUNT",
          "You cannot change your own roles",
        );
      }
      const user = await this.reach(actor, id, "roles.assign", true);
      if (user.isOwner)
        throw new IdentityRuleError("OWNER_ROLE_PROTECTED", "The owner's roles cannot be changed");
      const before = await deps.memberships.assignmentsOf(id);
      await this.assertAssignable(actor, assignments);
      // A branch-scoped actor may only change assignments in branches they manage.
      const reachable = deps.policy.branchesFor(actor, "roles.assign");
      if (reachable !== "all") {
        const untouchable = before.filter(
          (a) => a.branchId === null || !reachable.includes(a.branchId),
        );
        const kept = assignments.filter(
          (a) => a.branchId === null || !reachable.includes(a.branchId),
        );
        if (JSON.stringify(untouchable.map(key).sort()) !== JSON.stringify(kept.map(key).sort())) {
          throw new IdentityRuleError(
            "BRANCH_OUT_OF_SCOPE",
            "You can only change roles in branches you manage",
          );
        }
      }
      await deps.memberships.setAssignments(id, assignments, actor.userId);
      user.bumpPermissionVersion();
      await deps.users.save(user);
      await this.audit(actor, "user.roles_changed", id, { before, after: assignments, reason });
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
  }

  // --- helpers ---

  /** Loads a user the actor may act on with `permission` (out-of-scope users look missing). */
  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<TenantUser> {
    const { deps } = this;
    const user = lock ? await deps.users.lockById(id) : await deps.users.findById(id);
    if (user === null) throw new UserNotFoundError();
    const reachable = deps.policy.branchesFor(actor, permission);
    if (reachable === "all" || id === actor.userId) return user;
    const branches = await deps.memberships.branchesOf(id);
    if (!branches.some((b) => reachable.includes(b))) throw new UserNotFoundError();
    return user;
  }

  private async assertBranches(
    actor: Principal,
    permission: PermissionKey,
    branchIds: readonly string[],
  ): Promise<void> {
    const { deps } = this;
    if (branchIds.length === 0)
      throw new IdentityRuleError("UNKNOWN_BRANCH", "Choose at least one branch");
    const existing = await deps.branches.existing(branchIds);
    if (existing.length !== new Set(branchIds).size)
      throw new IdentityRuleError("UNKNOWN_BRANCH", "Unknown branch");
    const reachable = deps.policy.branchesFor(actor, permission);
    if (reachable !== "all" && branchIds.some((b) => !reachable.includes(b))) {
      throw new IdentityRuleError("BRANCH_OUT_OF_SCOPE", "You can only use branches you manage");
    }
  }

  private async assertAssignable(
    actor: Principal,
    assignments: readonly RoleAssignment[],
  ): Promise<void> {
    const { deps } = this;
    const reachable = deps.policy.branchesFor(actor, "roles.assign");
    if (reachable !== "all" && assignments.some((a) => a.branchId === null)) {
      throw new IdentityRuleError(
        "BRANCH_OUT_OF_SCOPE",
        "Assign roles for a specific branch you manage",
      );
    }
    const branchIds = assignments.flatMap((a) => (a.branchId === null ? [] : [a.branchId]));
    if (branchIds.length > 0) await this.assertBranches(actor, "roles.assign", branchIds);
    for (const assignment of assignments) {
      const role = await deps.roles.findById(assignment.roleId);
      if (role === null) throw new TenantRoleNotFoundError();
      if (role.systemKey === OWNER_ROLE) {
        throw new IdentityRuleError("OWNER_ROLE_PROTECTED", "The Owner role cannot be assigned");
      }
      deps.escalation.assertWithinOwn(actor, role.grants, assignment.branchId);
    }
  }

  private async changeStatus(
    actor: Principal,
    id: string,
    reason: string,
    change: (user: TenantUser) => void,
    action: string,
    directoryStatus: "active" | "disabled",
  ): Promise<void> {
    const { deps } = this;
    if (id === actor.userId) {
      throw new IdentityRuleError(
        "CANNOT_CHANGE_OWN_ACCOUNT",
        "You cannot disable or enable yourself",
      );
    }
    const user = await deps.unitOfWork.run(async () => {
      const found = await this.reach(actor, id, "users.disable", true);
      change(found);
      await deps.users.save(found);
      if (found.status === "disabled")
        await deps.sessions.revokeForUser(id, "user_disabled", deps.clock.now());
      await this.audit(actor, action, id, { reason });
      return found;
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
    if (user.status !== "invited") {
      await deps.directory.upsert({
        tenantId: deps.tenantContext.currentTenantId().value,
        tenantUserId: user.id,
        email: user.email,
        phone: user.phone,
        status: directoryStatus,
      });
    }
  }

  private async view(user: TenantUser, withRoles: boolean): Promise<UserView> {
    const s = user.snapshot();
    return {
      id: s.id,
      name: s.name,
      email: s.email,
      phone: s.phone,
      status: s.status,
      isOwner: s.isOwner,
      lastLoginAt: s.lastLoginAt,
      branchIds: await this.deps.memberships.branchesOf(s.id),
      ...(withRoles ? { roles: await this.deps.memberships.assignmentsOf(s.id) } : {}),
    };
  }

  private async sendInvitation(
    user: TenantUser,
    token: string,
    tenantSlug: string,
    actor: Principal,
  ): Promise<void> {
    const { deps } = this;
    if (user.email === null) return;
    const organisation = await deps.unitOfWork.run(() => deps.organisation.get());
    const inviter = await deps.unitOfWork.run(() => deps.users.findById(actor.userId));
    await deps.notifications.sendEmail({
      to: user.email,
      template: "tenant.user_invitation",
      data: {
        name: user.name,
        businessName: organisation.name,
        invitedBy: inviter?.name ?? null,
        acceptUrl: `${deps.settings.webAppUrl.replace(/\/$/, "")}/${tenantSlug}/accept-invitation#token=${token}`,
        expiresInHours: Math.round(deps.settings.invitationTtlMs / 3_600_000),
      },
      idempotencyKey: `user-invitation:${createHash("sha256").update(token).digest("hex")}`,
      tenantId: deps.tenantContext.currentTenantId().value,
    });
  }

  private async audit(actor: Principal, action: string, userId: string, details: unknown) {
    const request = this.deps.requestContext.current();
    await this.deps.auditTrail.record({
      actorType: "user",
      actorId: actor.userId,
      action,
      entityType: "user",
      entityId: userId,
      after: details,
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }
}

const key = (a: RoleAssignment) => `${a.roleId}@${a.branchId ?? "*"}`;
