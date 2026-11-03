import type { KeyObject } from "node:crypto";
import pg from "pg";
import {
  ArchiveCheckFailedError,
  type IArchiveKeyVault,
  type IColdArchiveVault,
  type SealedArchive,
  type VaultReport,
} from "../../application/ports/IColdArchiveVault.js";
import type { IObjectStorage } from "../../application/ports/IObjectStorage.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type {
  Check,
  DatabaseBackupService,
  MigrateForward,
} from "../backup/DatabaseBackupService.js";
import { mapWithConcurrency } from "../concurrency/mapWithConcurrency.js";
import type { ClusterConnections } from "../database/clusters/ClusterConnections.js";
import type { TenantDatabaseNaming } from "../database/postgres/TenantDatabaseNaming.js";

const ident = (name: string) => pg.escapeIdentifier(name);

type DatabaseDeps = Readonly<{
  clusters: ClusterConnections;
  naming: TenantDatabaseNaming;
  maintenanceDatabase: string;
}>;

/** The tenant's own database on a cluster: whether it is there, and dropping it. */
class TenantDatabases {
  constructor(private readonly deps: DatabaseDeps) {}

  exists(tenantId: string, clusterId: string): Promise<boolean> {
    return this.onMaintenance(clusterId, async (client) => {
      const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [
        this.nameOf(tenantId),
      ]);
      return (rowCount ?? 0) > 0;
    });
  }

  drop(tenantId: string, clusterId: string): Promise<boolean> {
    return this.onMaintenance(clusterId, async (client) => {
      const name = this.nameOf(tenantId);
      const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [
        name,
      ]);
      if ((rowCount ?? 0) === 0) return false;
      await client.query(`drop database ${ident(name)} with (force)`);
      return true;
    });
  }

  private nameOf(tenantId: string): string {
    return this.deps.naming.databaseNameFor(TenantId.from(tenantId));
  }

  private async onMaintenance<T>(
    clusterId: string,
    work: (client: pg.Client) => Promise<T>,
  ): Promise<T> {
    const connections = await this.deps.clusters.on(clusterId);
    const client = await connections.connect("migrator", this.deps.maintenanceDatabase);
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }
}

/**
 * Archives as the server writes them (decision 495): the dump checked while it is written, and
 * the files of the manifest looked up in storage.
 */
export class ColdArchiveVault implements IColdArchiveVault {
  private readonly databases: TenantDatabases;

  constructor(
    private readonly deps: DatabaseDeps &
      Readonly<{ backups: DatabaseBackupService; storage: IObjectStorage }>,
  ) {
    this.databases = new TenantDatabases(deps);
  }

  async seal(tenantId: string, clusterId: string): Promise<SealedArchive> {
    const { backups, clusters, storage } = this.deps;
    const dump = await backups.archiveTenant(tenantId, await clusters.on(clusterId));
    if (!dump.checks.every((c) => c.passed)) throw new ArchiveCheckFailedError(dump.checks);
    let missing = 0;
    await mapWithConcurrency(dump.files, 8, async (file) => {
      if ((await storage.stat(file.visibility, file.key)) === null) missing++;
    });
    const counts = dump.record.rowCounts ?? {};
    return {
      backupId: dump.record.id,
      sizeBytes: dump.record.sizeBytes ?? 0,
      schemaVersion: dump.record.schemaVersion,
      tables: Object.keys(counts).length,
      rows: Object.values(counts).reduce((a, b) => a + b, 0),
      checks: dump.checks,
      files: {
        count: dump.files.length,
        bytes: dump.files.reduce((a, f) => a + f.sizeBytes, 0),
        missing,
        manifestLocation: dump.manifestLocation,
      },
    };
  }

  databaseExists(tenantId: string, clusterId: string): Promise<boolean> {
    return this.databases.exists(tenantId, clusterId);
  }

  dropDatabase(tenantId: string, clusterId: string): Promise<boolean> {
    return this.databases.drop(tenantId, clusterId);
  }
}

/**
 * Archives read with the backup private key, by an operator off the server (`yarn archive`):
 * the yearly restore test migrated to this release, restoring a tenant, encrypting again for a
 * new key.
 */
export class ArchiveKeyVault implements IArchiveKeyVault {
  private readonly databases: TenantDatabases;

  constructor(
    private readonly deps: DatabaseDeps &
      Readonly<{
        backups: DatabaseBackupService;
        privateKey: KeyObject;
        migrate: MigrateForward;
        currentKeyFingerprint: string;
      }>,
  ) {
    this.databases = new TenantDatabases(deps);
  }

  async verify(backupId: string): Promise<VaultReport> {
    const report = await this.deps.backups.verify(backupId, this.deps.privateKey, {
      migrate: this.deps.migrate,
    });
    return {
      passed: report.passed,
      checks: report.checks,
      schemaVersion: report.schemaVersion,
      migratedTo: report.migratedTo,
      durationMs: report.durationMs,
    };
  }

  async unseal(tenantId: string, backupId: string, clusterId: string): Promise<VaultReport> {
    const { backups, clusters, privateKey, migrate } = this.deps;
    const started = Date.now();
    if (await this.databases.exists(tenantId, clusterId))
      throw new Error(`The tenant already has a database on ${clusterId}; nothing was restored`);
    let checks: readonly Check[];
    let restored: Awaited<ReturnType<DatabaseBackupService["restoreTenant"]>>;
    try {
      restored = await backups.restoreTenant(
        backupId,
        privateKey,
        tenantId,
        await clusters.on(clusterId),
        migrate,
      );
      checks = restored.checks;
    } catch (error) {
      await this.databases.drop(tenantId, clusterId).catch(() => false);
      throw error;
    }
    if (!checks.every((c) => c.passed)) {
      await this.databases.drop(tenantId, clusterId);
      throw new ArchiveCheckFailedError(checks);
    }
    return {
      passed: true,
      checks,
      schemaVersion: restored.schemaVersion,
      migratedTo: restored.migratedTo,
      durationMs: Date.now() - started,
    };
  }

  async rekey(backupId: string): Promise<Readonly<{ backupId: string; keyFingerprint: string }>> {
    const record = await this.deps.backups.rekey(backupId, this.deps.privateKey);
    return { backupId: record.id, keyFingerprint: record.keyFingerprint ?? "" };
  }

  currentKeyFingerprint(): string {
    return this.deps.currentKeyFingerprint;
  }
}
