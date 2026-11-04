import { createHash, randomBytes } from "node:crypto";
import {
  checkKeyExpiry,
  formatApiKey,
  IntegrationRuleError,
  MAX_API_KEYS,
  tenantOfApiKey,
} from "../../../domain/integrations/Integrations.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import {
  API_KEY_SCOPES,
  PERMISSION_CATALOG,
  type PermissionKey,
} from "../../authorization/permissionCatalog.js";
import { Principal, type PermissionGrant } from "../../authorization/Principal.js";
import { assertTenantUsable } from "../../authorization/TenantAccessRules.js";
import { InvalidAccessTokenError } from "../../errors/AuthErrors.js";
import { ApiKeyNotFoundError } from "../../errors/IntegrationErrors.js";
import { BranchDeactivatedError, TenantMismatchError } from "../../errors/TenantErrors.js";
import type { IApiKeys } from "../../ports/IApiKeys.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory, TenantSummary } from "../../ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { EnterpriseGate } from "./EnterpriseGate.js";

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/**
 * A business's API keys (decisions 523–524). A key acts as the user who made it, narrowed to its
 * scopes, so it can never do what that user cannot, and it stops when they are disabled. It is
 * shown once and kept only as a hash.
 */
export class ApiKeys {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      keys: IApiKeys;
      gate: EnterpriseGate;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  scopes() {
    return API_KEY_SCOPES.map((key) => ({
      key,
      description: PERMISSION_CATALOG[key].description,
    }));
  }

  list(includeRevoked: boolean) {
    return this.deps.unitOfWork.run(() => this.deps.keys.list(includeRevoked));
  }

  async create(
    actor: Principal,
    input: Readonly<{ name: string; scopes: readonly string[]; expiresAt?: Date | null }>,
  ) {
    const { deps } = this;
    await deps.gate.require(actor.tenantId);
    if (actor.support !== null)
      throw new IntegrationRuleError("Support access cannot make API keys");
    const now = deps.clock.now();
    const expiresAt = input.expiresAt ?? null;
    checkKeyExpiry(expiresAt, now);
    const scopes = [...new Set(input.scopes)].sort() as PermissionKey[];
    const allowed = new Set<string>(API_KEY_SCOPES);
    const refused = scopes.find((s) => !allowed.has(s));
    if (refused !== undefined)
      throw new IntegrationRuleError(`${refused} cannot be given to an API key`);
    const missing = scopes.find((s) => actor.grantFor(s) === null);
    if (missing !== undefined)
      throw new IntegrationRuleError(`You cannot give a key ${missing}: you do not hold it`);

    const secret = randomBytes(32).toString("base64url");
    const key = formatApiKey(actor.tenantId, secret);
    const id = await deps.unitOfWork.run(async () => {
      if ((await deps.keys.countLive(now)) >= MAX_API_KEYS)
        throw new IntegrationRuleError(`A business holds at most ${MAX_API_KEYS} keys`);
      const created = await deps.keys.create({
        name: input.name,
        keyHash: hashOf(key),
        hint: key.slice(-4),
        scopes,
        createdBy: actor.userId,
        expiresAt,
      });
      await recordUserAction(deps, actor.userId, {
        action: "api_key.created",
        entityType: "api_key",
        entityId: created,
        after: { name: input.name, scopes, expiresAt },
      });
      return created;
    });
    const record = await deps.unitOfWork.run(() => deps.keys.find(id));
    return { ...record!, key };
  }

  async revoke(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const revoked = await deps.keys.revoke(id, actor.userId, deps.clock.now());
      if (!revoked) throw new ApiKeyNotFoundError();
      await recordUserAction(deps, actor.userId, {
        action: "api_key.revoked",
        entityType: "api_key",
        entityId: id,
      });
    });
  }
}

/** Turns an `afk_` bearer token into the tenant and principal of a request. */
export class AuthenticateApiKey {
  constructor(
    private readonly deps: Readonly<{
      tenants: ITenantDirectory;
      tenantContext: ITenantContext;
      unitOfWork: IUnitOfWork;
      keys: IApiKeys;
      gate: EnterpriseGate;
      permissions: IPermissionResolver;
      clock: IClock;
    }>,
  ) {}

  async execute(
    query: Readonly<{ key: string; tenantSlug: string | null }>,
  ): Promise<Readonly<{ tenant: TenantSummary; principal: Principal }>> {
    const { deps } = this;
    const tenantId = tenantOfApiKey(query.key);
    if (tenantId === null) throw new InvalidAccessTokenError("invalid_api_key");
    const tenant = await deps.tenants.findById(tenantId);
    if (tenant === null) throw new InvalidAccessTokenError("invalid_api_key");
    if (query.tenantSlug !== null) {
      const addressed = await deps.tenants.findBySlug(query.tenantSlug);
      if (addressed?.id !== tenant.id) throw new TenantMismatchError();
    }
    assertTenantUsable(tenant, { billingOnly: true });
    await deps.gate.require(tenant.id);

    const key = await deps.tenantContext.runAs(TenantId.from(tenant.id), () =>
      deps.unitOfWork.run(() => deps.keys.use(hashOf(query.key), deps.clock.now())),
    );
    if (key === null) throw new InvalidAccessTokenError("invalid_api_key");

    const version = await deps.permissions.currentVersion(tenant.id, key.userId);
    if (version === null) throw new InvalidAccessTokenError("invalid_api_key");
    const grants = await deps.permissions.resolve(tenant.id, key.userId, version);
    if (grants === null) throw new InvalidAccessTokenError("invalid_api_key");
    if (grants.allBranchesInactive === true) throw new BranchDeactivatedError();

    // What the user holds now and the key was given: a role taken away takes it from the key.
    const scopes = new Set(key.scopes);
    const permissions = new Map<string, PermissionGrant>(
      [...grants.permissions].filter(([permission]) => scopes.has(permission)),
    );
    return {
      tenant,
      principal: new Principal(key.userId, tenant.id, key.id, { ...grants, permissions }, null, {
        id: key.id,
        name: key.name,
      }),
    };
  }
}
