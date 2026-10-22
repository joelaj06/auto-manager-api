import { ApplicationError } from "../../application/errors/ApplicationError.js";
import { OtpVerificationFailedError } from "../../application/errors/AuthErrors.js";
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
    /** Wrong one-time code: guesses left before the code locks. */
    remainingAttempts?: number;
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
  /** Extra response headers (e.g. WWW-Authenticate on 401). */
  headers: Readonly<Record<string, string>>;
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

  // Tenant resolution
  TENANT_REQUIRED: { status: 400 },
  TENANT_NOT_FOUND: { status: 404 },
  TENANT_DEACTIVATED: { status: 403 },
  TENANT_MISMATCH: { status: 401, securityAlert: true },

  // Authentication and authorization
  UNAUTHENTICATED: { status: 401 },
  INVALID_TOKEN: { status: 401 },
  INVALID_REFRESH_TOKEN: { status: 401 },
  REFRESH_TOKEN_REUSED: {
    status: 401,
    // Same answer as any expired session: the caller must not learn that theft was detected.
    publicMessage: "The session has expired. Please sign in again.",
    securityAlert: true,
  },
  FORBIDDEN: { status: 403 },
  OTP_INVALID: { status: 400 },
  OTP_EXPIRED: { status: 400 },
  OTP_LOCKED: { status: 400 },
  OTP_CHALLENGE_CLOSED: { status: 400, publicMessage: "The code has expired. Request a new code." },
  SESSION_NOT_ACTIVE: { status: 401 },

  // Platform staff (console)
  INVALID_CREDENTIALS: { status: 401 },
  INVALID_MFA_CODE: { status: 401 },
  INVALID_CHALLENGE: { status: 401 },
  TOO_MANY_ATTEMPTS: { status: 429 },
  INVITATION_INVALID: { status: 400 },
  WEAK_PASSWORD: { status: 400 },
  STEP_UP_REQUIRED: { status: 403 },
  STAFF_NOT_FOUND: { status: 404 },
  STAFF_EXISTS: { status: 409 },
  ROLE_NOT_FOUND: { status: 404 },
  APPROVAL_NOT_FOUND: { status: 404 },
  APPROVAL_NOT_PENDING: { status: 409 },
  APPROVAL_SELF: { status: 403 },
  APPROVER_ROLE_REQUIRED: { status: 403 },
  REASON_REQUIRED: { status: 400 },
  UNKNOWN_PERMISSION: { status: 400 },
  CANNOT_CHANGE_OWN_ACCOUNT: { status: 422 },
  LAST_SUPER_ADMIN: { status: 422 },
  SYSTEM_ROLE_LOCKED: { status: 422 },
  ROLE_EXCEEDS_OWN_PERMISSIONS: { status: 403 },
  SUPER_ADMIN_NEEDS_APPROVAL: { status: 422 },

  // Tenant applications (signup and review)
  APPLICATION_NOT_FOUND: { status: 404 },
  APPLICATION_EXISTS: { status: 409 },
  APPLICATION_STATE: { status: 409 },
  REAPPLY_LATER: { status: 409 },
  SLUG_TAKEN: { status: 409 },
  ALREADY_VERIFIED: { status: 409 },
  MESSAGE_REQUIRED: { status: 400 },
  INVALID_PHONE: { status: 400 },
  INVALID_SLUG: { status: 400 },

  // Provisioning
  PROVISIONING_NOT_FOUND: { status: 404 },
  PROVISIONING_NOT_RETRYABLE: { status: 409 },

  // Tenant and branch lifecycle
  TENANT_READ_ONLY: { status: 403 },
  TENANT_STATE: { status: 409 },
  BRANCH_DEACTIVATED: { status: 403 },
  BRANCH_NOT_FOUND: { status: 404 },
  BRANCH_DEACTIVATION_BLOCKED: { status: 422 },

  // Tenant identity and organisation
  USER_NOT_FOUND: { status: 404 },
  USER_EXISTS: { status: 409 },
  OWNER_PROTECTED: { status: 422 },

  // Money, currencies, tax and reference data
  UNKNOWN_CURRENCY: { status: 400 },
  INVALID_AMOUNT: { status: 400 },
  CURRENCY_MISMATCH: { status: 422 },
  CURRENCY_BASE_LOCKED: { status: 409 },
  CURRENCY_NOT_ENABLED: { status: 422 },
  TAX_CODE_NOT_FOUND: { status: 404 },
  TAX_RATES_MISSING: { status: 409 },
  INVALID_TAX_CODE: { status: 422 },
  FX_RATE_EXISTS: { status: 409 },
  FX_RATE_NOT_FOUND: { status: 404 },
  FX_SAME_CURRENCY: { status: 400 },
  EXPENSE_CATEGORY_NOT_FOUND: { status: 404 },
  EXPENSE_CATEGORY_RULE: { status: 422 },
  VEHICLE_MAKE_NOT_FOUND: { status: 404 },
  VEHICLE_CATALOGUE_RULE: { status: 409 },

  // Billing
  SUBSCRIPTION_NOT_FOUND: { status: 404 },
  PLAN_NOT_FOUND: { status: 404 },
  INVOICE_NOT_FOUND: { status: 404 },
  PRICE_NOT_SET: { status: 409 },
  LINES_REQUIRED: { status: 400 },
  DUPLICATE_PAYMENT: { status: 409 },
  PERIOD_INVOICED: { status: 409 },
  LICENCE_TYPE_LOCKED: { status: 409 },
  ENTITLEMENT_BRANCH_LIMIT: { status: 409 },
  RECEIPT_NOT_FOUND: { status: 404 },
  PAYMENT_METHOD_NOT_FOUND: { status: 404 },
  PAYMENT_GATEWAY_ERROR: { status: 502 },
  INVOICE_NOT_PAYABLE: { status: 409 },
  BILLING_EMAIL_REQUIRED: { status: 409 },
  REFUND_NOT_POSSIBLE: { status: 409 },
  PAYMENT_ATTEMPT_NOT_FOUND: { status: 404 },
  WEBHOOK_NOT_FOUND: { status: 404 },

  // Vehicles
  VEHICLE_NOT_FOUND: { status: 404 },
  VEHICLE_EXISTS: { status: 409 },
  INVALID_VEHICLE: { status: 422 },
  VEHICLE_STATUS_TRANSITION: { status: 422 },
  ODOMETER_INVALID: { status: 422 },
  VEHICLE_DOCUMENT_NOT_FOUND: { status: 404 },
  VEHICLE_GROUP_NOT_FOUND: { status: 404 },
  VEHICLE_GROUP_NAME_TAKEN: { status: 409 },

  // Parties
  DRIVER_NOT_FOUND: { status: 404 },
  CUSTOMER_NOT_FOUND: { status: 404 },
  SUPPLIER_NOT_FOUND: { status: 404 },
  GUARANTOR_NOT_FOUND: { status: 404 },
  PARTY_DOCUMENT_NOT_FOUND: { status: 404 },
  PARTY_EXISTS: { status: 409 },
  INVALID_PARTY: { status: 422 },
  DRIVER_STATUS_TRANSITION: { status: 422 },
  CUSTOMER_RISK: { status: 422 },

  // Assignments
  ASSIGNMENT_NOT_FOUND: { status: 404 },
  ASSIGNMENT_CONFLICT: { status: 409 },
  ASSIGNMENT_RULE: { status: 422 },
  VEHICLE_NOT_COMPLIANT: { status: 422 },

  // Finance (INVOICE_NOT_FOUND is shared with billing)
  PAYMENT_NOT_FOUND: { status: 404 },
  CASH_SESSION_NOT_FOUND: { status: 404 },
  PERIOD_LOCKED: { status: 409 },
  FX_RATE_REQUIRED: { status: 422 },
  CASH_SESSION_REQUIRED: { status: 409 },
  FINANCE_RULE: { status: 422 },

  // Expenses
  EXPENSE_NOT_FOUND: { status: 404 },
  EXPENSE_RULE: { status: 422 },
  APPROVAL_LIMIT_EXCEEDED: { status: 403 },
  EXPENSE_SETUP_NOT_FOUND: { status: 404 },

  // Remittances
  REMITTANCE_NOT_FOUND: { status: 404 },
  REMITTANCE_RULE: { status: 422 },

  // Dashboards
  REPORT_RANGE: { status: 422 },

  // Driver app and vehicle issues
  DRIVER_PROFILE_NOT_FOUND: { status: 404 },
  DRIVER_APP_ACCESS: { status: 409 },
  VEHICLE_ISSUE_NOT_FOUND: { status: 404 },
  VEHICLE_ISSUE_RULE: { status: 422 },

  // Work & Pay
  WORKPAY_AGREEMENT_NOT_FOUND: { status: 404 },
  WORKPAY_INSTALMENT_NOT_FOUND: { status: 404 },
  WORKPAY_PENALTY_NOT_FOUND: { status: 404 },
  WORKPAY_RULE: { status: 422 },

  // Documents
  DOCUMENT_NOT_FOUND: { status: 404 },
  DOCUMENT_TEMPLATE_NOT_FOUND: { status: 404 },
  DOCUMENT_TEMPLATE: { status: 422 },
  DOCUMENT_RULE: { status: 422 },

  // Notifications
  NOTIFICATION_RULE: { status: 422 },
  SMS_NOT_CONFIGURED: { status: 409 },
  SMS_PROVIDER_FAILED: { status: 502 },

  // Files
  FILE_NOT_FOUND: { status: 404 },
  FILE_REJECTED: { status: 400 },
  FILE_STATE: { status: 409 },

  // Reseller programme
  PARTNER_NOT_FOUND: { status: 404 },
  PARTNER_EMAIL_TAKEN: { status: 409 },
  REFERRAL_CODE_TAKEN: { status: 409 },
  UNKNOWN_CAPABILITY: { status: 400 },
  INVALID_REFERRAL_CODE: { status: 400 },
  PARTNER_INACTIVE: { status: 409 },
  PARTNER_STATE: { status: 409 },
  PARTNER_RATE_LIMITED: { status: 429 },
  PARTNER_USER_NO_ROLES: { status: 422 },

  // Console notes and tags
  NOTE_NOT_FOUND: { status: 404 },
  NOTE_NOT_YOURS: { status: 403 },
  INVALID_NOTE: { status: 400 },
  INVALID_TAG: { status: 400 },

  OWNER_ROLE_PROTECTED: { status: 422 },
  USER_DISABLED: { status: 422 },
  ROLE_IN_USE: { status: 409 },
  ROLE_NAME_TAKEN: { status: 409 },
  BRANCH_OUT_OF_SCOPE: { status: 403 },
  INVALID_SCOPE: { status: 400 },
  UNKNOWN_BRANCH: { status: 400 },
  BRANCH_CODE_TAKEN: { status: 409 },
  INVALID_TIMEZONE: { status: 400 },
  CONTACT_REQUIRED: { status: 422 },
};

/** RFC 6750 challenge for bearer-token failures. */
function authenticateHeader(code: string): Readonly<Record<string, string>> {
  if (code === "INVALID_TOKEN") return { "WWW-Authenticate": 'Bearer error="invalid_token"' };
  return { "WWW-Authenticate": "Bearer" };
}

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
  const remainingAttempts =
    error instanceof OtpVerificationFailedError ? error.remainingAttempts : undefined;
  return {
    status,
    body: {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        ...(remainingAttempts === undefined ? {} : { remainingAttempts }),
        ...(requestId === undefined ? {} : { requestId }),
      },
    },
    logLevel: status >= 500 ? "error" : status === 429 || status === 404 ? "info" : "warn",
    securityAlert: rule?.securityAlert === true,
    headers: status === 401 ? authenticateHeader(code) : {},
  };
}
