import { Router, type Request } from "express";
import type { z } from "zod";
import {
  RequestValidationError,
  type ValidationIssue,
} from "../validators/RequestValidationError.js";
import type { ApiRoute, ValidatedInput } from "./ApiRoute.js";

function parsePart(
  schema: z.ZodType | undefined,
  value: unknown,
  part: "params" | "query" | "body",
  issues: ValidationIssue[],
): unknown {
  if (schema === undefined) return part === "body" ? undefined : {};
  const result = schema.safeParse(value ?? (part === "body" ? undefined : {}));
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    issues.push({ field: [part, ...issue.path.map(String)].join("."), message: issue.message });
  }
  return undefined;
}

/** Validates params, query and body against the route's schemas; collects every issue. */
export function validateInput(
  route: ApiRoute,
  req: Request,
): ValidatedInput<NonNullable<ApiRoute["request"]>> {
  const issues: ValidationIssue[] = [];
  const params = parsePart(route.request?.params, req.params, "params", issues);
  const query = parsePart(route.request?.query, req.query, "query", issues);
  const body = parsePart(route.request?.body, req.body, "body", issues);
  if (issues.length > 0) throw new RequestValidationError(issues);
  return { params, query, body } as ValidatedInput<NonNullable<ApiRoute["request"]>>;
}

/** Mounts every route. Express 5 forwards rejected handler promises to the error handler. */
export function buildRouter(routes: readonly ApiRoute[]): Router {
  const router = Router();
  for (const route of routes) {
    router[route.method](route.path, async (req, res) => {
      const input = validateInput(route, req);
      await route.handler(input, req, res);
    });
  }
  return router;
}
