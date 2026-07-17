import { HttpStatusCode } from "../utils/constants";
import { BaseError } from "./BaseError";

export class ServiceUnavailableError extends BaseError {
  constructor(message: string) {
    super(
      "Service Unavailable",
      HttpStatusCode.SERVICE_UNAVAILABLE,
      message,
      true,
    );
  }
}
