import { loadConfig } from "../../infrastructure/config/config.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import { createContainer, disposeContainer } from "../dependency-injection/container.js";
import { DatabaseMigrationService } from "./DatabaseMigrationService.js";
import { log, runCommand } from "./runCommand.js";

/** yarn db:migrate — migrates the platform DB, the tenant template and every tenant DB. */
runCommand("db:migrate", async () => {
  const config = loadConfig();
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
