import type { ArchiveStatus } from "../../domain/console/ColdArchive.js";

/** Files the tenant's records point at when it was archived (decision 495). */
export type ArchiveFiles = Readonly<{
  count?: number;
  bytes?: number;
  /** Files recorded but absent from storage. */
  missing?: number;
  /** The encrypted manifest (keys, sizes, types) next to the dump. */
  manifestLocation?: string | null;
}>;

export type ArchiveCheck = Readonly<{ name: string; passed: boolean; detail?: string }>;

export type TenantArchive = Readonly<{
  id: string;
  tenantId: string;
  slug: string;
  status: ArchiveStatus;
  reason: string;
  approvalId: string | null;
  requestedBy: string;
  requestedAt: Date;
  clusterId: string | null;
  backupId: string | null;
  /** Of the dump: size and the key it is encrypted for. */
  sizeBytes: number | null;
  keyFingerprint: string | null;
  schemaVersion: string | null;
  files: ArchiveFiles;
  report: Readonly<Record<string, unknown>>;
  error: string | null;
  startedAt: Date | null;
  archivedAt: Date | null;
  lastVerifiedAt: Date | null;
  lastVerification: Readonly<Record<string, unknown>> | null;
  rekeyedAt: Date | null;
  restoreReason: string | null;
  restoreApprovalId: string | null;
  restoreRequestedBy: string | null;
  restoreApprovedAt: Date | null;
  restoreStartedAt: Date | null;
  restoredAt: Date | null;
  restoredByOperator: string | null;
  restoreReport: Readonly<Record<string, unknown>> | null;
}>;

export type ArchiveChanges = Readonly<{
  status?: ArchiveStatus;
  clusterId?: string;
  backupId?: string;
  files?: ArchiveFiles;
  report?: Readonly<Record<string, unknown>>;
  error?: string | null;
  startedAt?: Date;
  archivedAt?: Date;
  lastVerifiedAt?: Date;
  lastVerification?: Readonly<Record<string, unknown>>;
  rekeyedAt?: Date;
  restoreReason?: string;
  restoreApprovalId?: string | null;
  restoreRequestedBy?: string;
  restoreApprovedAt?: Date;
  restoreStartedAt?: Date | null;
  restoredAt?: Date;
  restoredByOperator?: string;
  restoreReport?: Readonly<Record<string, unknown>>;
}>;

/** What archiving needs to know of a tenant. */
export type ArchivableTenant = Readonly<{
  tenantId: string;
  slug: string;
  status: string;
  statusChangedAt: Date | null;
  clusterId: string;
  hasDatabase: boolean;
  moving: boolean;
}>;

/** Cold archives of tenants in the platform database. */
export interface ITenantArchives {
  tenant(tenantId: string): Promise<ArchivableTenant | null>;
  create(
    archive: Readonly<{
      tenantId: string;
      reason: string;
      approvalId: string | null;
      requestedBy: string;
    }>,
  ): Promise<string>;
  find(id: string): Promise<TenantArchive | null>;
  /** The archive in progress or in force for a tenant. */
  current(tenantId: string): Promise<TenantArchive | null>;
  list(
    filter: Readonly<{ status?: ArchiveStatus; tenantId?: string; limit: number }>,
  ): Promise<TenantArchive[]>;
  update(id: string, changes: ArchiveChanges): Promise<void>;
  /** Archives whose last restore test (or archiving) is older than `before`. */
  verifiedBefore(before: Date, limit: number): Promise<TenantArchive[]>;
  /** Restores approved before `before` and not carried out. */
  restoresWaiting(before: Date): Promise<TenantArchive[]>;
  /** The tenant's database is gone (archived) or back on its cluster. */
  setDatabase(tenantId: string, databaseName: string | null): Promise<void>;
  /** Archives whose dump is encrypted for another key than `currentFingerprint`. */
  encryptedForOtherKeys(currentFingerprint: string, limit: number): Promise<TenantArchive[]>;
}
