import type { IClock } from "../../ports/IClock.js";
import type {
  BackupListFilter,
  BackupOverview,
  BackupView,
  IDataOperationsQueries,
  SchemaFailure,
} from "../../ports/IDataOperationsQueries.js";

/** A tenant without a successful backup for longer than this is flagged (daily backups + slack). */
export const BACKUP_FRESHNESS_HOURS = 26;

export type MigrationStatus = Readonly<{
  platform: Readonly<{ current: string | null; latest: string | null; upToDate: boolean }>;
  tenants: Readonly<{
    latest: string | null;
    total: number;
    upToDate: number;
    behind: number;
    failed: number;
    neverMigrated: number;
    byVersion: readonly Readonly<{
      version: string | null;
      status: "ok" | "failed" | null;
      tenants: number;
    }>[];
    failures: readonly SchemaFailure[];
  }>;
}>;

/** Console views of backups and schema migrations (docs/27 §3.14, docs/26, docs/22 §2.5). */
export class DataOperationsConsole {
  constructor(
    private readonly deps: Readonly<{
      queries: IDataOperationsQueries;
      clock: IClock;
      /** Latest migration versions shipped with this build. */
      latest: Readonly<{ platform: string | null; tenant: string | null }>;
    }>,
  ) {}

  backups(filter: BackupListFilter): Promise<BackupView[]> {
    return this.deps.queries.backups(filter);
  }

  backupOverview(): Promise<BackupOverview> {
    const now = this.deps.clock.now();
    const since = new Date(now.getTime() - BACKUP_FRESHNESS_HOURS * 3_600_000);
    return this.deps.queries.backupOverview(now, since);
  }

  async migrations(): Promise<MigrationStatus> {
    const [platformVersion, versions, failures] = await Promise.all([
      this.deps.queries.platformSchemaVersion(),
      this.deps.queries.schemaVersions(),
      this.deps.queries.schemaFailures(50),
    ]);
    const latest = this.deps.latest.tenant;
    const sum = (match: (v: (typeof versions)[number]) => boolean) =>
      versions.filter(match).reduce((total, v) => total + v.tenants, 0);
    return {
      platform: {
        current: platformVersion,
        latest: this.deps.latest.platform,
        upToDate: platformVersion === this.deps.latest.platform,
      },
      tenants: {
        latest,
        total: sum(() => true),
        upToDate: sum((v) => v.status === "ok" && v.version === latest),
        behind: sum((v) => v.status !== null && v.version !== latest),
        failed: sum((v) => v.status === "failed"),
        neverMigrated: sum((v) => v.status === null),
        byVersion: versions,
        failures,
      },
    };
  }
}
