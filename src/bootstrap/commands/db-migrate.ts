import { loadConfig } from "../../shared/config/config.js";
import { migrateAll } from "./migrate-all.js";
import { log, runCommand } from "./run-command.js";

/** yarn db:migrate — migrates the platform DB, the tenant template and every tenant DB. */
runCommand("db:migrate", async () => {
  const config = loadConfig();
  console.info("Migrating databases…");
  const report = await migrateAll(config, log);
  if (report.tenants.failures.length > 0) {
    console.error(`${report.tenants.failures.length} tenant database(s) failed to migrate.`);
    return 1;
  }
  console.info("Done.");
  return 0;
});
