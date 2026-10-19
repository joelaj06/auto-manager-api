import { ApplicationError } from "./ApplicationError.js";

export class AssignmentNotFoundError extends ApplicationError {
  readonly code = "ASSIGNMENT_NOT_FOUND";
  constructor(message = "Assignment not found") {
    super(message);
  }
}

/**
 * The vehicle or the driver already has an assignment at that time (decision 9: one driver per
 * vehicle, one vehicle per driver) — 409.
 */
export class AssignmentConflictError extends ApplicationError {
  readonly code = "ASSIGNMENT_CONFLICT";
  constructor(message: string) {
    super(message);
  }
}

/** The vehicle cannot legally operate and the business blocks such vehicles — 422. */
export class VehicleNotCompliantError extends ApplicationError {
  readonly code = "VEHICLE_NOT_COMPLIANT";
  constructor(problems: readonly string[]) {
    super(`The vehicle cannot legally operate: ${problems.join(", ")}`);
  }
}
