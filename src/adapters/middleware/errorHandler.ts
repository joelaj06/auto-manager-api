import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import type { ILogger } from "../../application/ports/ILogger.js";
import { presentError } from "../presenters/errorPresenter.js";
import { RouteNotFoundError } from "./httpErrors.js";

/** Catch-all after the routes: unknown method/path → 404 in the standard error envelope. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new RouteNotFoundError(req.method, req.path));
}

/**
 * Turns every error into the standard envelope and logs it once — with the stack for
 * server-side failures. The client never sees internals. Possible tenant-isolation breaches
 * are logged as security alerts.
 */
export function errorHandler(logger: ILogger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : undefined;
    const presented = presentError(error, requestId);

    // Server-side failures are logged with the full error (stack, cause); client errors only
    // with their code and message, to keep the logs readable.
    const serverFailure = presented.status >= 500;
    const fields = {
      method: req.method,
      path: req.path,
      status: presented.status,
      code: presented.body.error.code,
      ...(serverFailure
        ? { error }
        : { reason: error instanceof Error ? error.message : String(error) }),
      ...(presented.securityAlert ? { securityAlert: true } : {}),
    };
    logger[presented.logLevel](
      presented.securityAlert ? "SECURITY: request failed" : "Request failed",
      fields,
    );

    if (res.headersSent) {
      // Too late for a clean error response; let Express close the connection.
      next(error);
      return;
    }
    res.status(presented.status).json(presented.body);
  };
}
