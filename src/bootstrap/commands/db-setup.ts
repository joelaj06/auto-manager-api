import pg from "pg";
import { z } from "zod";
import { setupCluster } from "../../platform/tenancy/cluster-setup.js";
import { loadConfig } from "../../shared/config/config.js";
import { migrateAll } from "./migrate-all.js";
import { log, runCommand } from "./run-command.js";

/**
 * yarn db:setup — one-time (idempotent) cluster bootstrap for local development and new
 * environments: creates roles and databases, then runs every migration.
 *
 * Needs DATABASE_ADMIN_URL: a superuser connection string, used only by this command and never
 * by the running application.
 */
runCommand("db:setup", async () => {
  const config = loadConfig();
  const adminUrl = z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")
    .safeParse(process.env.DATABASE_ADMIN_URL);
  if (!adminUrl.success) {
    console.error("DATABASE_ADMIN_URL is required (superuser connection, used only for setup).");
    return 1;
  }

  const admin = new pg.Client({
    connectionString: adminUrl.data,
    application_name: "autoforce-setup",
  });
  await admin.connect();
  try {
    console.info("Setting up roles and databases…");
    await setupCluster({
      admin,
      roles: config.database.roles,
      platformDatabase: config.database.platformDatabase,
      tenantTemplateDatabase: config.database.tenantTemplateDatabase,
      log,
    });
  } finally {
    await admin.end();
  }

  console.info("Migrating databases…");
  const report = await migrateAll(config, log);
  if (report.tenants.failures.length > 0) {
    console.error(`${report.tenants.failures.length} tenant database(s) failed to migrate.`);
    return 1;
  }
  console.info("Done.");
  return 0;
});
