import { ApplicationError } from "./ApplicationError.js";

export class VehicleBlockNotFoundError extends ApplicationError {
  readonly code = "VEHICLE_BLOCK_NOT_FOUND";
  constructor() {
    super("Block not found");
  }
}

/** The vehicle (or every vehicle of the class) is busy at that time — 409 (docs/22 §4). */
export class VehicleUnavailableError extends ApplicationError {
  readonly code = "VEHICLE_UNAVAILABLE";
  constructor(message = "The vehicle is already booked or blocked at that time") {
    super(message);
  }
}
