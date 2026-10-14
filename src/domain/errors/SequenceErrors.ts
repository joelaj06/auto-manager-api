import { DomainError } from "./DomainError.js";

export class InvalidSequenceCodeError extends DomainError {
  readonly code = "INVALID_SEQUENCE_CODE";

  constructor(reason: string) {
    super(`Invalid sequence code: ${reason}`);
  }
}
