import { randomUUID } from "node:crypto";
import type { Container } from "inversify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { disposeContainer } from "../../../framework/dependency-injection/container.js";
import { TYPES } from "../../../framework/dependency-injection/types.js";
import { dropTestDatabase } from "../../../testing/databases.js";
import { createTestContainer } from "../../../testing/testContainer.js";
import { connectAdmin, TEST_DATABASE, testConfig } from "../../../testing/testDatabase.js";
import type { PostgresConnectionFactory } from "../postgres/PostgresConnectionFactory.js";
import type { TenantDatabaseNaming } from "../postgres/TenantDatabaseNaming.js";
import { TenantDatabaseProvisioner } from "../provisioning/TenantDatabaseProvisioner.js";
import type { MigrationCatalog, MigrationSets } from "./MigrationCatalog.js";
import { MigrationFile } from "./MigrationFile.js";
import { MigrationRunner } from "./MigrationRunner.js";
import { TenantSchemaMigrator } from "./TenantSchemaMigrator.js";

/**
 * Uses its own template so adding a test migration never leaks into the shared test template
 * used by other files.
 */
const FANOUT_TEMPLATE = "tenant_template_fanout_test";
const config = testConfig();
const runner = new MigrationRunner();
const probe = MigrationFile.parse(
  "9001_fanout_probe.sql",
  "create table fanout_probe (id int primary key);",
);

let container: Container;
let connections: PostgresConnectionFactory;
let naming: TenantDatabaseNaming;
let base: MigrationCatalog;
let platform: pg.Client;
let migrator: TenantSchemaMigrator;
const tenantIds = [randomUUID(), randomUUID(), randomUUID()].map((id) => TenantId.from(id));
const brokenTenantId = TenantId.from(randomUUID());

beforeAll(async () => {
  container = await createTestContainer();
  connections = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
  naming = container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming);
  base = container.get<MigrationSets>(TYPES.MigrationSets).tenant;
  const connect = (database: string) => connections.connect("migrator", database);

  const admin = await connectAdmin();
  await dropTestDatabase(admin, FANOUT_TEMPLATE);
  const template = pg.escapeIdentifier(FANOUT_TEMPLATE);
  await admin.query(
    `create database ${template} owner ${pg.escapeIdentifier(TEST_DATABASE.roles.migrator.user)}`,
  );
  await admin.query(`revoke connect on database ${template} from public`);
  await admin.query(`alter database ${template} is_template true`);
  await admin.end();

  const templateClient = await connect(FANOUT_TEMPLATE);
  await runner.migrate(templateClient, base);
  await templateClient.end();

  const provisioner = new TenantDatabaseProvisioner({
    connect,
    maintenanceDatabase: config.database.platformDatabase,
    templateDatabase: FANOUT_TEMPLATE,
    databaseNameFor: (id) => naming.databaseNameFor(id),
  });

  platform = await connect(config.database.platformDatabase);
  for (const [i, id] of tenantIds.entries()) {
    const { databaseName } = await provisioner.provision(id);
    await platform.query(
      "insert into tenants (id, slug, name, status, database_name) values ($1, $2, $3, 'active', $4)",
      [id.value, `fanout-${i}-${id.value.slice(0, 8)}`, `Fan-out ${i}`, databaseName],
    );
  }
  // A tenant row whose database is missing: its failure must not stop the others.
  await platform.query(
    "insert into tenants (id, slug, name, status, database_name) values ($1, $2, 'Broken', 'active', $3)",
    [
      brokenTenantId.value,
      `fanout-broken-${brokenTenantId.value.slice(0, 8)}`,
      naming.databaseNameFor(brokenTenantId),
    ],
  );

  migrator = new TenantSchemaMigrator(runner, {
    connect,
    templateDatabase: FANOUT_TEMPLATE,
    concurrency: 2,
  });
});

afterAll(async () => {
  const ids = [...tenantIds, brokenTenantId].map((id) => id.value);
  await platform.query("delete from tenant_schema_status where tenant_id = any($1::uuid[])", [ids]);
  await platform.query("delete from tenants where id = any($1::uuid[])", [ids]);
  await platform.end();
  const admin = await connectAdmin();
  await dropTestDatabase(admin, FANOUT_TEMPLATE);
  await admin.end();
  await disposeContainer(container);
});

describe("TenantSchemaMigrator", () => {
  it("migrates the template and every tenant, isolating failures", async () => {
    const report = await migrator.migrate(platform, base.with(probe));

    expect(report.template.applied).toEqual(["9001"]);
    expect(report.tenantsMigrated).toBeGreaterThanOrEqual(tenantIds.length);
    expect(report.failures.map((f) => f.tenantId)).toContain(brokenTenantId.value);

    for (const id of tenantIds) {
      const client = await connections.connect("migrator", naming.databaseNameFor(id));
      expect(await MigrationRunner.readSchemaVersion(client)).toBe("9001");
      await client.end();
    }

    const { rows } = await platform.query<{
      tenant_id: string;
      status: string;
      schema_version: string | null;
    }>(
      "select tenant_id::text, status, schema_version from tenant_schema_status where tenant_id = any($1::uuid[])",
      [[...tenantIds, brokenTenantId].map((id) => id.value)],
    );
    const byTenant = new Map(rows.map((row) => [row.tenant_id, row]));
    for (const id of tenantIds) {
      expect(byTenant.get(id.value)).toMatchObject({ status: "ok", schema_version: "9001" });
    }
    expect(byTenant.get(brokenTenantId.value)).toMatchObject({ status: "failed" });
  });

  it("is a no-op when everything is current", async () => {
    const report = await migrator.migrate(platform, base.with(probe));
    expect(report.template.applied).toEqual([]);
    expect(report.tenantsMigrated).toBe(0);
  });
});
