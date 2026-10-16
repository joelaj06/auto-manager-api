export type BackupListFilter = Readonly<{
  kind?: "tenant" | "platform";
  tenantId?: string;
  status?: "running" | "succeeded" | "failed";
  limit: number;
  /** Keyset cursor: backups started before this backup id (ids are time-ordered). */
  before?: string;
}>;

/** A backup catalogue entry without storage location details. */
export type BackupView = Readonly<{
  id: string;
  kind: "tenant" | "platform";
  tenantId: string | null;
  tenantSlug: string | null;
  status: "running" | "succeeded" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
  sizeBytes: number | null;
  schemaVersion: string | null;
  error: string | null;
  verifiedAt: Date | null;
  verification: Readonly<Record<string, unknown>> | null;
}>;

export type BackupOverview = Readonly<{
  lastPlatform: Readonly<{ succeededAt: Date | null; failedAt: Date | null }>;
  lastVerification: Readonly<{ at: Date; passed: boolean; backupId: string }> | null;
  failedLast24Hours: number;
  /** Tenants with a database and no successful backup since `since`. */
  tenantsWithoutRecentBackup: Readonly<{
    count: number;
    sample: readonly Readonly<{ tenantId: string; slug: string; lastSucceededAt: Date | null }>[];
  }>;
}>;

export type SchemaVersionCount = Readonly<{
  version: string | null;
  status: "ok" | "failed" | null;
  tenants: number;
}>;

export type SchemaFailure = Readonly<{
  tenantId: string;
  slug: string;
  version: string | null;
  error: string | null;
  updatedAt: Date;
}>;

/** Backup catalogue and tenant schema status for the console (docs/27 §3.14). */
export interface IDataOperationsQueries {
  backups(filter: BackupListFilter): Promise<BackupView[]>;
  backupOverview(now: Date, since: Date): Promise<BackupOverview>;
  schemaVersions(): Promise<SchemaVersionCount[]>;
  schemaFailures(limit: number): Promise<SchemaFailure[]>;
  platformSchemaVersion(): Promise<string | null>;
}
