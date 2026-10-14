import type { ILogger } from "../../application/ports/ILogger.js";
import type { ShutdownManager } from "./ShutdownManager.js";

type ProcessLike = Pick<NodeJS.Process, "on" | "exit">;

/**
 * SIGTERM / SIGINT start a graceful shutdown and exit with 0 (clean) or 1. A second signal
 * forces an immediate exit. Unhandled errors are logged and shut the process down with exit 1,
 * because the process state can no longer be trusted.
 */
export function installSignalHandlers(
  shutdown: ShutdownManager,
  logger: ILogger,
  proc: ProcessLike = process,
): void {
  const stop = (reason: string, failure: boolean) => {
    if (shutdown.isShuttingDown) {
      logger.warn("Forced exit", { reason });
      proc.exit(1);
      return;
    }
    void shutdown.shutdown(reason).then((clean) => proc.exit(clean && !failure ? 0 : 1));
  };

  proc.on("SIGTERM", () => stop("SIGTERM", false));
  proc.on("SIGINT", () => stop("SIGINT", false));
  proc.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { error: reason });
    stop("unhandledRejection", true);
  });
  proc.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error });
    stop("uncaughtException", true);
  });
}
