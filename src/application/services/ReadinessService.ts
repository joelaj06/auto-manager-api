import type { ILogger } from "../ports/ILogger.js";
import type { IReadinessCheck } from "../ports/IReadinessCheck.js";

export type ReadinessCheckResult = Readonly<{
  name: string;
  status: "up" | "down";
  durationMs: number;
}>;

export type ReadinessReport = Readonly<{
  ready: boolean;
  checks: ReadinessCheckResult[];
}>;

/**
 * Runs every readiness check in parallel, each bounded by a timeout. Failure details are logged,
 * never returned, so the readiness endpoint cannot leak infrastructure information.
 */
export class ReadinessService {
  constructor(
    private readonly checks: readonly IReadinessCheck[],
    private readonly logger: ILogger,
    private readonly timeoutMs = 2_000,
  ) {}

  async report(): Promise<ReadinessReport> {
    const results = await Promise.all(this.checks.map((check) => this.run(check)));
    return { ready: results.every((r) => r.status === "up"), checks: results };
  }

  private async run(check: IReadinessCheck): Promise<ReadinessCheckResult> {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check.check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${this.timeoutMs} ms`)),
            this.timeoutMs,
          );
        }),
      ]);
      return { name: check.name, status: "up", durationMs: Date.now() - started };
    } catch (error) {
      this.logger.warn("Readiness check failed", { check: check.name, error });
      return { name: check.name, status: "down", durationMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
}
