import type { Request, Response } from "express";
import type { z } from "zod";
import type { RouteAccess } from "./RouteAccess.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type RouteResponse = Readonly<{ description: string; schema?: z.ZodType }>;

export type RouteRequest = Readonly<{
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
}>;

/** Request parts after validation, available to the handler. */
export type ValidatedInput<R extends RouteRequest> = Readonly<{
  params: R["params"] extends z.ZodType ? z.output<R["params"]> : Record<string, never>;
  query: R["query"] extends z.ZodType ? z.output<R["query"]> : Record<string, never>;
  body: R["body"] extends z.ZodType ? z.output<R["body"]> : undefined;
}>;

/**
 * One endpoint, declared once: drives routing, access control, request validation and the
 * OpenAPI document. `path` is the full path in Express syntax (e.g. "/api/v1/vehicles/:id").
 */
export type ApiRoute<R extends RouteRequest = RouteRequest> = Readonly<{
  method: HttpMethod;
  path: string;
  summary: string;
  tags: readonly string[];
  access: RouteAccess;
  request?: R;
  responses: Readonly<Record<number, RouteResponse>>;
  handler: (input: ValidatedInput<R>, req: Request, res: Response) => Promise<void> | void;
}>;

/** Declares a route with input types inferred from its request schemas. */
export function defineRoute<R extends RouteRequest>(route: ApiRoute<R>): ApiRoute {
  return route as unknown as ApiRoute;
}
