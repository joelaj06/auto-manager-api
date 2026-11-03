import type { ArchiveCheck, ArchiveFiles } from "./ITenantArchives.js";

export type SealedArchive = Readonly<{
  backupId: string;
  sizeBytes: number;
  schemaVersion: string | null;
  tables: number;
  rows: number;
  checks: readonly ArchiveCheck[];
  files: ArchiveFiles;
}>;

export type VaultReport = Readonly<{
  passed: boolean;
  checks: readonly ArchiveCheck[];
  /** The schema version of the dump, and after migrating it to this release. */
  schemaVersion: string | null;
  migratedTo: string | null;
  durationMs: number;
}>;

/** A check of an archive failed: nothing was changed. */
export class ArchiveCheckFailedError extends Error {
  constructor(readonly checks: readonly ArchiveCheck[]) {
    super(
      `Archive checks failed: ${checks
        .filter((c) => !c.passed)
        .map((c) => `${c.name}${c.detail === undefined ? "" : ` (${c.detail})`}`)
        .join("; ")}`,
    );
    this.name = "ArchiveCheckFailedError";
  }
}

/**
 * Writing archives, as the server does: it holds only the backup public key, so it can make an
 * archive but never read one back (decision 495).
 */
export interface IColdArchiveVault {
  /**
   * Dumps the tenant's (closed) database encrypted to backup storage, restoring the same bytes
   * into a scratch database as they are written and comparing them with the database; records
   * the files its records point at. Throws ArchiveCheckFailedError when a check fails.
   */
  seal(tenantId: string, clusterId: string): Promise<SealedArchive>;
  databaseExists(tenantId: string, clusterId: string): Promise<boolean>;
  /** Drops the tenant's database; false when it was already gone. */
  dropDatabase(tenantId: string, clusterId: string): Promise<boolean>;
}

/**
 * Reading archives with the backup private key, as an operator does off the server (`yarn
 * archive`): restore tests, restores and encrypting an archive again for a new key.
 */
export interface IArchiveKeyVault {
  /** Restores the dump into a scratch database, migrates it to this release and checks it. */
  verify(backupId: string): Promise<VaultReport>;
  /**
   * Restores the dump as the tenant's database on `clusterId`, migrated to this release and
   * checked, open to the app. Throws ArchiveCheckFailedError (the database is then dropped).
   */
  unseal(tenantId: string, backupId: string, clusterId: string): Promise<VaultReport>;
  /** Encrypts the dump again for the current public key; returns the new backup. */
  rekey(backupId: string): Promise<Readonly<{ backupId: string; keyFingerprint: string }>>;
  /** The fingerprint of the public key new archives are encrypted for. */
  currentKeyFingerprint(): string;
}
