export type DataExportStatus = "queued" | "running" | "ready" | "failed" | "expired";

export type DataExport = Readonly<{
  id: string;
  tenantId: string;
  requestedByType: "user" | "platform_staff";
  requestedBy: string;
  status: DataExportStatus;
  storageKey: string | null;
  sizeBytes: number | null;
  tables: number | null;
  filesIncluded: number | null;
  filesSkipped: number | null;
  error: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  downloads: number;
  lastDownloadedAt: Date | null;
}>;

/** Tenants' full data exports (platform database). */
export interface ITenantDataExportRepository {
  save(e: DataExport): Promise<void>;
  find(id: string, lock?: boolean): Promise<DataExport | null>;
  list(tenantId: string, limit: number): Promise<DataExport[]>;
  /** An export of the tenant still queued or running. */
  inProgress(tenantId: string): Promise<DataExport | null>;
  /** Ready exports past their expiry (their archives are then removed). */
  expiredBy(now: Date): Promise<DataExport[]>;
}
