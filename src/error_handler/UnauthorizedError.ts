import { HttpStatusCode } from "../utils";
import { BaseError } from "./BaseError";

export class UnauthorizedError extends BaseError {
  constructor(message: string) {
    super("Not Found", HttpStatusCode.UNAUTHORIZED, message, true);
  }
}
