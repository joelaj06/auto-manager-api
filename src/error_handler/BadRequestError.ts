import { HttpStatusCode } from "../utils";
import { BaseError } from "./BaseError";

export class BadRequestError extends BaseError {
  constructor(description = "Bad Request") {
    super("Bad Request", HttpStatusCode.BAD_REQUEST, description, true);
  }
}
