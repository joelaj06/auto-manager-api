import express, { type Express } from "express";
import helmet from "helmet";
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
}>;

/**
 * The HTTP pipeline, in order:
 * request id/context → request log → security headers → CORS → JSON body (size-limited)
 * → rate limit (/api only; health probes are exempt) → routes (validated) → 404 → error envelope.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.http.trustProxyHops);

  app.use(requestContext(deps.requestContext));
  app.use(requestLogger(deps.logger));
  app.use(helmet());
  app.use(corsPolicy(deps.http.corsAllowedOrigins));
  app.use(express.json({ limit: `${deps.http.bodyLimitKb}kb` }));
  app.use("/api", rateLimiter(deps.http.rateLimit));

  app.use(buildRouter(deps.routes));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
