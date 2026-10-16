import { z } from "zod";
import type { ApiRoute } from "../routes/ApiRoute.js";
import type { RouteAccess } from "../routes/RouteAccess.js";
import { errorEnvelopeSchema } from "./responseEnvelope.js";

export type OpenApiInfo = Readonly<{ title: string; version: string; description?: string }>;

type JsonSchema = Record<string, unknown> & {
  properties?: Record<string, unknown>;
  required?: string[];
};

const toSchema = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

/** "/api/v1/vehicles/:id" → "/api/v1/vehicles/{id}" */
const openApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const operationId = (route: ApiRoute) =>
  `${route.method}${route.path
    .split(/[/:-]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("")}`;

function parameters(schema: z.ZodObject | undefined, location: "path" | "query") {
  if (schema === undefined) return [];
  const json = toSchema(schema);
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: property,
  }));
}

const jsonContent = (schema: z.ZodType) => ({ "application/json": { schema: toSchema(schema) } });

/** X-Tenant header, bearer requirement and required permission, from the route's access. */
function accessDocumentation(access: RouteAccess) {
  if (access.kind === "public") return { parameters: [], operation: {} };
  const tenantHeader = {
    name: "X-Tenant",
    in: "header",
    required: access.kind === "tenant",
    description:
      access.kind === "tenant"
        ? "Business account (tenant slug)"
        : "Business account (tenant slug); when sent it must match the access token",
    schema: { type: "string" },
  };
  if (access.kind === "tenant") return { parameters: [tenantHeader], operation: {} };
  if (access.kind === "platform") {
    return {
      parameters: [],
      operation: {
        security: [{ [BEARER_SCHEME]: [] }],
        "x-audience": "platform",
        ...(access.permission === null ? {} : { "x-permission": access.permission }),
      },
    };
  }
  return {
    parameters: [tenantHeader],
    operation: {
      security: [{ [BEARER_SCHEME]: [] }],
      ...(access.permission === null ? {} : { "x-permission": access.permission }),
    },
  };
}

const BEARER_SCHEME = "bearerAuth";

/**
 * OpenAPI 3.1 document generated from the route declarations, so it cannot drift from the
 * actual validation. Every operation also documents the shared error envelope.
 */
export function buildOpenApiDocument(routes: readonly ApiRoute[], info: OpenApiInfo) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const responses: Record<string, unknown> = {};
    for (const [status, response] of Object.entries(route.responses)) {
      responses[status] = {
        description: response.description,
        ...(response.schema === undefined ? {} : { content: jsonContent(response.schema) }),
      };
    }
    responses.default = { description: "Error", content: jsonContent(errorEnvelopeSchema) };

    const body = route.request?.body;
    const documentedAccess = accessDocumentation(route.access);
    const path = (paths[openApiPath(route.path)] ??= {});
    path[route.method] = {
      operationId: operationId(route),
      summary: route.summary,
      tags: route.tags,
      parameters: [
        ...parameters(route.request?.params, "path"),
        ...parameters(route.request?.query, "query"),
        ...documentedAccess.parameters,
      ],
      ...documentedAccess.operation,
      ...(body === undefined
        ? {}
        : { requestBody: { required: true, content: jsonContent(body) } }),
      responses,
    };
  }

  return {
    openapi: "3.1.0",
    info,
    paths,
    components: {
      securitySchemes: { [BEARER_SCHEME]: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    },
  };
}
