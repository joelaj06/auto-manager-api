import { DomainError } from "../errors/DomainError.js";

export type FlagKind = "feature" | "kill_switch";

export type FeatureFlag = Readonly<{
  key: string;
  description: string;
  kind: FlagKind;
  enabled: boolean;
  /** Percentage of tenants (by a stable hash) the feature reaches. */
  rolloutPercent: number;
  /** Licence types it is limited to; empty: every licence type. */
  licenceTypes: readonly string[];
  /** Tenant API route prefixes it switches off when off. */
  routePrefixes: readonly string[];
  updatedBy: string | null;
  updatedAt: Date;
}>;

export type FlagOverride = Readonly<{
  flagKey: string;
  tenantId: string;
  enabled: boolean;
  reason: string;
  setBy: string;
  setAt: Date;
}>;

export type FlagResolution = Readonly<{
  enabled: boolean;
  because: "kill_switch" | "override" | "off" | "licence" | "rollout" | "on";
}>;

export class FeatureFlagError extends DomainError {
  readonly code = "FEATURE_FLAG";
  constructor(message: string) {
    super(message);
  }
}

/** A stable bucket 0–99 for a tenant and flag (FNV-1a), so rollouts do not flicker. */
export function rolloutBucket(key: string, tenantId: string): number {
  let hash = 0x811c9dc5;
  for (const ch of `${key}:${tenantId}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/**
 * Whether a flag is on for a tenant (docs/27 §3.9): a kill switch that is off is off for
 * everyone; otherwise a per-tenant override decides; then the flag itself, its licence types and
 * its percentage rollout. Without a tenant (a public route) only the global state counts.
 */
export function resolveFlag(
  flag: FeatureFlag,
  tenant: Readonly<{ id: string; licenceType: string | null }> | null,
  override: FlagOverride | null,
): FlagResolution {
  if (flag.kind === "kill_switch" && !flag.enabled)
    return { enabled: false, because: "kill_switch" };
  if (tenant === null) return { enabled: flag.enabled, because: flag.enabled ? "on" : "off" };
  if (override !== null) return { enabled: override.enabled, because: "override" };
  if (!flag.enabled) return { enabled: false, because: "off" };
  if (
    flag.licenceTypes.length > 0 &&
    (tenant.licenceType === null || !flag.licenceTypes.includes(tenant.licenceType))
  )
    return { enabled: false, because: "licence" };
  if (flag.rolloutPercent < 100 && rolloutBucket(flag.key, tenant.id) >= flag.rolloutPercent)
    return { enabled: false, because: "rollout" };
  return { enabled: true, because: "on" };
}

/** Whether a request path is under one of the flag's route prefixes. */
export const coversPath = (flag: FeatureFlag, path: string): boolean =>
  flag.routePrefixes.some((p) => path === p || path.startsWith(`${p}/`));

export function validateFlag(
  input: Pick<
    FeatureFlag,
    "key" | "description" | "rolloutPercent" | "licenceTypes" | "routePrefixes"
  >,
): void {
  if (!/^[a-z][a-z0-9_.]{1,60}$/.test(input.key))
    throw new FeatureFlagError("A flag key is lower case letters, digits, dots and underscores");
  if (input.description.trim().length < 3) throw new FeatureFlagError("Describe the flag");
  if (
    !Number.isInteger(input.rolloutPercent) ||
    input.rolloutPercent < 0 ||
    input.rolloutPercent > 100
  )
    throw new FeatureFlagError("The rollout is 0 to 100 %");
  if (!input.licenceTypes.every((t) => t === "standard" || t === "enterprise"))
    throw new FeatureFlagError("Licence types are standard or enterprise");
  if (!input.routePrefixes.every((p) => /^\/api\/v1\/[a-z0-9/_-]+$/.test(p) && !p.endsWith("/")))
    throw new FeatureFlagError("Route prefixes look like /api/v1/module");
}
