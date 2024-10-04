import { injectable } from "inversify";
import { logger } from "../frameworks/logging/LoggerImpl";
import { BaseError } from "./BaseError";
import { IErrorHandler } from "./IErrorHandler";

@injectable()
export class ErrorHandlerImpl implements IErrorHandler {
  async handleError(err: Error): Promise<void> {
    await logger.error("An error occured", err);
    //TODO Add sentry
  }

  isTrustedError(error: Error) {
    if (error instanceof BaseError) {
      return error.isOperational;
    }
    return false;
  }
}
