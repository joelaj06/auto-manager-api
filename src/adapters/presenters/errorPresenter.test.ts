import { describe, expect, it } from "vitest";
import { InvalidCursorError } from "../../application/errors/PaginationErrors.js";
import {
  MissingTenantContextError,
  TenantDatabaseMismatchError,
  TenantSchemaOutdatedError,
} from "../../application/errors/TenantDatabaseErrors.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import { InvalidTenantIdError } from "../../domain/errors/TenantErrors.js";
import { RateLimitedError, RouteNotFoundError } from "../middleware/httpErrors.js";
import { RequestValidationError } from "../validators/RequestValidationError.js";
import { presentError } from "./errorPresenter.js";

class VehicleAlreadyRentedError extends DomainError {
  readonly code = "VEHICLE_ALREADY_RENTED";
  constructor() {
    super("The vehicle is already rented for these dates");
  }
}

describe("presentError", () => {
  it("maps validation errors to 400 with field details", () => {
    const presented = presentError(
      new RequestValidationError([{ field: "body.email", message: "Invalid email" }]),
      "req-1",
    );
    expect(presented.status).toBe(400);
    expect(presented.body).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "The request is invalid",
        details: [{ field: "body.email", message: "Invalid email" }],
        requestId: "req-1",
      },
    });
  });

  it("maps domain rule violations to 422 with their message", () => {
    const presented = presentError(new VehicleAlreadyRentedError());
    expect(presented.status).toBe(422);
    expect(presented.body.error).toMatchObject({
      code: "VEHICLE_ALREADY_RENTED",
      message: "The vehicle is already rented for these dates",
    });
    expect(presented.logLevel).toBe("warn");
  });

  it.each([
    [new InvalidTenantIdError(), 400, "INVALID_TENANT_ID"],
    [new InvalidCursorError(), 400, "INVALID_CURSOR"],
    [new RouteNotFoundError("GET", "/x"), 404, "ROUTE_NOT_FOUND"],
    [new RateLimitedError(), 429, "RATE_LIMITED"],
    [new TenantSchemaOutdatedError("t", "0001", "0002"), 503, "TENANT_SCHEMA_OUTDATED"],
  ])("maps %s", (error, status, code) => {
    const presented = presentError(error);
    expect(presented.status).toBe(status);
    expect(presented.body.error.code).toBe(code);
  });

  it("hides internal details of 5xx errors", () => {
    const presented = presentError(new TenantSchemaOutdatedError("tenant-x", "0001", "0002"));
    expect(presented.body.error.message).not.toContain("tenant-x");
  });

  it("treats a database identity mismatch as a security alert with a generic message", () => {
    const presented = presentError(new TenantDatabaseMismatchError("a", "b", "t_db"));
    expect(presented.status).toBe(500);
    expect(presented.securityAlert).toBe(true);
    expect(JSON.stringify(presented.body)).not.toMatch(/t_db|belongs/);
  });

  it("hides unmapped application errors and unknown errors entirely", () => {
    for (const error of [
      new MissingTenantContextError(),
      new Error("SELECT * FROM secrets failed"),
      "x",
    ]) {
      const presented = presentError(error);
      expect(presented.status).toBe(500);
      expect(presented.body.error.code).toBe("INTERNAL_ERROR");
      expect(presented.body.error.message).toBe("Something went wrong. Please try again later.");
      expect(presented.logLevel).toBe("error");
    }
  });

  it("translates body-parser errors", () => {
    expect(presentError({ type: "entity.parse.failed" }).body.error.code).toBe("INVALID_JSON");
    expect(presentError({ type: "entity.too.large" }).status).toBe(413);
  });

  it("never includes a stack trace", () => {
    const presented = presentError(new Error("boom"));
    expect(JSON.stringify(presented.body)).not.toContain("stack");
  });
});
