import type { ITenantUserRepository } from "../../../domain/repositories/ITenantUserRepository.js";
import type { EscalationGuard } from "../../authorization/EscalationGuard.js";
import type { Principal } from "../../authorization/Principal.js";
import { OWNER_ROLE } from "../../authorization/tenantRoleTemplates.js";
import { IdentityRuleError, TenantRoleNotFoundError } from "../../errors/IdentityErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IPermissionCache } from "../../ports/IPermissionCache.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type {
  ITenantRoles,
  RoleGrant,
  TenantPermissionView,
  TenantRoleView,
} from "../../ports/ITenantRoles.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IUserMemberships } from "../../ports/IUserMemberships.js";

export type RoleInput = Readonly<{
  name: string;
  description: string;
  grants: readonly RoleGrant[];
}>;

/**
 * Tenant roles (docs/28): system roles are read-only and kept in sync by releases; tenants create
 * custom roles (optionally cloned from a system role), edit and delete them. Nobody can define a
 * role with more than they hold. Editing a role re-evaluates its holders at once.
 */
export class RoleAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      roles: ITenantRoles;
      users: ITenantUserRepository;
      memberships: IUserMemberships;
      escalation: EscalationGuard;
      permissionCache: IPermissionCache;
      tenantContext: ITenantContext;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  list(): Promise<TenantRoleView[]> {
    return this.deps.unitOfWork.run(() => this.deps.roles.list());
  }

  permissions(): Promise<TenantPermissionView[]> {
    return this.deps.unitOfWork.run(() => this.deps.roles.permissions());
  }

  async get(id: string): Promise<TenantRoleView> {
    const role = await this.deps.unitOfWork.run(() => this.deps.roles.findById(id));
    if (role === null) throw new TenantRoleNotFoundError();
    return role;
  }

  async create(
    actor: Principal,
    input: RoleInput & { basedOnRoleId?: string | null },
  ): Promise<string> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      let grants = input.grants;
      if (input.basedOnRoleId !== undefined && input.basedOnRoleId !== null) {
        const source = await deps.roles.findById(input.basedOnRoleId);
        if (source === null) throw new TenantRoleNotFoundError();
        if (grants.length === 0) grants = source.grants;
      }
      await this.validate(actor, { ...input, grants });
      const id = await deps.roles.create({
        name: input.name.trim(),
        description: input.description,
        grants,
        basedOnRoleId: input.basedOnRoleId ?? null,
        createdBy: actor.userId,
      });
      await this.audit(actor, "role.created", id, { name: input.name, grants });
      return id;
    });
  }

  async update(actor: Principal, id: string, input: RoleInput): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const role = await this.customRole(id);
      await this.validate(actor, input, id);
      await deps.roles.update(id, {
        name: input.name.trim(),
        description: input.description,
        grants: input.grants,
      });
      // Holders get the new permissions on their next request.
      for (const userId of await deps.memberships.holdersOf(id)) {
        const user = await deps.users.lockById(userId);
        if (user === null) continue;
        user.bumpPermissionVersion();
        await deps.users.save(user);
      }
      await this.audit(actor, "role.updated", id, { before: role.grants, after: input.grants });
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
  }

  async remove(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const role = await this.customRole(id);
      if (role.holders > 0) {
        throw new IdentityRuleError(
          "ROLE_IN_USE",
          `${role.holders} user(s) still hold this role; reassign them first`,
        );
      }
      await deps.roles.softDelete(id);
      await this.audit(actor, "role.deleted", id, { name: role.name });
    });
  }

  private async customRole(id: string): Promise<TenantRoleView> {
    const role = await this.deps.roles.findById(id);
    if (role === null) throw new TenantRoleNotFoundError();
    if (role.isSystem) {
      throw new IdentityRuleError(
        "SYSTEM_ROLE_LOCKED",
        "System roles cannot be changed; clone one into a custom role",
      );
    }
    return role;
  }

  private async validate(actor: Principal, input: RoleInput, exceptId?: string): Promise<void> {
    const { deps } = this;
    if (await deps.roles.nameTaken(input.name.trim(), exceptId)) {
      throw new IdentityRuleError("ROLE_NAME_TAKEN", "A role with this name already exists");
    }
    if (input.name.trim().toLowerCase() === OWNER_ROLE) {
      throw new IdentityRuleError("OWNER_ROLE_PROTECTED", "This name is reserved");
    }
    deps.escalation.assertValidGrants(input.grants, await deps.roles.permissions());
    deps.escalation.assertWithinOwn(actor, input.grants, null);
  }

  private async audit(
    actor: Principal,
    action: string,
    roleId: string,
    details: Record<string, unknown>,
  ) {
    const request = this.deps.requestContext.current();
    await this.deps.auditTrail.record({
      actorType: "user",
      actorId: actor.userId,
      action,
      entityType: "role",
      entityId: roleId,
      after: details,
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }
}
