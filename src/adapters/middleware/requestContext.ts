import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { IRequestContext } from "../../application/ports/IRequestContext.js";

export const REQUEST_ID_HEADER = "x-request-id";
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Gives every request an id (the caller's x-request-id when well-formed, otherwise a new UUID),
 * echoes it in the response, and runs the rest of the request inside the request context so
 * logs and errors anywhere downstream carry it.
 */
export function requestContext(context: IRequestContext): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId =
      incoming !== undefined && ACCEPTED_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.locals.requestId = requestId;

    context.run(
      { requestId, method: req.method, path: req.path, ...(req.ip ? { ip: req.ip } : {}) },
      () => next(),
    );
  };
}
