import type { FeatureFlag, FlagOverride } from "../../domain/console/FeatureFlags.js";
import type { IFeatureFlagRepository } from "../../domain/repositories/IFeatureFlagRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type FlagRow = {
  key: string;
  description: string;
  kind: FeatureFlag["kind"];
  enabled: boolean;
  rollout_percent: number;
  licence_types: string[];
  route_prefixes: string[];
  updated_by: string | null;
  updated_at: Date;
};

type OverrideRow = {
  flag_key: string;
  tenant_id: string;
  enabled: boolean;
  reason: string;
  set_by: string;
  set_at: Date;
};

const toFlag = (r: FlagRow): FeatureFlag => ({
  key: r.key,
  description: r.description,
  kind: r.kind,
  enabled: r.enabled,
  rolloutPercent: r.rollout_percent,
  licenceTypes: r.licence_types,
  routePrefixes: r.route_prefixes,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

const toOverride = (r: OverrideRow): FlagOverride => ({
  flagKey: r.flag_key,
  tenantId: r.tenant_id,
  enabled: r.enabled,
  reason: r.reason,
  setBy: r.set_by,
  setAt: r.set_at,
});

export class PostgresFeatureFlagRepository implements IFeatureFlagRepository {
  constructor(private readonly db: PlatformDb) {}

  async flags(): Promise<FeatureFlag[]> {
    const { rows } = await this.db.query<FlagRow>("select * from feature_flags order by key");
    return rows.map(toFlag);
  }

  async flag(key: string, lock = false): Promise<FeatureFlag | null> {
    const { rows } = await this.db.query<FlagRow>(
      `select * from feature_flags where key = $1${lock ? " for update" : ""}`,
      [key],
    );
    return rows[0] === undefined ? null : toFlag(rows[0]);
  }

  async saveFlag(f: FeatureFlag): Promise<void> {
    await this.db.query(
      `insert into feature_flags (key, description, kind, enabled, rollout_percent, licence_types,
         route_prefixes, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (key) do update set description = excluded.description,
         enabled = excluded.enabled, rollout_percent = excluded.rollout_percent,
         licence_types = excluded.licence_types, route_prefixes = excluded.route_prefixes,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [
        f.key,
        f.description,
        f.kind,
        f.enabled,
        f.rolloutPercent,
        f.licenceTypes,
        f.routePrefixes,
        f.updatedBy,
        f.updatedAt,
      ],
    );
  }

  async overrides(f: Readonly<{ flagKey?: string; tenantId?: string }>): Promise<FlagOverride[]> {
    const { rows } = await this.db.query<OverrideRow>(
      `select * from feature_flag_overrides
        where ($1::text is null or flag_key = $1) and ($2::uuid is null or tenant_id = $2)
        order by flag_key, set_at desc`,
      [f.flagKey ?? null, f.tenantId ?? null],
    );
    return rows.map(toOverride);
  }

  async setOverride(o: FlagOverride): Promise<void> {
    await this.db.query(
      `insert into feature_flag_overrides (flag_key, tenant_id, enabled, reason, set_by, set_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (flag_key, tenant_id) do update set enabled = excluded.enabled,
         reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`,
      [o.flagKey, o.tenantId, o.enabled, o.reason, o.setBy, o.setAt],
    );
  }

  async removeOverride(flagKey: string, tenantId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "delete from feature_flag_overrides where flag_key = $1 and tenant_id = $2",
      [flagKey, tenantId],
    );
    return rowCount === 1;
  }

  async licenceType(tenantId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ licence_type: string }>(
      "select licence_type from subscriptions where tenant_id = $1",
      [tenantId],
    );
    return rows[0]?.licence_type ?? null;
  }
}
