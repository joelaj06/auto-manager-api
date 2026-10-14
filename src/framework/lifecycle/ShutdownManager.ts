import type { ILogger } from "../../application/ports/ILogger.js";

type Hook = Readonly<{ name: string; run: () => Promise<void> }>;

/**
 * Graceful shutdown: runs registered hooks in reverse registration order (last started, first
 * stopped — e.g. stop accepting HTTP requests before closing database pools). Each hook gets
 * whatever remains of the overall timeout; a failing or hanging hook is logged and skipped so
 * the rest still run. Calling shutdown() again returns the same in-flight result.
 */
export class ShutdownManager {
  private readonly hooks: Hook[] = [];
  private inFlight: Promise<boolean> | undefined;

  constructor(
    private readonly logger: ILogger,
    private readonly timeoutMs: number,
  ) {}

  register(name: string, run: () => Promise<void>): void {
    if (this.inFlight !== undefined) throw new Error("Cannot register hooks during shutdown");
    this.hooks.push({ name, run });
  }

  get isShuttingDown(): boolean {
    return this.inFlight !== undefined;
  }

  /** Resolves true when every hook finished cleanly within the timeout. */
  shutdown(reason: string): Promise<boolean> {
    this.inFlight ??= this.runHooks(reason);
    return this.inFlight;
  }

  private async runHooks(reason: string): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;
    this.logger.info("Shutting down", { reason });
    let clean = true;

    for (const hook of [...this.hooks].reverse()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.logger.error("Shutdown timed out before hook", { hook: hook.name });
        clean = false;
        continue;
      }
      try {
        await ShutdownManager.withTimeout(hook.run(), remaining, hook.name);
        this.logger.debug("Shutdown hook finished", { hook: hook.name });
      } catch (error) {
        clean = false;
        this.logger.error("Shutdown hook failed", { hook: hook.name, error });
      }
    }

    this.logger.info("Shutdown complete", { clean });
    return clean;
  }

  private static async withTimeout(work: Promise<void>, ms: number, name: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
