import { describe, expect, it } from "vitest";
import { ResponseShapeExtractor, type RouteLocator } from "./ResponseShapeExtractor.js";

const route = (
  locator: Partial<RouteLocator> & Pick<RouteLocator, "file" | "path" | "summary">,
) => ({
  method: "GET",
  statuses: ["200"],
  ...locator,
});

describe("ResponseShapeExtractor", () => {
  const extractor = new ResponseShapeExtractor("tsconfig.json", "src/adapters/routes");

  it("reads an enveloped body, naming a type with no name after its route", () => {
    const shape = extractor.shapeOf(
      route({
        file: "sessionRoutes.ts",
        path: "/api/v1/me",
        summary: "Current user, business and permissions",
      }),
    );
    expect(shape).toMatchObject({
      kind: "json",
      envelope: true,
      data: { $ref: expect.any(String) },
    });
  });

  it("follows toJSON and leaves undefined out of a union", () => {
    const shape = extractor.shapeOf(
      route({
        file: "rentalAccountRoutes.ts",
        method: "POST",
        path: "/api/v1/rentals/:id/payments",
        summary:
          "Take a payment for the booking (applied to its invoices; the rest to the next one)",
      }),
    );
    expect(shape.kind).toBe("json");
    const money = JSON.stringify(extractor.components);
    expect(money).toContain('"amountMinor"');
    expect(money).not.toContain("x-undefined");
  });

  it("recognises a file and an empty answer", () => {
    expect(
      extractor.shapeOf(
        route({
          file: "billingRoutes.ts",
          path: "/api/v1/billing/invoices/:id/pdf",
          summary: "One of your invoices as a PDF",
        }),
      ).kind,
    ).toBe("binary");
    expect(
      extractor.shapeOf(
        route({
          file: "lifecycleRoutes.ts",
          method: "POST",
          path: "/api/v1/branches/:id/remove",
          summary: "Remove (no records only) a branch",
          statuses: ["204"],
        }),
      ).kind,
    ).toBe("empty");
  });
});
