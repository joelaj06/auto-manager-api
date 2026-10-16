import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { RateLimitedError } from "./httpErrors.js";

export type RateLimitOptions = Readonly<{ windowMs: number; max: number }>;

/**
 * Per-client-IP request limit with standard RateLimit headers. Uses the in-memory store, which
 * is correct for a single instance; a shared (Redis) store is needed before running several
 * API replicas. Credential endpoints get a second, tighter limiter (see createApp).
 */
export function rateLimiter(options: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new RateLimitedError()),
  });
}
