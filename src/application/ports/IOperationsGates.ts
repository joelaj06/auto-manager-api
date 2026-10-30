/** A maintenance window that makes every tenant read-only right now (docs/27 §3.12). */
export interface IMaintenanceState {
  readOnlyNow(): Promise<Readonly<{ title: string; endsAt: Date }> | null>;
}

/** Feature flags that gate routes of the tenant API (docs/27 §3.9); cached by the implementation. */
export interface IFeatureGate {
  /** The flag that turns this path off for the tenant (null: public route), or null. */
  disabledBy(tenantId: string | null, path: string): Promise<string | null>;
}

/** Counts tenant API calls per day (`usage_daily`); flushed in the background. */
export interface IUsageMeter {
  count(tenantId: string): void;
  /** A call answered with a server error. */
  failed(tenantId: string): void;
}
