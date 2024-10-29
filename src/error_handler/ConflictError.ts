import { HttpStatusCode } from "../utils";
import { BaseError } from "./BaseError";

export class ConflictError extends BaseError {
  constructor(message: string) {
    super("Not Found", HttpStatusCode.CONFLICT, message, true);
  }
}
