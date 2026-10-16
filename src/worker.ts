import { bootstrapWorker } from "./framework/bootstrap.js";
import { ConfigError } from "./infrastructure/config/config.js";

/** Background worker entry point (jobs, scheduler, outbox, email). */
bootstrapWorker().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error("Fatal error during worker startup", error);
  }
  process.exitCode = 1;
});
