import { HttpStatusCode } from "../utils";
import { BaseError } from "./BaseError";

export class NotFoundError extends BaseError {
  constructor(message: string) {
    super("Not Found", HttpStatusCode.NOT_FOUND, message, true);
  }
}
