// Module import
import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "inversify";
import { ILogger } from "../../logging";
import { INTERFACE_TYPE } from "../../../utils";
// Interface import

@injectable()
export class LoggingMiddleware {
  constructor(
    @inject(INTERFACE_TYPE.Logger) private readonly _logger: ILogger
  ) {}

  // This middleware will each incoming request executed
  public logRequest() {
    return (req: Request, _res: Response, next: NextFunction): void => {
      this._logger.info("Incoming request", {
        method: req.method,
        url: req.url,
        body: req.body,
        params: req.params,
        query: req.query,
      });
      next();
    };
  }
}
