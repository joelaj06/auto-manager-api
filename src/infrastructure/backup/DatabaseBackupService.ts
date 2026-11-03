import { PostgresIntegrityChecks } from "../integrity/PostgresIntegrityChecks.js";
import { randomBytes, type KeyObject } from "node:crypto";
import pg from "pg";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { mapWithConcurrency } from "../concurrency/mapWithConcurrency.js";
import { DATABASE_GROUP_ROLES } from "../database/postgres/databaseRoles.js";
import type { PostgresConnectionFactory } from "../database/postgres/PostgresConnectionFactory.js";
import type { TenantDatabaseNaming } from "../database/postgres/TenantDatabaseNaming.js";
import { BackupDecryptStream, BackupEncryptStream, keyFingerprint } from "./BackupCipher.js";
import type { LocalBackupStorage } from "./LocalBackupStorage.js";
import type { PgClientTools } from "./PgClientTools.js";
import type {
  BackupKind,
  BackupPurpose,
  BackupRecord,
  PostgresBackupCatalog,
} from "./PostgresBackupCatalog.js";

export type BackupServiceOptions = Readonly<{
  connections: PostgresConnectionFactory;
  /** Connections to the cluster a tenant's database is on (absent: `connections`). */
  tenantConnections?: (tenantId: string) => Promise<PostgresConnectionFactory>;
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

export type Check = Readonly<{ name: string; passed: boolean; detail?: string }>;

export type VerificationReport = Readonly<{
  backupId: string;
  passed: boolean;
  checks: readonly Check[];
  durationMs: number;
  /** The dump's schema version, and the one it was migrated to (when asked). */
  schemaVersion: string | null;
  migratedTo: string | null;
}>;

/** Brings a restored tenant database to this release's schema; returns its version. */
export type MigrateForward = (client: pg.ClientBase) => Promise<string | null>;

/** A file the tenant's records point at (the files manifest of an archive). */
export type ManifestFile = Readonly<{
  key: string;
  visibility: "public" | "private";
  sizeBytes: number;
  contentType: string;
}>;

export type ArchiveDump = Readonly<{
  record: BackupRecord;
  /** The dump restored into a scratch database as it was written, compared with the database. */
  checks: readonly Check[];
  files: readonly ManifestFile[];
  manifestLocation: string;
}>;

export type RestoredTenant = Readonly<{
  checks: readonly Check[];
  schemaVersion: string | null;
  migratedTo: string | null;
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
 * version, tenant identity, every table's row count, that all foreign keys are valid and, for a
 * tenant, that its books are intact (ledger balanced, allocations and sub-ledgers agree).
 */
export class DatabaseBackupService {
  private readonly log: (message: string) => void;

  constructor(private readonly options: BackupServiceOptions) {
    this.log = options.log ?? (() => undefined);
  }

  backupPlatform(): Promise<BackupRecord> {
    return this.backup("platform", null, this.options.platformDatabase, this.options.connections);
  }

  async backupTenant(tenantId: string): Promise<BackupRecord> {
    const id = TenantId.from(tenantId);
    const connections =
      (await this.options.tenantConnections?.(id.value)) ?? this.options.connections;
    return this.backup("tenant", id.value, this.options.naming.databaseNameFor(id), connections);
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

  /**
   * The restore test: restores into a throw-away database (on `connections`, the main cluster by
   * default) and compares it with the catalogue. With `migrate`, the restored database is then
   * brought to this release's schema and its books checked again (archives, decision 497).
   */
  async verify(
    backupId: string,
    privateKey: KeyObject,
    options: Readonly<{ connections?: PostgresConnectionFactory; migrate?: MigrateForward }> = {},
  ): Promise<VerificationReport> {
    const started = Date.now();
    const connections = options.connections ?? this.options.connections;
    const record = await this.requireRestorable(backupId);
    const checks: Check[] = [];
    const scratch = `rv_${randomBytes(6).toString("hex")}`;
    let migratedTo: string | null = null;

    const stored = await this.options.storage.inspect(record.location!);
    checks.push({
      name: "file checksum",
      passed: stored.sha256 === record.sha256 && stored.sizeBytes === record.sizeBytes,
    });
    if (!checks[0]!.passed) return this.finishVerification(record, checks, started, null);

    await this.createDatabase(scratch, connections);
    try {
      await this.restoreInto(record, privateKey, scratch, connections);
      checks.push({ name: "restore", passed: true });
      checks.push(...(await this.inspectRestored(record, scratch, connections)));
      if (options.migrate !== undefined && checks.every((c) => c.passed)) {
        const migrated = await this.migrateForward(record, scratch, connections, options.migrate);
        checks.push(...migrated.checks);
        migratedTo = migrated.version;
      }
    } catch (error) {
      checks.push({ name: "restore", passed: false, detail: describe(error) });
    } finally {
      await this.dropScratchDatabase(scratch, connections);
    }
    return this.finishVerification(record, checks, started, migratedTo);
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
    await this.assertChecksum(record);

    await this.createDatabase(intoDatabase); // fails if it exists
    await this.restoreInto(record, privateKey, intoDatabase);
    await this.grantAccess(record.kind, intoDatabase, this.options.connections);
    this.log(`restored backup ${record.id} into ${intoDatabase}`);
  }

  // --- archives (decisions 495–497) ---

  /**
   * The cold archive dump of a tenant's (closed) database: like a backup, kept indefinitely, and
   * restored into a scratch database while it is written, so the bytes stored are known to
   * restore and to match the database — without the private key, which the server never has.
   * The files its records point at are listed in an encrypted manifest next to it.
   */
  async archiveTenant(
    tenantId: string,
    connections: PostgresConnectionFactory,
  ): Promise<ArchiveDump> {
    const { publicKey, storage, catalog } = this.options;
    if (publicKey === null) throw new Error("BACKUP_PUBLIC_KEY_FILE is required to archive");
    const id = TenantId.from(tenantId);
    const scratch = `rv_${randomBytes(6).toString("hex")}`;
    const started = Date.now();
    let files: ManifestFile[] = [];
    await this.createDatabase(scratch, connections);
    try {
      const record = await this.backup(
        "tenant",
        id.value,
        this.options.naming.databaseNameFor(id),
        connections,
        {
          purpose: "archive",
          restoreInto: scratch,
          onSnapshot: async (client) => {
            files = await manifestOf(client);
          },
        },
      );
      const checks: Check[] = [
        { name: "restore while written", passed: true },
        ...(await this.inspectRestored(record, scratch, connections)),
      ];
      await this.finishVerification(record, checks, started, null);
      const manifestLocation = `archives/${id.value}/${record.id}.files.json.afbk`;
      const manifest = Buffer.from(
        JSON.stringify({ tenantId: id.value, backupId: record.id, files }),
      );
      await storage.write(
        manifestLocation,
        Readable.from([manifest]).pipe(new BackupEncryptStream(publicKey)),
      );
      return { record: (await catalog.find(record.id))!, checks, files, manifestLocation };
    } finally {
      await this.dropScratchDatabase(scratch, connections);
    }
  }

  /**
   * Restores a tenant's backup or archive as the tenant's own database on `connections` (which
   * must not exist), migrated to this release and open to the app. The checks are returned; a
   * database whose checks failed is left for the caller to drop.
   */
  async restoreTenant(
    backupId: string,
    privateKey: KeyObject,
    tenantId: string,
    connections: PostgresConnectionFactory,
    migrate: MigrateForward,
  ): Promise<RestoredTenant> {
    const record = await this.requireRestorable(backupId);
    if (record.kind !== "tenant" || record.tenantId !== tenantId)
      throw new Error(`Backup ${backupId} is not one of tenant ${tenantId}`);
    await this.assertChecksum(record);
    const database = this.options.naming.databaseNameFor(TenantId.from(tenantId));
    await this.createDatabase(database, connections); // fails if it exists
    await this.restoreInto(record, privateKey, database, connections);
    const checks: Check[] = [
      { name: "restore", passed: true },
      ...(await this.inspectRestored(record, database, connections)),
    ];
    let migratedTo: string | null = null;
    if (checks.every((c) => c.passed)) {
      const migrated = await this.migrateForward(record, database, connections, migrate);
      checks.push(...migrated.checks);
      migratedTo = migrated.version;
    }
    if (checks.every((c) => c.passed)) await this.grantAccess("tenant", database, connections);
    this.log(`restored ${record.id} as ${database}`);
    return { checks, schemaVersion: record.schemaVersion, migratedTo };
  }

  /**
   * Encrypts a tenant's archive dump again for the current public key (keys are rotated,
   * docs/26 §8): decrypted and encrypted again as it streams, stored under a new backup; the old
   * file stays (storage has no delete).
   */
  async rekey(backupId: string, privateKey: KeyObject): Promise<BackupRecord> {
    const { publicKey, storage, catalog } = this.options;
    if (publicKey === null) throw new Error("BACKUP_PUBLIC_KEY_FILE is required to rekey");
    const record = await this.requireRestorable(backupId);
    if (record.kind !== "tenant") throw new Error("Only tenant archives are encrypted again");
    await this.assertChecksum(record);
    const id = await catalog.start("tenant", record.tenantId, record.databaseName, record.purpose);
    try {
      const location = `archives/${record.tenantId}/${datePath()}/${id}.dump.afbk`;
      const out = new PassThrough();
      const piping = pipeline(
        storage.read(record.location!),
        new BackupDecryptStream(privateKey),
        new BackupEncryptStream(publicKey),
        out,
      );
      const [stored] = await Promise.all([storage.write(location, out), piping]);
      await catalog.succeed(id, {
        location,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        keyFingerprint: keyFingerprint(publicKey),
        schemaVersion: record.schemaVersion,
        rowCounts: record.rowCounts ?? {},
      });
      if (record.verification !== null)
        await catalog.recordVerification(id, record.verifiedAt !== null, {
          ...record.verification,
          rekeyedFrom: record.id,
        });
      this.log(`archive ${record.id} encrypted again as ${id}`);
      return (await catalog.find(id))!;
    } catch (error) {
      await catalog.fail(id, describe(error));
      throw error;
    }
  }

  // --- backup ---

  private async backup(
    kind: BackupKind,
    tenantId: string | null,
    database: string,
    connections: PostgresConnectionFactory,
    options: Readonly<{
      purpose?: BackupPurpose;
      /** A scratch database the dump is also restored into as it streams. */
      restoreInto?: string;
      onSnapshot?: (client: pg.ClientBase) => Promise<void>;
    }> = {},
  ): Promise<BackupRecord> {
    const { publicKey, catalog, storage, tools } = this.options;
    if (publicKey === null) throw new Error("BACKUP_PUBLIC_KEY_FILE is required to create backups");

    const purpose = options.purpose ?? "routine";
    const id = await catalog.start(kind, tenantId, database, purpose);
    const location =
      kind === "platform"
        ? `platform/${datePath()}/${id}.dump.afbk`
        : purpose === "archive"
          ? `archives/${tenantId}/${datePath()}/${id}.dump.afbk`
          : `tenants/${tenantId}/${datePath()}/${id}.dump.afbk`;
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
      await options.onSnapshot?.(snapshotClient);

      const dump = tools.dump(connections.settings("backup", database), { snapshot });
      dump.exited.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile
      const restore =
        options.restoreInto === undefined
          ? null
          : tools.restore(connections.settings("migrator", options.restoreInto));
      if (restore !== null) {
        restore.exited.catch(() => undefined);
        // pg_restore failing closes its input early; its exit status says why.
        restore.stream.on("error", () => undefined);
        dump.stream.pipe(restore.stream);
      }
      const stored = await storage.write(
        location,
        dump.stream.pipe(new BackupEncryptStream(publicKey)),
        {
          beforeCommit: async () => {
            await dump.exited;
            await restore?.exited;
          },
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

  private async assertChecksum(record: BackupRecord): Promise<void> {
    const stored = await this.options.storage.inspect(record.location!);
    if (stored.sha256 !== record.sha256) {
      throw new Error("Backup file checksum does not match the catalogue; refusing to restore");
    }
  }

  private async restoreInto(
    record: BackupRecord,
    privateKey: KeyObject,
    database: string,
    connections: PostgresConnectionFactory = this.options.connections,
  ) {
    const { storage, tools } = this.options;
    const restore = tools.restore(connections.settings("migrator", database));
    await Promise.all([
      pipeline(storage.read(record.location!), new BackupDecryptStream(privateKey), restore.stream),
      restore.exited,
    ]);
  }

  private async inspectRestored(
    record: BackupRecord,
    database: string,
    connections: PostgresConnectionFactory = this.options.connections,
  ): Promise<Check[]> {
    const checks: Check[] = [];
    const client = await connections.connect("migrator", database);
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

      // The tenant's money still adds up (docs/26 §7).
      if (record.kind === "tenant") checks.push(...(await integrity(client, "integrity")));
    } finally {
      await client.end();
    }
    return checks;
  }

  /** Migrates a restored tenant database to this release and checks its books again. */
  private async migrateForward(
    record: BackupRecord,
    database: string,
    connections: PostgresConnectionFactory,
    migrate: MigrateForward,
  ): Promise<Readonly<{ checks: Check[]; version: string | null }>> {
    const client = await connections.connect("migrator", database);
    try {
      const version = await migrate(client);
      return {
        version,
        checks: [
          {
            name: "migrated to this release",
            passed: true,
            detail: `${record.schemaVersion ?? "none"} → ${version ?? "none"}`,
          },
          ...(await integrity(client, "integrity after migration")),
        ],
      };
    } catch (error) {
      return {
        version: null,
        checks: [{ name: "migrated to this release", passed: false, detail: describe(error) }],
      };
    } finally {
      await client.end();
    }
  }

  private async finishVerification(
    record: BackupRecord,
    checks: Check[],
    started: number,
    migratedTo: string | null,
  ): Promise<VerificationReport> {
    const passed = checks.every((check) => check.passed);
    const durationMs = Date.now() - started;
    await this.options.catalog.recordVerification(record.id, passed, {
      checks,
      durationMs,
      ...(migratedTo === null ? {} : { migratedTo }),
    });
    this.log(`verify ${record.id}: ${passed ? "passed" : "FAILED"} in ${durationMs} ms`);
    return {
      backupId: record.id,
      passed,
      checks,
      durationMs,
      schemaVersion: record.schemaVersion,
      migratedTo,
    };
  }

  // --- databases ---

  private async withMaintenance<T>(
    work: (client: pg.Client) => Promise<T>,
    connections: PostgresConnectionFactory = this.options.connections,
  ): Promise<T> {
    const client = await connections.connect("migrator", this.options.platformDatabase);
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  private createDatabase(
    name: string,
    connections: PostgresConnectionFactory = this.options.connections,
  ): Promise<void> {
    return this.withMaintenance(async (client) => {
      await client.query(`create database ${ident(name)} template template0`);
    }, connections);
  }

  private grantAccess(
    kind: BackupKind,
    database: string,
    connections: PostgresConnectionFactory,
  ): Promise<void> {
    const groups =
      kind === "tenant"
        ? [DATABASE_GROUP_ROLES.tenantReadWrite, DATABASE_GROUP_ROLES.backupReader]
        : [DATABASE_GROUP_ROLES.platformReadWrite, DATABASE_GROUP_ROLES.backupReader];
    return this.withMaintenance(async (client) => {
      await client.query(`revoke connect, temporary on database ${ident(database)} from public`);
      await client.query(
        `grant connect on database ${ident(database)} to ${groups.map(ident).join(", ")}`,
      );
    }, connections);
  }

  private dropScratchDatabase(
    name: string,
    connections: PostgresConnectionFactory = this.options.connections,
  ): Promise<void> {
    if (!SCRATCH_DATABASE.test(name)) throw new Error(`Refusing to drop ${name}`);
    return this.withMaintenance(async (client) => {
      await client.query(`drop database if exists ${ident(name)} with (force)`);
    }, connections);
  }
}

async function integrity(client: pg.ClientBase, prefix: string): Promise<Check[]> {
  return (await new PostgresIntegrityChecks(() => client).run()).map((check) => ({
    name: `${prefix}: ${check.name}`,
    passed: check.passed,
    ...(check.detail === null ? {} : { detail: check.detail }),
  }));
}

/** The files a tenant's records point at, from the snapshot of the dump. */
async function manifestOf(client: pg.ClientBase): Promise<ManifestFile[]> {
  const { rows } = await client.query<{
    storage_key: string;
    visibility: "public" | "private";
    size_bytes: string;
    content_type: string;
  }>(
    `select storage_key, visibility, size_bytes, content_type from files
      where status = 'ready' order by storage_key`,
  );
  return rows.map((r) => ({
    key: r.storage_key,
    visibility: r.visibility,
    sizeBytes: Number(r.size_bytes),
    contentType: r.content_type,
  }));
}

export async function countRows(client: pg.ClientBase): Promise<Record<string, number>> {
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

export async function schemaVersionOf(client: pg.ClientBase): Promise<string | null> {
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
