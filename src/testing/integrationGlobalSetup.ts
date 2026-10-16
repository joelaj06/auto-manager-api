import { disposeContainer } from "../framework/dependency-injection/container.js";
import { DatabaseMigrationService } from "../framework/cli/DatabaseMigrationService.js";
import { ClusterBootstrapper } from "../infrastructure/database/provisioning/ClusterBootstrapper.js";
import { dropDatabasesWithPrefix, dropTestDatabase } from "./databases.js";
import { createTestContainer } from "./testContainer.js";
import { connectAdmin, TEST_DATABASE } from "./testDatabase.js";
import { startTestInfrastructure, testInfraMode } from "./testInfrastructure.js";

/**
 * Vitest global setup for the integration project:
 * 1. starts throw-away PostgreSQL and Mailpit containers (unless TEST_INFRA=external) and exports
 *    their addresses to the test workers through the environment;
 * 2. rebuilds the test platform and template databases from scratch through the same code paths
 *    as `yarn db:setup` and `yarn db:migrate`;
 * 3. removes all test tenant databases afterwards (or the containers, with all their data).
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (testInfraMode() === "containers") {
    const infrastructure = await startTestInfrastructure();
    // Test workers are started after global setup and inherit this environment.
    Object.assign(process.env, infrastructure.env);
    try {
      await prepareDatabases();
    } catch (error) {
      await infrastructure.stop();
      throw error;
    }
    return infrastructure.stop;
  }

  await prepareDatabases();
  return async () => {
    const cleanup = await connectAdmin();
    try {
      await dropDatabasesWithPrefix(cleanup, TEST_DATABASE.tenantPrefix);
    } finally {
      await cleanup.end();
    }
  };
}

async function prepareDatabases(): Promise<void> {
  const admin = await connectAdmin();
  try {
    await dropDatabasesWithPrefix(admin, TEST_DATABASE.tenantPrefix);
    await dropTestDatabase(admin, TEST_DATABASE.platformDatabase);
    await dropTestDatabase(admin, TEST_DATABASE.templateDatabase);
    await new ClusterBootstrapper(admin).bootstrap({
      roles: TEST_DATABASE.roles,
      platformDatabase: TEST_DATABASE.platformDatabase,
      tenantTemplateDatabase: TEST_DATABASE.templateDatabase,
    });
  } finally {
    await admin.end();
  }

  const container = await createTestContainer();
  try {
    await DatabaseMigrationService.fromContainer(container, () => undefined).migrateAll();
  } finally {
    await disposeContainer(container);
  }
}
