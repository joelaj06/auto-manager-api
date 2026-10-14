import pg from "pg";
import { z } from "zod";
import { loadConfig } from "../../infrastructure/config/config.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import { ClusterBootstrapper } from "../../infrastructure/database/provisioning/ClusterBootstrapper.js";
import { createContainer, disposeContainer } from "../dependency-injection/container.js";
import { DatabaseMigrationService } from "./DatabaseMigrationService.js";
import { log, runCommand } from "./runCommand.js";

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
    await new ClusterBootstrapper(admin, log).bootstrap({
      roles: config.database.roles,
      platformDatabase: config.database.platformDatabase,
      tenantTemplateDatabase: config.database.tenantTemplateDatabase,
    });
  } finally {
    await admin.end();
  }

  const container = createContainer(
    config,
    await MigrationSets.load(config.database.migrationsDir),
  );
  try {
    console.info("Migrating databases…");
    const report = await DatabaseMigrationService.fromContainer(container, log).migrateAll();
    if (report.tenants.failures.length > 0) {
      console.error(`${report.tenants.failures.length} tenant database(s) failed to migrate.`);
      return 1;
    }
    console.info("Done.");
    return 0;
  } finally {
    await disposeContainer(container);
  }
});
