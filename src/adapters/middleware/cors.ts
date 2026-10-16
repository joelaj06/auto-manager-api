import cors from "cors";
import type { RequestHandler } from "express";

/**
 * True when `origin` is allowed. Entries are exact origins ("https://admin.example.com") or
 * wildcard subdomains ("https://*.example.com" matches https://acme.example.com, not the apex).
 * Scheme and port must match.
 */
export function isOriginAllowed(origin: string, allowList: readonly string[]): boolean {
  const candidate = origin.toLowerCase();
  return allowList.some((entry) => {
    const wildcard = /^(https?:\/\/)\*\.(.+)$/.exec(entry);
    if (wildcard === null) return entry === candidate;
    const [, scheme, suffix] = wildcard as unknown as [string, string, string];
    if (!candidate.startsWith(scheme)) return false;
    const host = candidate.slice(scheme.length);
    return (
      host.endsWith(`.${suffix}`) &&
      /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host.slice(0, -suffix.length - 1))
    );
  });
}

/**
 * CORS for browser clients (web portal, admin console). Requests without an Origin header
 * (mobile apps, servers) are unaffected. Disallowed origins simply get no CORS headers.
 */
export function corsPolicy(allowList: readonly string[]): RequestHandler {
  return cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && isOriginAllowed(origin, allowList));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id", "X-Tenant"],
    exposedHeaders: [
      "X-Request-Id",
      "RateLimit",
      "RateLimit-Policy",
      "Retry-After",
      "WWW-Authenticate",
    ],
    maxAge: 600,
  });
}
