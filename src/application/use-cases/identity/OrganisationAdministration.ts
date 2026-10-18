import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { Principal } from "../../authorization/Principal.js";
import { IdentityRuleError } from "../../errors/IdentityErrors.js";
import { BranchNotFoundError } from "../../errors/TenantErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { BranchView, IBranches } from "../../ports/IBranches.js";
import type {
  IOrganisationSettings,
  NumberingFormat,
  OrganisationChanges,
  OrganisationRecord,
  OrganisationView,
} from "../../ports/IOrganisationSettings.js";
import type { IObjectStorage } from "../../ports/IObjectStorage.js";
import type { FileService } from "../files/FileService.js";
import type { BranchEntitlements } from "../billing/BranchEntitlements.js";
import { DEFAULT_NUMBERING } from "../reference/DocumentNumbering.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

/**
 * Organisation settings and branch management (docs/20, docs/27 §3.5). The base currency is
 * changed in the currency settings; timezones must be real IANA names; branch creation checks
 * the subscription's branch entitlement.
 */
export class OrganisationAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      organisation: IOrganisationSettings;
      branches: IBranches;
      policy: AuthorizationPolicy;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      /** Tenant files (the logo) and storage (its public URL). */
      files: FileService;
      storage: IObjectStorage;
      /** Subscription branch limit (docs/25 §7); absent: no limit (tests, tooling). */
      entitlements?: BranchEntitlements;
    }>,
  ) {}

  async get(): Promise<OrganisationView> {
    return this.view(await this.deps.unitOfWork.run(() => this.deps.organisation.get()));
  }

  /**
   * Sets the business logo to an uploaded, checked `organisation_logo` file (null removes it).
   * The previous logo file is deleted.
   */
  async setLogo(actor: Principal, fileId: string | null): Promise<OrganisationView> {
    const { deps } = this;
    if (fileId !== null) (await deps.files.load(fileId)).assertUsableAs("organisation_logo");
    const previous = await deps.unitOfWork.run(async () => {
      const before = await deps.organisation.get();
      if (before.logoFileId === fileId) return null;
      await deps.organisation.setLogo(fileId);
      await this.audit(actor, "organisation.logo_changed", "organisation", null, {
        before: before.logoFileId,
        after: fileId,
      });
      return before.logoFileId;
    });
    if (previous !== null) await deps.files.remove(previous);
    return this.get();
  }

  async update(actor: Principal, changes: OrganisationChanges): Promise<OrganisationView> {
    const { deps } = this;
    if (changes.timezone !== undefined) assertTimezone(changes.timezone);
    return deps.unitOfWork.run(async () => {
      const before = await deps.organisation.get();
      await deps.organisation.update(changes);
      const { logoFileId: _f, logoStorageKey: _k, ...audited } = before;
      await this.audit(actor, "organisation.updated", "organisation", null, {
        before: audited,
        changes,
      });
      return this.view(await deps.organisation.get());
    });
  }

  async setNumbering(
    actor: Principal,
    numbering: Readonly<Record<string, NumberingFormat>>,
  ): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      await this.deps.organisation.setNumbering(numbering);
      await this.audit(actor, "settings.numbering_updated", "organisation", null, { numbering });
    });
  }

  async createBranch(
    actor: Principal,
    input: Readonly<{
      code: string;
      name: string;
      address?: string | null;
      phone?: string | null;
      /** The tenant agrees to pay for one more branch when beyond the subscription. */
      confirmBranchPurchase?: boolean;
    }>,
  ): Promise<string> {
    const { deps } = this;
    const code = input.code.trim().toUpperCase();
    return deps.unitOfWork.run(async () => {
      if (await deps.branches.codeTaken(code)) {
        throw new IdentityRuleError("BRANCH_CODE_TAKEN", "Another branch already uses this code");
      }
      if (deps.entitlements !== undefined) {
        const active = await deps.branches.activeCount();
        await deps.entitlements.beforeActivating(actor.tenantId, active, {
          confirmPurchase: input.confirmBranchPurchase === true,
          userId: actor.userId,
        });
      }
      const id = await deps.branches.create({
        code,
        name: input.name.trim(),
        address: input.address ?? null,
        phone: input.phone ?? null,
      });
      await this.audit(actor, "branch.created", "branch", id, { code, name: input.name });
      return id;
    });
  }

  async updateBranch(
    actor: Principal,
    id: string,
    changes: Readonly<{ name?: string; address?: string | null; phone?: string | null }>,
  ): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      const branch = await this.reachBranch(actor, id);
      await this.deps.branches.update(id, changes);
      await this.audit(actor, "branch.updated", "branch", id, { before: branch, changes });
    });
  }

  async makeDefault(actor: Principal, id: string): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      const branch = await this.reachBranch(actor, id);
      if (branch.status !== "active") {
        throw new IdentityRuleError("UNKNOWN_BRANCH", "Only an active branch can be the default");
      }
      await this.deps.branches.makeDefault(id);
      await this.audit(actor, "branch.made_default", "branch", id, {});
    });
  }

  private async reachBranch(actor: Principal, id: string): Promise<BranchView> {
    const branch = await this.deps.branches.lockById(id);
    if (branch === null) throw new BranchNotFoundError();
    const reachable = this.deps.policy.branchesFor(actor, "branches.update");
    if (reachable !== "all" && !reachable.includes(id)) throw new BranchNotFoundError();
    return branch;
  }

  private view(record: OrganisationRecord): OrganisationView {
    const { logoFileId, logoStorageKey, ...rest } = record;
    return {
      ...rest,
      numbering: { ...DEFAULT_NUMBERING, ...rest.numbering },
      logo:
        logoFileId === null || logoStorageKey === null
          ? null
          : { fileId: logoFileId, url: this.deps.storage.publicUrl(logoStorageKey) },
    };
  }

  private async audit(
    actor: Principal,
    action: string,
    entityType: string,
    entityId: string | null,
    details: unknown,
  ) {
    const request = this.deps.requestContext.current();
    await this.deps.auditTrail.record({
      actorType: "user",
      actorId: actor.userId,
      action,
      entityType,
      entityId,
      after: details,
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new IdentityRuleError("INVALID_TIMEZONE", `Unknown timezone: ${timezone}`);
  }
}
