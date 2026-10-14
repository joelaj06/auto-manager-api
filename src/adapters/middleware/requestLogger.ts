import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ILogger } from "../../application/ports/ILogger.js";

/**
 * One log line per request when the response finishes: method, path, status, duration, client.
 * Bodies, query strings and headers are deliberately not logged (they can contain secrets).
 * Health probes are logged at debug level to keep the logs readable.
 */
export function requestLogger(logger: ILogger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      };
      if (req.path.startsWith("/health/")) logger.debug("Request completed", fields);
      else if (res.statusCode >= 500) logger.error("Request completed", fields);
      else logger.info("Request completed", fields);
    });

    next();
  };
}
