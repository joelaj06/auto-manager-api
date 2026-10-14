import { bootstrapApi } from "./framework/bootstrap.js";
import { ConfigError } from "./infrastructure/config/config.js";

/** API process entry point. */
bootstrapApi().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Fatal error during startup", error);
  }
  process.exitCode = 1;
});
