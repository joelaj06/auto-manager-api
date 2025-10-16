import { HttpStatusCode } from "../utils/constants";
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
