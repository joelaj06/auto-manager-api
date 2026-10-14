import { ConfigError, loadConfig } from "../shared/config/config.js";
import { createContainer } from "./container.js";

/**
 * Process entry point. Loads configuration and builds the composition root.
 * The HTTP server, database pools and workers are attached in later Phase 0 work packages.
 */
function main(): void {
  const config = loadConfig();
  const container = createContainer(config);

  console.info(
    `autoforce-manager-api bootstrapped (env=${container.config.env}, port=${container.config.port})`,
  );
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Fatal error during startup", error);
  }
  process.exitCode = 1;
}
