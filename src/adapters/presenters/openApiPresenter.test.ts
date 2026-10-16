import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineRoute } from "../routes/ApiRoute.js";
import { idParams, paginationQuery } from "../validators/commonRequests.js";
import { buildOpenApiDocument } from "./openApiPresenter.js";
import { dataEnvelope } from "./responseEnvelope.js";
import { access } from "../routes/RouteAccess.js";

const routes = [
  defineRoute({
    method: "get",
    path: "/api/v1/vehicles",
    summary: "List vehicles",
    tags: ["vehicles"],
    access: access.public(),
    request: { query: paginationQuery },
    responses: {
      200: {
        description: "A page of vehicles",
        schema: dataEnvelope(z.array(z.object({ id: z.string() }))),
      },
    },
    handler: () => undefined,
  }),
  defineRoute({
    method: "patch",
    path: "/api/v1/vehicles/:id",
    summary: "Update a vehicle",
    tags: ["vehicles"],
    access: access.public(),
    request: { params: idParams, body: z.object({ colour: z.string().min(1) }) },
    responses: { 200: { description: "Updated" } },
    handler: () => undefined,
  }),
];

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument(routes, { title: "Autoforce", version: "1.0.0" });

  it("produces an OpenAPI 3.1 document with every route", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(["/api/v1/vehicles", "/api/v1/vehicles/{id}"]);
  });

  it("documents query and path parameters", () => {
    const list = doc.paths["/api/v1/vehicles"]?.get as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(list.parameters).toEqual([
      expect.objectContaining({ name: "limit", in: "query", required: false }),
      expect.objectContaining({ name: "cursor", in: "query", required: false }),
    ]);

    const update = doc.paths["/api/v1/vehicles/{id}"]?.patch as {
      operationId: string;
      parameters: { name: string; in: string; required: boolean }[];
      requestBody: { content: Record<string, { schema: { required: string[] } }> };
    };
    expect(update.operationId).toBe("patchApiV1VehiclesId");
    expect(update.parameters).toEqual([
      expect.objectContaining({ name: "id", in: "path", required: true }),
    ]);
    expect(update.requestBody.content["application/json"]?.schema.required).toEqual(["colour"]);
  });

  it("adds the error envelope as the default response", () => {
    const op = doc.paths["/api/v1/vehicles"]?.get as { responses: Record<string, unknown> };
    expect(op.responses).toHaveProperty("default");
    expect(op.responses).toHaveProperty("200");
  });
});
