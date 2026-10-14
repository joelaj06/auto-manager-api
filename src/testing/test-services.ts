import { databaseServices } from "../bootstrap/database.js";
import { testConfig } from "./test-database.js";

/**
 * Database services wired exactly as the app wires them, but against the test databases.
 * Tests in shared/ and platform/ use this instead of importing bootstrap/ directly, which the
 * architecture rules forbid.
 */
export function testDatabaseServices(overrides: NodeJS.ProcessEnv = {}) {
  return databaseServices(testConfig(overrides));
}
