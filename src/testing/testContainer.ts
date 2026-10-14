import type { Container } from "inversify";
import { createContainer } from "../framework/dependency-injection/container.js";
import { MigrationSets } from "../infrastructure/database/migrations/MigrationCatalog.js";
import { testConfig } from "./testDatabase.js";

/**
 * The application container wired exactly as in production, but pointed at the test databases.
 * Dispose it with disposeContainer() in afterAll.
 */
export async function createTestContainer(overrides: NodeJS.ProcessEnv = {}): Promise<Container> {
  const config = testConfig(overrides);
  return createContainer(config, await MigrationSets.load(config.database.migrationsDir));
}
