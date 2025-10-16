import { HttpStatusCode } from "../utils/constants";

export class BaseError extends Error {
  public readonly name: string;
  public readonly statusCode: HttpStatusCode;
  public readonly isOperational: boolean;

  constructor(
    name: string,
    statusCode: HttpStatusCode,
    description: string,
    isOperational: boolean
  ) {
    super(description);
    Object.setPrototypeOf(this, new.target.prototype);

    this.name = name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    Error.captureStackTrace(this);
  }
}
