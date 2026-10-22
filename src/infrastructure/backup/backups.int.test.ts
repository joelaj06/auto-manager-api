import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Container } from "inversify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeContainer } from "../../framework/dependency-injection/container.js";
import { TYPES } from "../../framework/dependency-injection/types.js";
import { TenantFixtures, type TestTenant } from "../../testing/fixtures/TenantFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { connectAdmin, TEST_DATABASE, testConfig } from "../../testing/testDatabase.js";
import type { PostgresConnectionFactory } from "../database/postgres/PostgresConnectionFactory.js";
import type { TenantDatabaseNaming } from "../database/postgres/TenantDatabaseNaming.js";
import { DatabaseBackupService } from "./DatabaseBackupService.js";
import { LocalBackupStorage } from "./LocalBackupStorage.js";
import { PgClientTools } from "./PgClientTools.js";
import { PostgresBackupCatalog } from "./PostgresBackupCatalog.js";

let container: Container;
let service: DatabaseBackupService;
let catalog: PostgresBackupCatalog;
let directory: string;
let privateKey: KeyObject;
let tenant: TestTenant;

beforeAll(async () => {
  container = await createTestContainer();
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  privateKey = keys.privateKey;
  directory = await mkdtemp(join(tmpdir(), "autoforce-backups-"));
  catalog = new PostgresBackupCatalog(container.get<pg.Pool>(TYPES.PlatformDatabasePool));
  const config = testConfig();
  service = new DatabaseBackupService({
    connections: container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory),
    naming: container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming),
    // No PostgreSQL client tools are assumed on the machine: run them from the server's image.
    tools: new PgClientTools({
      mode: (process.env.BACKUP_PG_TOOLS as "local" | "docker" | undefined) ?? "docker",
      image: config.backup.pgTools.image,
    }),
    storage: new LocalBackupStorage(directory),
    catalog,
    platformDatabase: config.database.platformDatabase,
    tenantTemplateDatabase: config.database.tenantTemplateDatabase,
    publicKey: keys.publicKey,
  });

  tenant = await new TenantFixtures(container).create();
  await tenant.query(
    `insert into audit_logs (actor_type, action, entity_type, entity_id)
     select 'system', 'backup.test', 'row', g::text from generate_series(1, 250) g`,
  );
  await tenant.query("insert into counters (key, value) values ('backup-marker', 42)");
}, 120_000);

afterAll(async () => {
  await disposeContainer(container);
  await rm(directory, { recursive: true, force: true });
});

async function scratchDatabases(): Promise<string[]> {
  const admin = await connectAdmin();
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "select datname from pg_database where starts_with(datname, 'rv_')",
    );
    return rows.map((r) => r.datname);
  } finally {
    await admin.end();
  }
}

describe("tenant backups", () => {
  let backupId: string;

  it("dumps the tenant database encrypted, with exact row counts", async () => {
    const record = await service.backupTenant(tenant.id.value);
    backupId = record.id;
    expect(record).toMatchObject({
      status: "succeeded",
      kind: "tenant",
      tenantId: tenant.id.value,
    });
    expect(record.rowCounts).toMatchObject({ audit_logs: 250, counters: 1, tenant_info: 1 });
    expect(record.schemaVersion).toMatch(/^\d{4}$/);

    const file = await readFile(join(directory, record.location!));
    expect(file.subarray(0, 4).toString()).toBe("AFBK");
    // pg_dump's custom format starts with "PGDMP"; it must not appear in clear.
    expect(file.includes(Buffer.from("PGDMP"))).toBe(false);
    expect(file.includes(Buffer.from("backup-marker"))).toBe(false);
  });

  it("passes the automated restore test and leaves no scratch database", async () => {
    const report = await service.verify(backupId, privateKey);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual([
      "file checksum",
      "restore",
      "schema version",
      "tenant identity",
      "row counts",
      "foreign keys valid",
      "integrity: journal entries balanced",
      "integrity: trial balance",
      "integrity: payment allocations",
      "integrity: invoice payments",
      "integrity: work and pay allocations",
      "integrity: work and pay rows",
      "integrity: work and pay receivables",
      "integrity: work and pay unearned income",
    ]);
    expect((await catalog.find(backupId))?.verifiedAt).toBeInstanceOf(Date);
    expect(await scratchDatabases()).toEqual([]);
  });

  it("restores into a new database that the tenant role can use", async () => {
    const target = `${TEST_DATABASE.tenantPrefix}restored_${randomBytes(4).toString("hex")}`;
    await service.restore(backupId, privateKey, target);

    const factory = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
    const client = await factory.connect("tenant", target);
    try {
      const { rows } = await client.query<{ tenant_id: string; value: string }>(
        "select (select tenant_id from tenant_info) as tenant_id, (select value from counters where key = 'backup-marker') as value",
      );
      expect(rows[0]).toEqual({ tenant_id: tenant.id.value, value: "42" });
    } finally {
      await client.end();
    }
    await expect(service.restore(backupId, privateKey, target)).rejects.toThrow(/already exists/);
  });

  it("detects a modified backup file", async () => {
    const record = await service.backupTenant(tenant.id.value);
    const path = join(directory, record.location!);
    const file = await readFile(path);
    file[file.length - 10]! ^= 0xff;
    await writeFile(path, file);

    const report = await service.verify(record.id, privateKey);
    expect(report.passed).toBe(false);
    expect(report.checks).toEqual([{ name: "file checksum", passed: false }]);
    await expect(
      service.restore(
        record.id,
        privateKey,
        `${TEST_DATABASE.tenantPrefix}never_${randomUUID().slice(0, 8)}`,
      ),
    ).rejects.toThrow(/checksum/);
  });

  it("records a failed backup (registered tenant whose database is missing)", async () => {
    const ghost = randomUUID();
    await container
      .get<pg.Pool>(TYPES.PlatformDatabasePool)
      .query("insert into tenants (id, slug, name, status) values ($1, $2, 'Ghost', 'active')", [
        ghost,
        `ghost-${ghost.slice(0, 8)}`,
      ]);
    await expect(service.backupTenant(ghost)).rejects.toThrow();
    const [latest] = await catalog.recent(1);
    expect(latest).toMatchObject({ status: "failed", tenantId: ghost });
    expect(latest?.error).toBeTruthy();
  });
});

describe("platform backup", () => {
  it("dumps and verifies the platform database (including the job queue schema)", async () => {
    const record = await service.backupPlatform();
    expect(record.rowCounts).toHaveProperty("tenants");
    const report = await service.verify(record.id, privateKey);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("refuses to restore over the platform database", async () => {
    const [platform] = (await catalog.recent(10)).filter((r) => r.kind === "platform");
    await expect(
      service.restore(platform!.id, privateKey, testConfig().database.platformDatabase),
    ).rejects.toThrow(/Refusing/);
  });
});
