import { ApplicationError } from "../../application/errors/ApplicationError.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import { RateLimitedError, RouteNotFoundError } from "../middleware/httpErrors.js";
import {
  RequestValidationError,
  type ValidationIssue,
} from "../validators/RequestValidationError.js";

export type ErrorBody = Readonly<{
  error: Readonly<{
    code: string;
    message: string;
    details?: readonly ValidationIssue[];
    requestId?: string;
  }>;
}>;

export type PresentedError = Readonly<{
  status: number;
  body: ErrorBody;
  /** How loudly the error handler should log it. */
  logLevel: "error" | "warn" | "info";
  /** Potential tenant-isolation breach: alert, don't just log. */
  securityAlert: boolean;
}>;

type Rule = Readonly<{
  status: number;
  /** Replaces the error's own message when the internal message must not reach clients. */
  publicMessage?: string;
  securityAlert?: boolean;
}>;

/**
 * Status and public message per error code. Codes not listed fall back to:
 * DomainError → 422 with its message; anything else → 500 with a generic message.
 */
const RULES: Readonly<Record<string, Rule>> = {
  VALIDATION_FAILED: { status: 400 },
  INVALID_JSON: { status: 400 },
  INVALID_CURSOR: { status: 400 },
  INVALID_TENANT_ID: { status: 400 },
  ROUTE_NOT_FOUND: { status: 404, publicMessage: "Not found" },
  PAYLOAD_TOO_LARGE: { status: 413 },
  RATE_LIMITED: { status: 429 },
  TENANT_SCHEMA_OUTDATED: {
    status: 503,
    publicMessage: "The service is being upgraded. Please try again shortly.",
  },
  TENANT_DATABASE_UNAVAILABLE: {
    status: 503,
    publicMessage: "The service is temporarily unavailable. Please try again shortly.",
  },
  TENANT_DATABASE_MISMATCH: { status: 500, securityAlert: true },
};

const GENERIC_MESSAGE = "Something went wrong. Please try again later.";

/** body-parser errors carry a `type`; translate the two clients can cause. */
function bodyParserCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("type" in error)) return undefined;
  if (error.type === "entity.parse.failed") return "INVALID_JSON";
  if (error.type === "entity.too.large") return "PAYLOAD_TOO_LARGE";
  return undefined;
}

const BODY_PARSER_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_JSON: "The request body is not valid JSON",
  PAYLOAD_TOO_LARGE: "The request body is too large",
};

/** Maps any thrown value to an HTTP status and the error envelope. Never exposes stack traces. */
export function presentError(error: unknown, requestId?: string): PresentedError {
  const parserCode = bodyParserCode(error);
  const known =
    error instanceof RequestValidationError ||
    error instanceof RouteNotFoundError ||
    error instanceof RateLimitedError ||
    error instanceof DomainError ||
    error instanceof ApplicationError;

  let code = "INTERNAL_ERROR";
  let message = GENERIC_MESSAGE;
  if (parserCode !== undefined) {
    code = parserCode;
    message = BODY_PARSER_MESSAGES[parserCode] ?? GENERIC_MESSAGE;
  } else if (known) {
    code = error.code;
    message = error.message;
  }

  const rule = RULES[code];
  const status = rule?.status ?? (error instanceof DomainError ? 422 : 500);
  if (rule === undefined && status === 500) {
    // Unmapped application/infrastructure failure: hide the internal message and code.
    code = "INTERNAL_ERROR";
    message = GENERIC_MESSAGE;
  } else if (rule?.publicMessage !== undefined) {
    message = rule.publicMessage;
  } else if (status >= 500) {
    message = GENERIC_MESSAGE;
  }

  const details = error instanceof RequestValidationError ? error.issues : undefined;
  return {
    status,
    body: {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        ...(requestId === undefined ? {} : { requestId }),
      },
    },
    logLevel: status >= 500 ? "error" : status === 429 || status === 404 ? "info" : "warn",
    securityAlert: rule?.securityAlert === true,
  };
}
