import { Router, type Request } from "express";
import type { z } from "zod";
import type { AccessGuard } from "../middleware/AccessGuard.js";
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

/**
 * Mounts every route: access check first (so anonymous callers learn nothing from validation
 * messages), then input validation, then the handler. Express 5 forwards rejected promises to
 * the error handler.
 *
 * Without a guard only public routes can be mounted — a misconfiguration fails at startup, not
 * by serving a protected route unprotected.
 */
export function buildRouter(routes: readonly ApiRoute[], guard?: AccessGuard): Router {
  const router = Router();
  for (const route of routes) {
    if (route.access.kind !== "public" && guard === undefined) {
      throw new Error(`Route ${route.method.toUpperCase()} ${route.path} needs an access guard`);
    }
    router[route.method](route.path, async (req, res) => {
      const handle = async () => {
        const input = validateInput(route, req);
        await route.handler(input, req, res);
      };
      if (guard === undefined) await handle();
      else await guard.run(route.access, req, res, handle);
    });
  }
  return router;
}
