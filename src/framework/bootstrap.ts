import type { Express } from "express";
import type { ILogger } from "../application/ports/ILogger.js";
import { loadConfig } from "../infrastructure/config/config.js";
import { MigrationSets } from "../infrastructure/database/migrations/MigrationCatalog.js";
import { createContainer, disposeContainer } from "./dependency-injection/container.js";
import { TYPES } from "./dependency-injection/types.js";
import { closeHttpServer, startHttpServer } from "./express/httpServer.js";
import { installSignalHandlers } from "./lifecycle/installSignalHandlers.js";
import { ShutdownManager } from "./lifecycle/ShutdownManager.js";

/**
 * Starts the API process: configuration → migration catalogue → container → HTTP server, and
 * registers graceful shutdown (stop accepting requests first, then release database pools).
 */
export async function bootstrapApi(): Promise<void> {
  const config = loadConfig();
  const migrations = await MigrationSets.load(config.database.migrationsDir);
  const container = createContainer(config, migrations);
  const logger = container.get<ILogger>(TYPES.Logger);

  const shutdown = new ShutdownManager(logger, config.shutdownTimeoutMs);
  shutdown.register("container", () => disposeContainer(container));

  const server = await startHttpServer(container.get<Express>(TYPES.HttpApp), config.port);
  shutdown.register("http", () => closeHttpServer(server));
  installSignalHandlers(shutdown, logger);

  logger.info("API listening", {
    port: config.port,
    env: config.env,
    tenantSchema: migrations.tenant.latestVersion,
    platformSchema: migrations.platform.latestVersion,
  });
}
