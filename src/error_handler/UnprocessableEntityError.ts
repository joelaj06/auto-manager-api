import { HttpStatusCode } from "../utils";
import { BaseError } from "./BaseError";

export class UnprocessableEntityError extends BaseError {
  constructor(message: string) {
    super(
      "Unprocessable Entity",
      HttpStatusCode.UNPROCESSABLE_ENTITY,
      message,
      true
    );
  }
}
