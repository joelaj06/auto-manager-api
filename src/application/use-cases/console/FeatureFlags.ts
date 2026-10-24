import {
  coversPath,
  resolveFlag,
  validateFlag,
  type FeatureFlag,
  type FlagKind,
  type FlagOverride,
  type FlagResolution,
} from "../../../domain/console/FeatureFlags.js";
import type { IFeatureFlagRepository } from "../../../domain/repositories/IFeatureFlagRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IFeatureGate } from "../../ports/IOperationsGates.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import { recordStaffAction } from "./consoleAudit.js";

export class FeatureFlagNotFoundError extends ApplicationError {
  readonly code = "FEATURE_FLAG_NOT_FOUND";
  constructor() {
    super("Feature flag not found");
  }
}

export class FeatureFlagExistsError extends ApplicationError {
  readonly code = "FEATURE_FLAG_EXISTS";
  constructor() {
    super("A flag with this key already exists");
  }
}

export type FlagChanges = Readonly<{
  description?: string;
  enabled?: boolean;
  rolloutPercent?: number;
  licenceTypes?: readonly string[];
  routePrefixes?: readonly string[];
}>;

type Snapshot = Readonly<{
  at: number;
  flags: readonly FeatureFlag[];
  overrides: ReadonlyMap<string, FlagOverride>;
  licences: Map<string, string | null>;
}>;

/**
 * Feature flags, module toggles and kill switches (docs/27 §3.9): global, by licence type, by
 * percentage of tenants, and per tenant (overrides, module toggles). A flag can switch off route
 * prefixes of the tenant API — a kill switch for everyone at once, public routes included. The
 * tenant apps read what is on for them; staff can see why a flag resolves as it does. Changes are
 * audited; every API process sees them within seconds (a short cache).
 */
export class FeatureFlags implements IFeatureGate {
  private snapshot: Snapshot | null = null;

  constructor(
    private readonly deps: Readonly<{
      flags: IFeatureFlagRepository;
      directory: ITenantDirectory;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
      logger?: ILogger;
      cacheMs?: number;
    }>,
  ) {}

  // --- console ---

  async list(): Promise<(FeatureFlag & Readonly<{ overrides: number }>)[]> {
    const overrides = await this.deps.flags.overrides({});
    return (await this.deps.flags.flags()).map((f) => ({
      ...f,
      overrides: overrides.filter((o) => o.flagKey === f.key).length,
    }));
  }

  async get(key: string) {
    return {
      ...(await this.find(key)),
      overrides: await this.deps.flags.overrides({ flagKey: key }),
    };
  }

  async create(
    input: Readonly<{
      key: string;
      description: string;
      kind: FlagKind;
      enabled: boolean;
      rolloutPercent?: number;
      licenceTypes?: readonly string[];
      routePrefixes?: readonly string[];
    }>,
    actor: PlatformPrincipal,
  ): Promise<FeatureFlag> {
    const { deps } = this;
    const flag: FeatureFlag = {
      key: input.key,
      description: input.description.trim(),
      kind: input.kind,
      enabled: input.enabled,
      rolloutPercent: input.rolloutPercent ?? 100,
      licenceTypes: input.licenceTypes ?? [],
      routePrefixes: input.routePrefixes ?? [],
      updatedBy: actor.userId,
      updatedAt: deps.clock.now(),
    };
    validateFlag(flag);
    await deps.unitOfWork.run(async () => {
      if ((await deps.flags.flag(flag.key)) !== null) throw new FeatureFlagExistsError();
      await deps.flags.saveFlag(flag);
      await this.audit(actor, "flag.created", flag.key, null, flag);
    });
    this.forget();
    return flag;
  }

  async update(key: string, changes: FlagChanges, reason: string, actor: PlatformPrincipal) {
    const { deps } = this;
    const updated = await deps.unitOfWork.run(async () => {
      const before = await deps.flags.flag(key, true);
      if (before === null) throw new FeatureFlagNotFoundError();
      const after: FeatureFlag = {
        ...before,
        ...(changes.description === undefined ? {} : { description: changes.description.trim() }),
        ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
        ...(changes.rolloutPercent === undefined ? {} : { rolloutPercent: changes.rolloutPercent }),
        ...(changes.licenceTypes === undefined ? {} : { licenceTypes: changes.licenceTypes }),
        ...(changes.routePrefixes === undefined ? {} : { routePrefixes: changes.routePrefixes }),
        updatedBy: actor.userId,
        updatedAt: deps.clock.now(),
      };
      validateFlag(after);
      await deps.flags.saveFlag(after);
      await this.audit(actor, "flag.changed", key, before, after, reason);
      return after;
    });
    this.forget();
    return updated;
  }

  /** A module toggle for one tenant (on or off whatever the flag says, kill switches aside). */
  async setOverride(
    key: string,
    tenantId: string,
    enabled: boolean,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<FlagOverride> {
    const { deps } = this;
    await this.find(key);
    if ((await deps.directory.findById(tenantId)) === null) throw new TenantNotFoundForStaffError();
    const override: FlagOverride = {
      flagKey: key,
      tenantId,
      enabled,
      reason: reason.trim(),
      setBy: actor.userId,
      setAt: deps.clock.now(),
    };
    await deps.unitOfWork.run(async () => {
      await deps.flags.setOverride(override);
      await this.audit(
        actor,
        "flag.override_set",
        key,
        null,
        { tenantId, enabled },
        reason,
        tenantId,
      );
    });
    this.forget();
    return override;
  }

  async clearOverride(key: string, tenantId: string, reason: string, actor: PlatformPrincipal) {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      await deps.flags.removeOverride(key, tenantId);
      await this.audit(actor, "flag.override_cleared", key, null, { tenantId }, reason, tenantId);
    });
    this.forget();
  }

  /** The flag debugger: what a flag resolves to for a tenant, and why. */
  async resolve(
    key: string,
    tenantId: string,
  ): Promise<FlagResolution & Readonly<{ key: string }>> {
    const flag = await this.find(key);
    const override = (await this.deps.flags.overrides({ flagKey: key, tenantId }))[0] ?? null;
    return {
      key,
      ...resolveFlag(
        flag,
        { id: tenantId, licenceType: await this.deps.flags.licenceType(tenantId) },
        override,
      ),
    };
  }

  // --- the tenant ---

  /** Every flag as it stands for the tenant (the apps hide what is off). */
  async forTenant(tenantId: string): Promise<Readonly<Record<string, boolean>>> {
    const snap = await this.current();
    const licenceType = await this.licenceOf(snap, tenantId);
    return Object.fromEntries(
      snap.flags.map((f) => [
        f.key,
        resolveFlag(
          f,
          { id: tenantId, licenceType },
          snap.overrides.get(`${f.key}:${tenantId}`) ?? null,
        ).enabled,
      ]),
    );
  }

  // --- IFeatureGate ---

  async disabledBy(tenantId: string | null, path: string): Promise<string | null> {
    // Gates fail open: flags that cannot be read never take the API down (health included).
    let snap: Snapshot;
    try {
      snap = await this.current();
    } catch (error) {
      this.deps.logger?.warn("Could not read feature flags; nothing is switched off", { error });
      return null;
    }
    for (const flag of snap.flags) {
      if (!coversPath(flag, path)) continue;
      const tenant =
        tenantId === null
          ? null
          : { id: tenantId, licenceType: await this.licenceOf(snap, tenantId) };
      const override =
        tenantId === null ? null : (snap.overrides.get(`${flag.key}:${tenantId}`) ?? null);
      if (!resolveFlag(flag, tenant, override).enabled) return flag.key;
    }
    return null;
  }

  // --- helpers ---

  private async current(): Promise<Snapshot> {
    const now = this.deps.clock.now().getTime();
    if (this.snapshot !== null && now - this.snapshot.at < (this.deps.cacheMs ?? 10_000))
      return this.snapshot;
    const [flags, overrides] = await Promise.all([
      this.deps.flags.flags(),
      this.deps.flags.overrides({}),
    ]);
    this.snapshot = {
      at: now,
      flags,
      overrides: new Map(overrides.map((o) => [`${o.flagKey}:${o.tenantId}`, o])),
      licences: new Map(),
    };
    return this.snapshot;
  }

  private async licenceOf(snap: Snapshot, tenantId: string): Promise<string | null> {
    if (!snap.flags.some((f) => f.licenceTypes.length > 0)) return null;
    if (!snap.licences.has(tenantId))
      snap.licences.set(tenantId, await this.deps.flags.licenceType(tenantId));
    return snap.licences.get(tenantId) ?? null;
  }

  private forget(): void {
    this.snapshot = null;
  }

  private async find(key: string): Promise<FeatureFlag> {
    const flag = await this.deps.flags.flag(key);
    if (flag === null) throw new FeatureFlagNotFoundError();
    return flag;
  }

  private audit(
    actor: PlatformPrincipal,
    action: string,
    key: string,
    before: unknown,
    after: unknown,
    reason: string | null = null,
    tenantId: string | null = null,
  ): Promise<void> {
    return recordStaffAction(this.deps, actor, {
      action,
      entityType: "feature_flag",
      entityId: key,
      targetTenantId: tenantId,
      reason,
      before,
      after,
    });
  }
}
