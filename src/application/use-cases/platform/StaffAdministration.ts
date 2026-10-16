import { createHash, randomBytes } from "node:crypto";
import { StaffAccount } from "../../../domain/entities/StaffAccount.js";
import type { IStaffAccountRepository } from "../../../domain/repositories/IStaffAccountRepository.js";
import {
  isPlatformPermissionKey,
  PLATFORM_PERMISSION_CATALOG,
  STAFF_PERMISSION_KEYS,
  SUPER_ADMIN_ROLE,
} from "../../authorization/platformPermissionCatalog.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import {
  RoleNotFoundError,
  StaffAlreadyExistsError,
  StaffNotFoundError,
  StaffRuleViolationError,
} from "../../errors/StaffErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type {
  CustomRoleInput,
  IPlatformRoles,
  PlatformRoleView,
} from "../../ports/IPlatformRoles.js";
import type { IPlatformSessions } from "../../ports/IPlatformSessions.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IStaffInvitations } from "../../ports/IStaffInvitations.js";
import type { ApprovalExecutor, ApprovalWorkflow } from "./ApprovalWorkflow.js";

export type StaffView = Readonly<{
  id: string;
  email: string;
  name: string;
  status: StaffAccount["status"];
  mfaEnrolled: boolean;
  lastLoginAt: Date | null;
  roles: readonly Readonly<{ id: string; name: string; systemKey: string | null }>[];
}>;

export type StaffInvitationResult = Readonly<{
  userId: string;
  expiresAt: Date;
  /** Only returned to the bootstrap command (no acting staff member); otherwise sent by email. */
  invitationToken?: string;
}>;

export type RoleChangeResult =
  Readonly<{ status: "applied" }> | Readonly<{ status: "pending_approval"; approvalId: string }>;

export type StaffAdministrationSettings = Readonly<{
  invitationTtlMs: number;
  /** Console origin for invitation links, e.g. https://admin.example.com */
  consoleUrl: string;
}>;

export const SET_ROLES_ACTION = "platform.staff.set_roles";

/**
 * Staff administration (docs/27 §3.18): invitations, disable/enable, MFA reset, role assignment
 * and custom roles. Rules:
 * - nobody changes their own account or roles here;
 * - the last active Super Admin cannot be disabled or demoted;
 * - granting Super Admin needs a second Super Admin's approval (four-eyes);
 * - non-Super Admins can only assign or define roles within their own permissions;
 * - every change needs a reason and is audited; disabling or resetting MFA ends all sessions.
 */
export class StaffAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      accounts: IStaffAccountRepository;
      roles: IPlatformRoles;
      invitations: IStaffInvitations;
      sessions: IPlatformSessions;
      approvals: ApprovalWorkflow;
      notifications: NotificationService;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      settings: StaffAdministrationSettings;
    }>,
  ) {}

  /** The executor that applies an approved role change; registered with the workflow. */
  roleChangeExecutor(): ApprovalExecutor {
    return {
      action: SET_ROLES_ACTION,
      approverSystemRole: SUPER_ADMIN_ROLE,
      execute: async (payload, context) => {
        const userId = String(payload.userId);
        const roleIds = (payload.roleIds as unknown[]).map(String);
        await this.applyRoles(
          userId,
          roleIds,
          context.approvedBy,
          `approval ${context.approvalId}`,
        );
        return { userId, roleIds };
      },
    };
  }

  async list(): Promise<StaffView[]> {
    const accounts = await this.deps.accounts.list();
    return Promise.all(accounts.map((account) => this.view(account)));
  }

  /**
   * Invites a staff member. `actor` null is the bootstrap command (first Super Admin, recovery):
   * the token is returned instead of only emailed, and Super Admin may be granted directly.
   */
  async invite(params: {
    email: string;
    name: string;
    roleIds: readonly string[];
    actor: PlatformPrincipal | null;
    /** Invites a reseller's console user instead (no roles; docs/29 §2). */
    partnerId?: string | null;
  }): Promise<StaffInvitationResult> {
    const { deps } = this;
    const partnerId = params.partnerId ?? null;
    if (partnerId !== null && params.roleIds.length > 0) {
      throw new StaffRuleViolationError(
        "PARTNER_USER_NO_ROLES",
        "Partner users get their partner's capabilities, not staff roles",
      );
    }
    const roles = await this.loadRoles(params.roleIds);
    if (params.actor !== null) {
      if (roles.some((role) => role.systemKey === SUPER_ADMIN_ROLE)) {
        throw new StaffRuleViolationError(
          "SUPER_ADMIN_NEEDS_APPROVAL",
          "Invite with other roles, then request Super Admin through an approval",
        );
      }
      this.assertWithinOwnPermissions(params.actor, roles);
    }

    const token = randomBytes(32).toString("base64url");
    const result = await deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const email = params.email.trim().toLowerCase();
      let account = await deps.accounts.findByEmail(email);
      if (account !== null && (account.status !== "invited" || account.partnerId !== partnerId))
        throw new StaffAlreadyExistsError();
      if (account === null) {
        account = StaffAccount.invite({ id: deps.ids.next(), email, name: params.name, partnerId });
        await deps.accounts.save(account, params.actor?.userId ?? null);
      } else {
        await deps.invitations.revokeOpen(account.id, now);
      }
      await deps.roles.setUserRoles(
        account.id,
        roles.map((r) => r.id),
        params.actor?.userId ?? null,
      );
      const expiresAt = new Date(now.getTime() + deps.settings.invitationTtlMs);
      await deps.invitations.create({
        id: deps.ids.next(),
        userId: account.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        invitedBy: params.actor?.userId ?? null,
        expiresAt,
      });
      await this.audit(
        params.actor,
        partnerId === null ? "staff.invited" : "partner_user.invited",
        account.id,
        null,
        { email, roles: roles.map((r) => r.name), partnerId },
      );
      return { account, expiresAt };
    });

    await deps.notifications.sendEmail({
      to: result.account.email,
      template: "platform.staff_invitation",
      data: {
        name: result.account.name,
        invitedBy: params.actor?.name ?? null,
        acceptUrl: `${deps.settings.consoleUrl.replace(/\/$/, "")}/accept-invitation#token=${token}`,
        expiresInHours: Math.round(deps.settings.invitationTtlMs / 3_600_000),
      },
      idempotencyKey: `staff-invitation:${createHash("sha256").update(token).digest("hex")}`,
    });
    return {
      userId: result.account.id,
      expiresAt: result.expiresAt,
      ...(params.actor === null ? { invitationToken: token } : {}),
    };
  }

  async disable(userId: string, actor: PlatformPrincipal, reason: string): Promise<void> {
    await this.changeAccount(userId, actor, reason, "staff.disabled", async (account) => {
      await this.assertNotLastSuperAdmin(account.id);
      account.disable();
      await this.deps.sessions.revokeAllForUser(account.id, "user_disabled", this.deps.clock.now());
    });
  }

  async enable(userId: string, actor: PlatformPrincipal, reason: string): Promise<void> {
    await this.changeAccount(userId, actor, reason, "staff.enabled", (account) => {
      account.enable();
      return Promise.resolve();
    });
  }

  async resetMfa(userId: string, actor: PlatformPrincipal, reason: string): Promise<void> {
    await this.changeAccount(userId, actor, reason, "staff.mfa_reset", async (account) => {
      account.resetMfa();
      await this.deps.sessions.revokeAllForUser(account.id, "admin_revoked", this.deps.clock.now());
    });
  }

  async setRoles(
    userId: string,
    roleIds: readonly string[],
    actor: PlatformPrincipal,
    reason: string,
  ): Promise<RoleChangeResult> {
    if (userId === actor.userId) {
      throw new StaffRuleViolationError(
        "CANNOT_CHANGE_OWN_ACCOUNT",
        "You cannot change your own roles",
      );
    }
    const target = await this.deps.accounts.findById(userId);
    if (target === null) throw new StaffNotFoundError();
    if (target.isPartnerUser) {
      throw new StaffRuleViolationError(
        "PARTNER_USER_NO_ROLES",
        "Partner users get their partner's capabilities, not staff roles",
      );
    }
    const roles = await this.loadRoles(roleIds);
    this.assertWithinOwnPermissions(actor, roles);
    const current = await this.deps.roles.rolesOfUser(userId);
    const grantsSuperAdmin =
      roles.some((r) => r.systemKey === SUPER_ADMIN_ROLE) &&
      !current.some((r) => r.systemKey === SUPER_ADMIN_ROLE);

    if (grantsSuperAdmin) {
      const account = await this.deps.accounts.findById(userId);
      if (account === null) throw new StaffNotFoundError();
      const approvalId = await this.deps.approvals.request({
        action: SET_ROLES_ACTION,
        payload: { userId, roleIds: roles.map((r) => r.id) },
        summary: `Give ${account.email} the roles: ${roles.map((r) => r.name).join(", ")}`,
        reason,
        requestedBy: actor.userId,
      });
      return { status: "pending_approval", approvalId };
    }
    await this.applyRoles(
      userId,
      roles.map((r) => r.id),
      actor.userId,
      reason,
    );
    return { status: "applied" };
  }

  listRoles(): Promise<PlatformRoleView[]> {
    return this.deps.roles.list();
  }

  listPermissions() {
    return STAFF_PERMISSION_KEYS.map((key) => ({
      key,
      description: PLATFORM_PERMISSION_CATALOG[key].description,
      sensitive: PLATFORM_PERMISSION_CATALOG[key].sensitive === true,
      fourEyes: PLATFORM_PERMISSION_CATALOG[key].fourEyes === true,
    }));
  }

  async createRole(input: CustomRoleInput, actor: PlatformPrincipal): Promise<string> {
    this.assertRoleInput(input, actor);
    return this.deps.unitOfWork.run(async () => {
      const id = await this.deps.roles.createCustom(input, actor.userId);
      await this.audit(actor, "staff_role.created", null, null, { roleId: id, ...input });
      return id;
    });
  }

  async updateRole(id: string, input: CustomRoleInput, actor: PlatformPrincipal): Promise<void> {
    this.assertRoleInput(input, actor);
    await this.deps.unitOfWork.run(async () => {
      const role = await this.deps.roles.findById(id);
      if (role === null) throw new RoleNotFoundError();
      if (role.systemKey !== null) {
        throw new StaffRuleViolationError(
          "SYSTEM_ROLE_LOCKED",
          "System roles are updated by releases and cannot be edited",
        );
      }
      await this.deps.roles.updateCustom(id, input);
      // Holders get the new permissions on their next token.
      for (const userId of await this.deps.roles.userIdsWithRole(id)) {
        const account = await this.deps.accounts.lockById(userId);
        if (account === null) continue;
        account.bumpPermissionVersion();
        await this.deps.accounts.save(account);
      }
      await this.audit(actor, "staff_role.updated", null, null, {
        roleId: id,
        before: role,
        after: input,
      });
    });
  }

  // --- helpers ---

  private async applyRoles(
    userId: string,
    roleIds: readonly string[],
    actorId: string,
    reason: string,
  ) {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const account = await deps.accounts.lockById(userId);
      if (account === null) throw new StaffNotFoundError();
      const before = await deps.roles.rolesOfUser(userId);
      const roles = await this.loadRoles(roleIds);
      if (
        before.some((r) => r.systemKey === SUPER_ADMIN_ROLE) &&
        !roles.some((r) => r.systemKey === SUPER_ADMIN_ROLE)
      ) {
        await this.assertNotLastSuperAdmin(userId);
      }
      await deps.roles.setUserRoles(
        userId,
        roles.map((r) => r.id),
        actorId,
      );
      account.bumpPermissionVersion();
      await deps.accounts.save(account);
      await deps.audit.record({
        actorType: "platform_staff",
        actorId,
        action: "staff.roles_changed",
        entityType: "platform_user",
        entityId: userId,
        reason,
        before: before.map((r) => r.name),
        after: roles.map((r) => r.name),
        ...this.meta(),
      });
    });
  }

  private async changeAccount(
    userId: string,
    actor: PlatformPrincipal,
    reason: string,
    action: string,
    change: (account: StaffAccount) => Promise<void>,
  ): Promise<void> {
    if (userId === actor.userId) {
      throw new StaffRuleViolationError(
        "CANNOT_CHANGE_OWN_ACCOUNT",
        "Ask another administrator to do this",
      );
    }
    await this.deps.unitOfWork.run(async () => {
      const account = await this.deps.accounts.lockById(userId);
      if (account === null) throw new StaffNotFoundError();
      const before = account.status;
      await change(account);
      await this.deps.accounts.save(account);
      await this.audit(actor, action, account.id, reason, { before, after: account.status });
    });
  }

  private async assertNotLastSuperAdmin(userId: string): Promise<void> {
    const supers = await this.deps.roles.activeUsersWithSystemRole(SUPER_ADMIN_ROLE);
    if (supers.length <= 1 && supers.some((s) => s.id === userId)) {
      throw new StaffRuleViolationError(
        "LAST_SUPER_ADMIN",
        "The last active Super Admin must stay",
      );
    }
  }

  private async loadRoles(roleIds: readonly string[]): Promise<PlatformRoleView[]> {
    const roles: PlatformRoleView[] = [];
    for (const id of new Set(roleIds)) {
      const role = await this.deps.roles.findById(id);
      if (role === null) throw new RoleNotFoundError();
      roles.push(role);
    }
    return roles;
  }

  /** Escalation prevention: you cannot hand out (or define) more than you hold yourself. */
  private assertWithinOwnPermissions(actor: PlatformPrincipal, roles: readonly PlatformRoleView[]) {
    if (actor.systemRoles.has(SUPER_ADMIN_ROLE)) return;
    for (const role of roles) {
      if (!actor.hasAll(role.permissions)) {
        throw new StaffRuleViolationError(
          "ROLE_EXCEEDS_OWN_PERMISSIONS",
          `You cannot grant "${role.name}": it includes permissions you do not have`,
        );
      }
    }
  }

  private assertRoleInput(input: CustomRoleInput, actor: PlatformPrincipal): void {
    const unknown = input.permissions.filter(
      (key) => !isPlatformPermissionKey(key) || !STAFF_PERMISSION_KEYS.includes(key),
    );
    if (unknown.length > 0) {
      throw new StaffRuleViolationError(
        "UNKNOWN_PERMISSION",
        `Unknown permissions: ${unknown.join(", ")}`,
      );
    }
    this.assertWithinOwnPermissions(actor, [
      {
        id: "",
        systemKey: null,
        name: input.name,
        description: "",
        permissions: input.permissions,
      },
    ]);
  }

  private async view(account: StaffAccount): Promise<StaffView> {
    const roles = await this.deps.roles.rolesOfUser(account.id);
    const snapshot = account.snapshot();
    return {
      id: account.id,
      email: account.email,
      name: account.name,
      status: account.status,
      mfaEnrolled: account.mfaEnrolled,
      lastLoginAt: snapshot.lastLoginAt,
      roles: roles.map(({ id, name, systemKey }) => ({ id, name, systemKey })),
    };
  }

  private async audit(
    actor: PlatformPrincipal | null,
    action: string,
    userId: string | null,
    reason: string | null,
    details: Record<string, unknown>,
  ) {
    await this.deps.audit.record({
      actorType:
        actor === null ? "system" : actor.partnerId === null ? "platform_staff" : "partner",
      actorId: actor?.userId ?? null,
      action,
      entityType: userId === null ? "platform_role" : "platform_user",
      entityId: userId,
      reason,
      after: details,
      ...this.meta(),
    });
  }

  private meta() {
    const request = this.deps.requestContext.current();
    return { requestId: request?.requestId ?? null, ip: request?.ip ?? null };
  }
}
