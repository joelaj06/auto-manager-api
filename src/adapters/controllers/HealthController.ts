import type { Response } from "express";
import type { ReadinessService } from "../../application/services/ReadinessService.js";
import { envelope } from "../presenters/responseEnvelope.js";

/**
 * Liveness: the process is up (never touches dependencies, so a slow database does not get the
 * container restarted). Readiness: dependencies answer, so the instance may receive traffic.
 */
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  live(res: Response): void {
    res.status(200).json(envelope({ status: "ok" }));
  }

  async ready(res: Response): Promise<void> {
    const report = await this.readiness.report();
    res.status(report.ready ? 200 : 503).json(
      envelope({
        status: report.ready ? "ready" : "not_ready",
        checks: report.checks.map(({ name, status }) => ({ name, status })),
      }),
    );
  }
}
