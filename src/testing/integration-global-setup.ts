import { migrateAll } from "../bootstrap/commands/migrate-all.js";
import { setupCluster } from "../platform/tenancy/cluster-setup.js";
import { dropDatabasesWithPrefix, dropTestDatabase } from "./databases.js";
import { connectAdmin, TEST_DATABASE, testConfig } from "./test-database.js";

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
    await setupCluster({
      admin,
      roles: TEST_DATABASE.roles,
      platformDatabase: TEST_DATABASE.platformDatabase,
      tenantTemplateDatabase: TEST_DATABASE.templateDatabase,
    });
  } finally {
    await admin.end();
  }

  await migrateAll(testConfig(), () => undefined);

  return async () => {
    const cleanup = await connectAdmin();
    try {
      await dropDatabasesWithPrefix(cleanup, TEST_DATABASE.tenantPrefix);
    } finally {
      await cleanup.end();
    }
  };
}
