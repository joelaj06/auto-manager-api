import { NextFunction, Request, Response } from "express";

import { inject, injectable } from "inversify";
import { ILogger } from "../../logging";
import { BaseError } from "../../../error_handler/BaseError";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils/constants";

@injectable()
export class ErrorMiddleware {
  // private errorHandler: IErrorHandler;
  private logger: ILogger;

  constructor(@inject(INTERFACE_TYPE.Logger) logger: ILogger) {
    this.logger = logger;
  }

  // This middleware will be responsible for catching an error and sending a response
  execute() {
    return (
      err: Error,
      req: Request,
      res: Response,
      next: NextFunction
    ): void => {
      // Log the error details
      this.logger.error("Error processing request", {
        method: req.method,
        url: req.url,
        body: req.body,
        params: req.params,
        query: req.query,
        errorMessage: err.message,
      });

      // Handle specific errors
      console.log(err);
      if (err instanceof BaseError) {
        const { statusCode, message, stack } = err;
        this.logger.error("BaseError", { stack, message, statusCode });
        res.status(err.statusCode).json({ stack, message, statusCode });
      } else {
        // Handle other types of errors
        this.logger.error("Internal Server Error", err);
        res.status(HttpStatusCode.INTERNAL_SERVER_ERROR).json({
          stack: err.stack,
          message: "Internal Server Error",
          statusCode: HttpStatusCode.INTERNAL_SERVER_ERROR,
        });
      }
    };
  }
}
