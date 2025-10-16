import { HttpStatusCode } from "../utils/constants";
import { BaseError } from "./BaseError";

export class ConflictError extends BaseError {
  constructor(message: string) {
    super("Not Found", HttpStatusCode.CONFLICT, message, true);
  }
}
