import { randomBytes, type KeyObject } from "node:crypto";
import pg from "pg";
import { pipeline } from "node:stream/promises";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { mapWithConcurrency } from "../concurrency/mapWithConcurrency.js";
import { DATABASE_GROUP_ROLES } from "../database/postgres/databaseRoles.js";
import type { PostgresConnectionFactory } from "../database/postgres/PostgresConnectionFactory.js";
import type { TenantDatabaseNaming } from "../database/postgres/TenantDatabaseNaming.js";
import { BackupDecryptStream, BackupEncryptStream, keyFingerprint } from "./BackupCipher.js";
import type { LocalBackupStorage } from "./LocalBackupStorage.js";
import type { PgClientTools } from "./PgClientTools.js";
import type { BackupKind, BackupRecord, PostgresBackupCatalog } from "./PostgresBackupCatalog.js";

export type BackupServiceOptions = Readonly<{
  connections: PostgresConnectionFactory;
  naming: TenantDatabaseNaming;
  tools: PgClientTools;
  storage: LocalBackupStorage;
  catalog: PostgresBackupCatalog;
  platformDatabase: string;
  tenantTemplateDatabase: string;
  /** Needed to create backups; null for restore-only use. */
  publicKey: KeyObject | null;
  log?: (message: string) => void;
}>;

export type VerificationReport = Readonly<{
  backupId: string;
  passed: boolean;
  checks: readonly Readonly<{ name: string; passed: boolean; detail?: string }>[];
  durationMs: number;
}>;

export type BulkBackupResult = Readonly<{
  succeeded: number;
  failed: readonly Readonly<{ tenantId: string; error: string }>[];
}>;

const ident = (name: string) => pg.escapeIdentifier(name);
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** Scratch databases of the restore test; the only databases this code ever drops. */
const SCRATCH_DATABASE = /^rv_[0-9a-f]{12}$/;

/**
 * Logical backups (docs/26 L2 per tenant, L3 platform), their automated restore test and
 * restores into a new database.
 *
 * Backup: the read-only backup role opens a REPEATABLE READ transaction, exports its snapshot,
 * counts the rows of every table in it, and pg_dump runs on that same snapshot — so the recorded
 * counts describe exactly what is in the dump. The dump is encrypted while it streams and stored
 * under its catalogue id; the catalogue row records size, SHA-256, key fingerprint and schema
 * version.
 *
 * Verification restores into a throw-away `rv_…` database and compares: file checksum, schema
 * version, tenant identity, every table's row count, and that all foreign keys are valid.
 */
export class DatabaseBackupService {
  private readonly log: (message: string) => void;

  constructor(private readonly options: BackupServiceOptions) {
    this.log = options.log ?? (() => undefined);
  }

  backupPlatform(): Promise<BackupRecord> {
    return this.backup("platform", null, this.options.platformDatabase);
  }

  backupTenant(tenantId: string): Promise<BackupRecord> {
    const id = TenantId.from(tenantId);
    return this.backup("tenant", id.value, this.options.naming.databaseNameFor(id));
  }

  /** Backs up every tenant with a database; one failure does not stop the others. */
  async backupAllTenants(concurrency: number): Promise<BulkBackupResult> {
    const tenants = await this.options.catalog.tenantsToBackUp();
    const failed: { tenantId: string; error: string }[] = [];
    let succeeded = 0;
    await mapWithConcurrency(tenants, concurrency, async (tenantId) => {
      try {
        await this.backupTenant(tenantId);
        succeeded++;
      } catch (error) {
        failed.push({ tenantId, error: describe(error) });
      }
    });
    return { succeeded, failed };
  }

  async verify(backupId: string, privateKey: KeyObject): Promise<VerificationReport> {
    const started = Date.now();
    const record = await this.requireRestorable(backupId);
    const checks: { name: string; passed: boolean; detail?: string }[] = [];
    const scratch = `rv_${randomBytes(6).toString("hex")}`;

    const stored = await this.options.storage.inspect(record.location!);
    checks.push({
      name: "file checksum",
      passed: stored.sha256 === record.sha256 && stored.sizeBytes === record.sizeBytes,
    });
    if (!checks[0]!.passed) return this.finishVerification(record, checks, started);

    await this.createDatabase(scratch);
    try {
      await this.restoreInto(record, privateKey, scratch);
      checks.push({ name: "restore", passed: true });
      checks.push(...(await this.inspectRestored(record, scratch)));
    } catch (error) {
      checks.push({ name: "restore", passed: false, detail: describe(error) });
    } finally {
      await this.dropScratchDatabase(scratch);
    }
    return this.finishVerification(record, checks, started);
  }

  /**
   * Restores a backup into a NEW database (never over an existing one) and grants the same
   * access as provisioning would. Switching the tenant to it is a separate, manual runbook step.
   */
  async restore(backupId: string, privateKey: KeyObject, intoDatabase: string): Promise<void> {
    if (!DATABASE_NAME.test(intoDatabase) || SCRATCH_DATABASE.test(intoDatabase)) {
      throw new Error(`Invalid target database name: ${intoDatabase}`);
    }
    if (
      [this.options.platformDatabase, this.options.tenantTemplateDatabase].includes(intoDatabase)
    ) {
      throw new Error("Refusing to restore over the platform or template database");
    }
    const record = await this.requireRestorable(backupId);
    const stored = await this.options.storage.inspect(record.location!);
    if (stored.sha256 !== record.sha256) {
      throw new Error("Backup file checksum does not match the catalogue; refusing to restore");
    }

    await this.createDatabase(intoDatabase); // fails if it exists
    await this.restoreInto(record, privateKey, intoDatabase);
    const groups =
      record.kind === "tenant"
        ? [DATABASE_GROUP_ROLES.tenantReadWrite, DATABASE_GROUP_ROLES.backupReader]
        : [DATABASE_GROUP_ROLES.platformReadWrite, DATABASE_GROUP_ROLES.backupReader];
    await this.withMaintenance(async (client) => {
      await client.query(
        `revoke connect, temporary on database ${ident(intoDatabase)} from public`,
      );
      await client.query(
        `grant connect on database ${ident(intoDatabase)} to ${groups.map(ident).join(", ")}`,
      );
    });
    this.log(`restored backup ${record.id} into ${intoDatabase}`);
  }

  // --- backup ---

  private async backup(
    kind: BackupKind,
    tenantId: string | null,
    database: string,
  ): Promise<BackupRecord> {
    const { publicKey, catalog, connections, storage, tools } = this.options;
    if (publicKey === null) throw new Error("BACKUP_PUBLIC_KEY_FILE is required to create backups");

    const id = await catalog.start(kind, tenantId, database);
    const location =
      kind === "tenant"
        ? `tenants/${tenantId}/${datePath()}/${id}.dump.afbk`
        : `platform/${datePath()}/${id}.dump.afbk`;
    let snapshotClient: pg.Client | undefined;
    try {
      snapshotClient = await connections.connect("backup", database);
      await snapshotClient.query("begin isolation level repeatable read read only");
      const { rows } = await snapshotClient.query<{ snapshot: string }>(
        "select pg_export_snapshot() as snapshot",
      );
      const snapshot = rows[0]!.snapshot;
      const rowCounts = await countRows(snapshotClient);
      const schemaVersion = await schemaVersionOf(snapshotClient);
      if (kind === "tenant") await assertTenantIdentity(snapshotClient, tenantId!);

      const dump = tools.dump(connections.settings("backup", database), { snapshot });
      dump.exited.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile
      const stored = await storage.write(
        location,
        dump.stream.pipe(new BackupEncryptStream(publicKey)),
        {
          beforeCommit: () => dump.exited,
        },
      );
      await snapshotClient.query("commit");

      await catalog.succeed(id, {
        location,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        keyFingerprint: keyFingerprint(publicKey),
        schemaVersion,
        rowCounts,
      });
      this.log(`${kind} ${tenantId ?? database}: ${stored.sizeBytes} bytes → ${location}`);
      return (await catalog.find(id))!;
    } catch (error) {
      await snapshotClient?.query("rollback").catch(() => undefined);
      await catalog.fail(id, describe(error));
      throw error;
    } finally {
      await snapshotClient?.end();
    }
  }

  // --- restore ---

  private async requireRestorable(backupId: string): Promise<BackupRecord> {
    const record = await this.options.catalog.find(backupId);
    if (record === null) throw new Error(`Unknown backup ${backupId}`);
    if (record.status !== "succeeded" || record.location === null) {
      throw new Error(
        `Backup ${backupId} is ${record.status}; only successful backups can be restored`,
      );
    }
    return record;
  }

  private async restoreInto(record: BackupRecord, privateKey: KeyObject, database: string) {
    const { storage, tools, connections } = this.options;
    const restore = tools.restore(connections.settings("migrator", database));
    await Promise.all([
      pipeline(storage.read(record.location!), new BackupDecryptStream(privateKey), restore.stream),
      restore.exited,
    ]);
  }

  private async inspectRestored(record: BackupRecord, database: string) {
    const checks: { name: string; passed: boolean; detail?: string }[] = [];
    const client = await this.options.connections.connect("migrator", database);
    try {
      const version = await schemaVersionOf(client);
      checks.push({
        name: "schema version",
        passed: version === record.schemaVersion,
        detail: `${version ?? "none"} (expected ${record.schemaVersion ?? "none"})`,
      });

      if (record.kind === "tenant") {
        const { rows } = await client.query<{ tenant_id: string }>(
          "select tenant_id from tenant_info",
        );
        checks.push({ name: "tenant identity", passed: rows[0]?.tenant_id === record.tenantId });
      }

      const expected = record.rowCounts ?? {};
      const actual = await countRows(client);
      const mismatches = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
        .filter((table) => expected[table] !== actual[table])
        .map(
          (table) =>
            `${table}: ${actual[table] ?? "missing"} (expected ${expected[table] ?? "none"})`,
        );
      checks.push({
        name: "row counts",
        passed: mismatches.length === 0,
        detail:
          mismatches.length === 0 ? `${Object.keys(actual).length} tables` : mismatches.join("; "),
      });

      const { rows: fks } = await client.query<{ invalid: string }>(
        "select count(*) as invalid from pg_constraint where contype = 'f' and not convalidated",
      );
      checks.push({ name: "foreign keys valid", passed: Number(fks[0]?.invalid) === 0 });
    } finally {
      await client.end();
    }
    return checks;
  }

  private async finishVerification(
    record: BackupRecord,
    checks: { name: string; passed: boolean; detail?: string }[],
    started: number,
  ): Promise<VerificationReport> {
    const passed = checks.every((check) => check.passed);
    const durationMs = Date.now() - started;
    await this.options.catalog.recordVerification(record.id, passed, { checks, durationMs });
    this.log(`verify ${record.id}: ${passed ? "passed" : "FAILED"} in ${durationMs} ms`);
    return { backupId: record.id, passed, checks, durationMs };
  }

  // --- databases ---

  private async withMaintenance<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = await this.options.connections.connect(
      "migrator",
      this.options.platformDatabase,
    );
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  private createDatabase(name: string): Promise<void> {
    return this.withMaintenance(async (client) => {
      await client.query(`create database ${ident(name)} template template0`);
    });
  }

  private dropScratchDatabase(name: string): Promise<void> {
    if (!SCRATCH_DATABASE.test(name)) throw new Error(`Refusing to drop ${name}`);
    return this.withMaintenance(async (client) => {
      await client.query(`drop database if exists ${ident(name)} with (force)`);
    });
  }
}

async function countRows(client: pg.ClientBase): Promise<Record<string, number>> {
  const { rows: tables } = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    const { rows } = await client.query<{ n: string }>(
      `select count(*) as n from public.${ident(tablename)}`,
    );
    counts[tablename] = Number(rows[0]?.n);
  }
  return counts;
}

async function schemaVersionOf(client: pg.ClientBase): Promise<string | null> {
  const { rows } = await client.query<{ version: string | null }>(
    "select max(version) as version from schema_migrations",
  );
  return rows[0]?.version ?? null;
}

async function assertTenantIdentity(client: pg.ClientBase, tenantId: string): Promise<void> {
  const { rows } = await client.query<{ tenant_id: string }>("select tenant_id from tenant_info");
  if (rows[0]?.tenant_id !== tenantId) {
    throw new Error(`Database identity mismatch: expected tenant ${tenantId}`);
  }
}

function datePath(now = new Date()): string {
  return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
