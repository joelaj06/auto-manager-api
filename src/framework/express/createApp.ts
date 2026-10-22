import express, { type Express } from "express";
import helmet from "helmet";
import type { RawBodyRequest } from "../../adapters/middleware/rawBody.js";
import type { AccessGuard } from "../../adapters/middleware/AccessGuard.js";
import { corsPolicy } from "../../adapters/middleware/cors.js";
import { errorHandler, notFoundHandler } from "../../adapters/middleware/errorHandler.js";
import { rateLimiter } from "../../adapters/middleware/rateLimiter.js";
import { requestContext } from "../../adapters/middleware/requestContext.js";
import { requestLogger } from "../../adapters/middleware/requestLogger.js";
import type { ApiRoute } from "../../adapters/routes/ApiRoute.js";
import { buildRouter } from "../../adapters/routes/buildRouter.js";
import type { ILogger } from "../../application/ports/ILogger.js";
import type { IRequestContext } from "../../application/ports/IRequestContext.js";
import type { HttpConfig } from "../../infrastructure/config/config.js";

export type AppDependencies = Readonly<{
  http: HttpConfig;
  logger: ILogger;
  requestContext: IRequestContext;
  routes: readonly ApiRoute[];
  /** Required as soon as any route is not public. */
  accessGuard?: AccessGuard;
}>;

/**
 * The HTTP pipeline, in order:
 * request id/context → request log → security headers → CORS → JSON body (size-limited)
 * → rate limit (/api only; health probes are exempt) → routes (access check, tenant context,
 * validation, handler) → 404 → error envelope.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.http.trustProxyHops);

  app.use(requestContext(deps.requestContext));
  app.use(requestLogger(deps.logger));
  app.use(helmet());
  app.use(corsPolicy(deps.http.corsAllowedOrigins));
  app.use(
    express.json({
      limit: `${deps.http.bodyLimitKb}kb`,
      // Webhook signatures are computed over the exact bytes received.
      verify: (req, _res, buf) => {
        if (req.url?.startsWith("/api/v1/webhooks/")) (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );
  app.use("/api", rateLimiter(deps.http.rateLimit));
  // Credential endpoints: a much tighter budget per client (brute force, credential stuffing).
  const credentialLimiter = rateLimiter({ windowMs: 15 * 60_000, max: deps.http.authRateLimitMax });
  app.use("/api/platform/v1/auth", credentialLimiter);
  app.use("/api/v1/auth", (req, res, next) => {
    if (req.method === "POST") credentialLimiter(req, res, next);
    else next();
  });
  // Signup writes (apply, verify, resend, reply) share the tight budget; status reads do not.
  app.use("/api/v1/applications", (req, res, next) => {
    if (req.method === "POST") credentialLimiter(req, res, next);
    else next();
  });

  app.use(buildRouter(deps.routes, deps.accessGuard));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
