import { ConfigError, loadConfig } from "../shared/config/config.js";
import { latestVersion, loadMigrationSets } from "../shared/db/migrations/migration-files.js";
import { createContainer } from "./container.js";

/**
 * Process entry point. Loads configuration and builds the composition root.
 * The HTTP server and workers are attached in later Phase 0 work packages.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const migrations = await loadMigrationSets(config.database.migrationsDir);
  const container = createContainer(config, {
    requiredTenantSchemaVersion: latestVersion(migrations.tenant),
  });

  console.info(
    `autoforce-manager-api bootstrapped (env=${config.env}, port=${config.port}, ` +
      `tenant schema=${latestVersion(migrations.tenant) ?? "none"})`,
  );

  // Nothing is served yet (HTTP arrives in P0-6), so release resources and exit cleanly.
  await container.close();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Fatal error during startup", error);
  }
  process.exitCode = 1;
});
