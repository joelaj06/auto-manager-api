import { disposeContainer } from "../framework/dependency-injection/container.js";
import { DatabaseMigrationService } from "../framework/cli/DatabaseMigrationService.js";
import { ClusterBootstrapper } from "../infrastructure/database/provisioning/ClusterBootstrapper.js";
import { dropDatabasesWithPrefix, dropTestDatabase } from "./databases.js";
import { createTestContainer } from "./testContainer.js";
import { connectAdmin, TEST_DATABASE } from "./testDatabase.js";

/**
 * Vitest global setup for the integration project: rebuilds the test platform and template
 * databases from scratch through the same code paths as `yarn db:setup`, and removes all test
 * tenant databases before and after the run.
 */
export default async function setup(): Promise<() => Promise<void>> {
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

  return async () => {
    const cleanup = await connectAdmin();
    try {
      await dropDatabasesWithPrefix(cleanup, TEST_DATABASE.tenantPrefix);
    } finally {
      await cleanup.end();
    }
  };
}
