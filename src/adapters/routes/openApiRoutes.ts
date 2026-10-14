import { z } from "zod";
import { buildOpenApiDocument, type OpenApiInfo } from "../presenters/openApiPresenter.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";

/** GET /api/v1/openapi.json — the document describing `routes` (and itself). */
export function openApiRoutes(routes: readonly ApiRoute[], info: OpenApiInfo): ApiRoute[] {
  const self = defineRoute({
    method: "get",
    path: "/api/v1/openapi.json",
    summary: "OpenAPI document",
    tags: ["meta"],
    responses: {
      200: { description: "OpenAPI 3.1 document", schema: z.record(z.string(), z.unknown()) },
    },
    handler: (_input, _req, res) => {
      res.status(200).json(document);
    },
  });
  const document = buildOpenApiDocument([...routes, self], info);
  return [self];
}
