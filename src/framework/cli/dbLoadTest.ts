import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { mapWithConcurrency } from "../../infrastructure/concurrency/mapWithConcurrency.js";
import { loadConfig } from "../../infrastructure/config/config.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import { TenantConnectionPools } from "../../infrastructure/database/postgres/TenantConnectionPools.js";
import { TenantDatabaseNaming } from "../../infrastructure/database/postgres/TenantDatabaseNaming.js";
import { TenantDatabaseProvisioner } from "../../infrastructure/database/provisioning/TenantDatabaseProvisioner.js";
import { dropDatabasesWithPrefix } from "../../testing/databases.js";
import { runCommand } from "./runCommand.js";

/**
 * yarn db:load-test [--count 500] [--concurrency 4] [--max-pools 50] [--keep]
 *
 * Creates throw-away tenant databases (prefix lt_) from the template, opens each through the
 * tenant pool manager, and reports creation time, connection usage and disk use. Drops them at
 * the end unless --keep. Needs DATABASE_ADMIN_URL (for monitoring and cleanup).
 */
const PREFIX = "lt_";

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

runCommand("db:load-test", async () => {
  const { values } = parseArgs({
    options: {
      count: { type: "string", default: "500" },
      concurrency: { type: "string", default: "4" },
      "max-pools": { type: "string", default: "50" },
      keep: { type: "boolean", default: false },
    },
  });
  const count = Number(values.count);
  const concurrency = Number(values.concurrency);
  const maxPools = Number(values["max-pools"]);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (adminUrl === undefined) {
    console.error("DATABASE_ADMIN_URL is required.");
    return 1;
  }

  const config = loadConfig();
  const db = config.database;
  const migrations = await MigrationSets.load(db.migrationsDir);
  const connections = new PostgresConnectionFactory(db);
  const naming = new TenantDatabaseNaming(PREFIX);
  const databaseNameFor = (tenantId: TenantId) => naming.databaseNameFor(tenantId);
  const provisioner = new TenantDatabaseProvisioner({
    connect: (database) => connections.connect("migrator", database),
    maintenanceDatabase: db.platformDatabase,
    templateDatabase: db.tenantTemplateDatabase,
    databaseNameFor,
  });

  const admin = new pg.Client({
    connectionString: adminUrl,
    application_name: "autoforce-load-test",
  });
  await admin.connect();
  const clusterSize = async () => {
    const { rows } = await admin.query<{ bytes: string }>(
      "select sum(pg_database_size(datname))::text as bytes from pg_database",
    );
    return Number(rows[0]?.bytes ?? 0);
  };
  const tenantConnections = async () => {
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from pg_stat_activity where usename = $1",
      [db.roles.tenant.user],
    );
    return Number(rows[0]?.n ?? 0);
  };

  try {
    const leftovers = await dropDatabasesWithPrefix(admin, PREFIX);
    if (leftovers > 0) console.info(`Removed ${leftovers} leftover ${PREFIX} databases.`);
    const sizeBefore = await clusterSize();

    console.info(`Creating ${count} tenant databases (concurrency ${concurrency})…`);
    const tenantIds = Array.from({ length: count }, () => TenantId.from(randomUUID()));
    const createTimes: number[] = [];
    const createStart = performance.now();
    await mapWithConcurrency(tenantIds, concurrency, async (id, i) => {
      const t = performance.now();
      await provisioner.provision(id);
      createTimes.push(performance.now() - t);
      if ((i + 1) % 100 === 0) console.info(`  ${i + 1} created`);
    });
    const createTotal = performance.now() - createStart;
    createTimes.sort((a, b) => a - b);
    const sizeAfter = await clusterSize();

    console.info(`Opening every tenant through the pool manager (max ${maxPools} pools)…`);
    const pools = new TenantConnectionPools({
      clientConfigFor: (databaseName) => connections.clientConfig("tenant", databaseName),
      databaseNameFor,
      maxPools,
      maxConnectionsPerPool: db.tenantPools.maxConnections,
      idleTimeoutMs: db.tenantPools.idleTimeoutMs,
      statementTimeoutMs: db.statementTimeoutMs,
      requiredSchemaVersion: migrations.tenant.latestVersion,
    });
    let peakPools = 0;
    let peakConnections = 0;
    const queryTimes: number[] = [];
    const queryStart = performance.now();
    try {
      await mapWithConcurrency(tenantIds, 8, async (id, i) => {
        const t = performance.now();
        await pools.withTransaction(id, (tx) => tx.query("select 1"));
        queryTimes.push(performance.now() - t);
        peakPools = Math.max(peakPools, pools.stats().openPools);
        if (i % 50 === 0) peakConnections = Math.max(peakConnections, await tenantConnections());
      });
      peakConnections = Math.max(peakConnections, await tenantConnections());
    } finally {
      await pools.closeAll();
    }
    const queryTotal = performance.now() - queryStart;
    queryTimes.sort((a, b) => a - b);

    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    console.info("\nResults");
    console.info(`  databases created           ${count} in ${(createTotal / 1000).toFixed(1)} s`);
    console.info(
      `  create time per DB          p50 ${percentile(createTimes, 50).toFixed(0)} ms, p95 ${percentile(createTimes, 95).toFixed(0)} ms, max ${(createTimes.at(-1) ?? 0).toFixed(0)} ms`,
    );
    console.info(
      `  disk per tenant DB          ${mb((sizeAfter - sizeBefore) / count)} MB (cluster grew ${mb(sizeAfter - sizeBefore)} MB)`,
    );
    console.info(`  first query, all tenants    ${(queryTotal / 1000).toFixed(1)} s`);
    console.info(
      `  first query per tenant      p50 ${percentile(queryTimes, 50).toFixed(0)} ms, p95 ${percentile(queryTimes, 95).toFixed(0)} ms (includes opening and verifying the pool)`,
    );
    console.info(`  peak open pools             ${peakPools} (limit ${maxPools})`);
    console.info(`  peak tenant-app connections ${peakConnections}`);

    if (values.keep) {
      console.info(`\nKept the ${PREFIX} databases (--keep).`);
    } else {
      const dropped = await dropDatabasesWithPrefix(admin, PREFIX);
      console.info(`\nDropped ${dropped} ${PREFIX} databases.`);
    }
    return 0;
  } finally {
    await admin.end();
  }
});
