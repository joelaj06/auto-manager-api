import { HttpStatusCode } from "../utils/constants";
import { BaseError } from "./BaseError";

export class NotFoundError extends BaseError {
  constructor(message: string) {
    super("Not Found", HttpStatusCode.NOT_FOUND, message, true);
  }
}
