import { loadConfig } from "../../infrastructure/config/config.js";
import { S3ObjectStorage } from "../../infrastructure/storage/S3ObjectStorage.js";
import { log, runCommand } from "./runCommand.js";

/**
 * yarn storage:setup — creates the private and public buckets if missing, makes the public one
 * anonymously readable and allows browser uploads from the web app and console (CORS).
 * Idempotent; run once per environment and after changing the allowed origins.
 */
runCommand("storage:setup", async () => {
  const config = loadConfig();
  const origins = [
    ...new Set([
      config.public.webAppUrl,
      config.auth.platform.consoleUrl,
      ...config.http.corsAllowedOrigins,
    ]),
  ].map((origin) => origin.replace(/\/$/, ""));
  const storage = new S3ObjectStorage(config.storage);
  try {
    await storage.setup(origins);
    log(`private bucket ${config.storage.privateBucket}: ready`);
    log(
      `public bucket  ${config.storage.publicBucket}: ready (public at ${config.storage.publicBaseUrl})`,
    );
    log(`browser uploads allowed from: ${origins.join(", ")}`);
    return 0;
  } finally {
    storage.destroy();
  }
});
