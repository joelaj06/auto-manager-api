import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseServices } from "../../testing/test-services.js";
import {
  loadMigrationSets,
  parseMigration,
  type Migration,
} from "../../shared/db/migrations/migration-files.js";
import { migrateDatabase, readSchemaVersion } from "../../shared/db/migrations/migrator.js";
import { tenantDatabaseName } from "../../shared/db/naming.js";
import { dropTestDatabase } from "../../testing/databases.js";
import { connectAdmin, TEST_DATABASE, testConfig } from "../../testing/test-database.js";
import { TenantDatabaseFactory } from "./tenant-database-factory.js";
import { migrateTemplateAndTenants } from "./schema-migrations.js";

/**
 * Fan-out uses its own template so adding a test migration never leaks into the shared test
 * template used by other files.
 */
const FANOUT_TEMPLATE = "tenant_template_fanout_test";
const config = testConfig();
const services = testDatabaseServices();
const databaseNameFor = (id: string) => tenantDatabaseName(TEST_DATABASE.tenantPrefix, id);

let baseMigrations: Migration[];
let platform: pg.Client;
const tenantIds = [randomUUID(), randomUUID(), randomUUID()];
const brokenTenantId = randomUUID();

beforeAll(async () => {
  baseMigrations = (await loadMigrationSets(config.database.migrationsDir)).tenant;

  const admin = await connectAdmin();
  await dropTestDatabase(admin, FANOUT_TEMPLATE);
  await admin.query(
    `create database ${pg.escapeIdentifier(FANOUT_TEMPLATE)} owner ${pg.escapeIdentifier(TEST_DATABASE.roles.migrator.user)}`,
  );
  await admin.query(
    `revoke connect on database ${pg.escapeIdentifier(FANOUT_TEMPLATE)} from public`,
  );
  await admin.query(`alter database ${pg.escapeIdentifier(FANOUT_TEMPLATE)} is_template true`);
  await admin.end();

  const template = await services.connectAsMigrator(FANOUT_TEMPLATE);
  await migrateDatabase(template, baseMigrations);
  await template.end();

  const factory = new TenantDatabaseFactory({
    connectAsMigrator: services.connectAsMigrator,
    maintenanceDatabase: config.database.platformDatabase,
    templateDatabase: FANOUT_TEMPLATE,
    databaseNameFor,
  });

  platform = await services.connectAsMigrator(config.database.platformDatabase);
  for (const [i, id] of tenantIds.entries()) {
    const { databaseName } = await factory.create(id);
    await platform.query(
      "insert into tenants (id, slug, name, status, database_name) values ($1, $2, $3, 'active', $4)",
      [id, `fanout-${i}-${id.slice(0, 8)}`, `Fan-out ${i}`, databaseName],
    );
  }
  // A tenant row whose database is missing: its failure must not stop the others.
  await platform.query(
    "insert into tenants (id, slug, name, status, database_name) values ($1, $2, 'Broken', 'active', $3)",
    [
      brokenTenantId,
      `fanout-broken-${brokenTenantId.slice(0, 8)}`,
      databaseNameFor(brokenTenantId),
    ],
  );
});

afterAll(async () => {
  const ids = [...tenantIds, brokenTenantId];
  await platform.query("delete from tenant_schema_status where tenant_id = any($1::uuid[])", [ids]);
  await platform.query("delete from tenants where id = any($1::uuid[])", [ids]);
  await platform.end();
  const admin = await connectAdmin();
  await dropTestDatabase(admin, FANOUT_TEMPLATE);
  await admin.end();
});

describe("migrateTemplateAndTenants", () => {
  it("migrates the template and every tenant, isolating failures", async () => {
    const probe = parseMigration(
      "9001_fanout_probe.sql",
      "create table fanout_probe (id int primary key);",
    );

    const report = await migrateTemplateAndTenants({
      platform,
      connectAsMigrator: services.connectAsMigrator,
      templateDatabase: FANOUT_TEMPLATE,
      migrations: [...baseMigrations, probe],
      concurrency: 2,
    });

    expect(report.template.applied).toEqual(["9001"]);
    expect(report.tenantsMigrated).toBeGreaterThanOrEqual(tenantIds.length);
    expect(report.failures.map((f) => f.tenantId)).toContain(brokenTenantId);

    for (const id of tenantIds) {
      const client = await services.connectAsMigrator(databaseNameFor(id));
      expect(await readSchemaVersion(client)).toBe("9001");
      await client.end();
    }

    const { rows } = await platform.query<{
      tenant_id: string;
      status: string;
      schema_version: string | null;
    }>(
      "select tenant_id::text, status, schema_version from tenant_schema_status where tenant_id = any($1::uuid[])",
      [[...tenantIds, brokenTenantId]],
    );
    const byTenant = new Map(rows.map((row) => [row.tenant_id, row]));
    for (const id of tenantIds) {
      expect(byTenant.get(id)).toMatchObject({ status: "ok", schema_version: "9001" });
    }
    expect(byTenant.get(brokenTenantId)).toMatchObject({ status: "failed" });
  });

  it("is a no-op when everything is current", async () => {
    const probe = parseMigration(
      "9001_fanout_probe.sql",
      "create table fanout_probe (id int primary key);",
    );
    const report = await migrateTemplateAndTenants({
      platform,
      connectAsMigrator: services.connectAsMigrator,
      templateDatabase: FANOUT_TEMPLATE,
      migrations: [...baseMigrations, probe],
    });
    expect(report.template.applied).toEqual([]);
    expect(report.tenantsMigrated).toBe(0);
  });
});
