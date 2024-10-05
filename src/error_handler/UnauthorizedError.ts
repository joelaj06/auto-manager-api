import { HttpStatusCode } from "../utils";
import { BaseError } from "./BaseError";

export class UnauthorizedError extends BaseError {
  constructor(message: string) {
    super("Unauthorized", HttpStatusCode.UNAUTHORIZED, message, true);
  }
}
