import type { FeatureFlag, FlagOverride } from "../console/FeatureFlags.js";

/** Feature flags, kill switches and their per-tenant overrides (platform database). */
export interface IFeatureFlagRepository {
  flags(): Promise<FeatureFlag[]>;
  flag(key: string, lock?: boolean): Promise<FeatureFlag | null>;
  saveFlag(flag: FeatureFlag): Promise<void>;
  overrides(filter: Readonly<{ flagKey?: string; tenantId?: string }>): Promise<FlagOverride[]>;
  setOverride(override: FlagOverride): Promise<void>;
  removeOverride(flagKey: string, tenantId: string): Promise<boolean>;
  /** The tenant's licence type (null: no subscription). */
  licenceType(tenantId: string): Promise<string | null>;
}
