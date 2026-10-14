/** No route matches the method and path (404). */
export class RouteNotFoundError extends Error {
  readonly code = "ROUTE_NOT_FOUND";

  constructor(
    readonly method: string,
    readonly path: string,
  ) {
    super(`No route for ${method} ${path}`);
    this.name = "RouteNotFoundError";
  }
}

/** The client exceeded the request rate limit (429). */
export class RateLimitedError extends Error {
  readonly code = "RATE_LIMITED";

  constructor() {
    super("Too many requests, please slow down");
    this.name = "RateLimitedError";
  }
}
