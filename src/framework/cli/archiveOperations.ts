import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import type { Container } from "inversify";
import type { IPlatformAuditTrail } from "../../application/ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../application/ports/IPlatformUnitOfWork.js";
import type { ITenantArchives } from "../../application/ports/ITenantArchives.js";
import { ArchiveOperations } from "../../application/use-cases/console/ArchiveOperations.js";
import type { ClusterManagement } from "../../application/use-cases/console/ClusterManagement.js";
import type { PersonalDataErasure } from "../../application/use-cases/console/PersonalDataErasure.js";
import type { PlatformAlerts } from "../../application/use-cases/console/PlatformAlerts.js";
import type { TenantLifecycleService } from "../../application/use-cases/tenants/TenantLifecycleService.js";
import type { IClock } from "../../application/ports/IClock.js";
import type { ILogger } from "../../application/ports/ILogger.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { ArchiveKeyVault } from "../../infrastructure/archive/ColdArchiveVault.js";
import { keyFingerprint, loadBackupPublicKey } from "../../infrastructure/backup/BackupCipher.js";
import type { DatabaseBackupService } from "../../infrastructure/backup/DatabaseBackupService.js";
import type { AppConfig } from "../../infrastructure/config/config.js";
import type { ClusterConnections } from "../../infrastructure/database/clusters/ClusterConnections.js";
import type { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import type { MigrationRunner } from "../../infrastructure/database/migrations/MigrationRunner.js";
import type { TenantDatabaseNaming } from "../../infrastructure/database/postgres/TenantDatabaseNaming.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The archive operations of an operator holding the backup private key (`yarn archive`), built
 * from the application container. Never part of the server: it has no private key.
 */
export function archiveOperationsFrom(
  container: Container,
  privateKey: KeyObject,
): ArchiveOperations {
  const config = container.get<AppConfig>(TYPES.Config);
  const naming = container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming);
  const runner = container.get<MigrationRunner>(TYPES.MigrationRunner);
  const sets = container.get<MigrationSets>(TYPES.MigrationSets);
  const publicKeyFile = config.backup.publicKeyFile;
  const vault = new ArchiveKeyVault({
    backups: container.get<DatabaseBackupService>(TYPES.DatabaseBackupService),
    clusters: container.get<ClusterConnections>(TYPES.ClusterConnections),
    naming,
    maintenanceDatabase: config.database.platformDatabase,
    privateKey,
    migrate: async (client) => (await runner.migrate(client, sets.tenant)).currentVersion,
    currentKeyFingerprint:
      publicKeyFile === undefined
        ? ""
        : keyFingerprint(loadBackupPublicKey(readFileSync(publicKeyFile, "utf8"))),
  });
  return new ArchiveOperations({
    unitOfWork: container.get<IPlatformUnitOfWork>(TYPES.PlatformUnitOfWork),
    archives: container.get<ITenantArchives>(TYPES.TenantArchives),
    vault,
    placement: container.get<ClusterManagement>(TYPES.ClusterManagement),
    erasures: container.get<PersonalDataErasure>(TYPES.PersonalDataErasure),
    lifecycle: container.get<TenantLifecycleService>(TYPES.TenantLifecycleService),
    routing: container.get<ClusterConnections>(TYPES.ClusterConnections),
    audit: container.get<IPlatformAuditTrail>(TYPES.PlatformAuditTrail),
    alerts: container.get<PlatformAlerts>(TYPES.PlatformAlerts),
    clock: container.get<IClock>(TYPES.Clock),
    logger: container.get<ILogger>(TYPES.Logger),
    databaseNameOf: (tenantId) => naming.databaseNameFor(TenantId.from(tenantId)),
  });
}
