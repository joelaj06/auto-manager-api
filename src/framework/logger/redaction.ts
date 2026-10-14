/**
 * Turns arbitrary log context into JSON-safe values and removes secrets.
 *
 * - Keys that look sensitive (password, token, secret, otp, authorization, cookie, api key, …)
 *   are replaced by "[REDACTED]" at any depth.
 * - Credentials inside URLs (postgres://user:pass@host) are masked in every string.
 * - Errors become { name, message, code, stack, cause }; circular references and very deep
 *   objects are cut off instead of crashing the logger.
 */
const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|secret|token|otp|pin$|authorization|cookie|api[-_]?key|private[-_]?key|credential|signature/i;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@/\s]+@/gi;
const MAX_DEPTH = 8;
const MAX_STRING = 8_192;

export const REDACTED = "[REDACTED]";

function sanitizeString(value: string): string {
  const masked = value.replace(URL_CREDENTIALS, `$1:${REDACTED}@`);
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…[truncated]` : masked;
}

export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return sanitizeString(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
      return value.toString();
    case "function":
      return `[Function ${value.name || "anonymous"}]`;
    default:
      break;
  }

  const object = value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (seen.has(object)) return "[Circular]";
  seen.add(object);

  if (object instanceof Date) return Number.isNaN(object.getTime()) ? null : object.toISOString();
  if (Buffer.isBuffer(object)) return `[Buffer ${object.length} bytes]`;
  if (object instanceof Error) return sanitizeError(object, depth, seen);
  if (Array.isArray(object)) return object.map((item) => sanitize(item, depth + 1, seen));

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(entry, depth + 1, seen);
  }
  return result;
}

function sanitizeError(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: error.name,
    message: sanitizeString(error.message),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") result.code = code;
  if (error.stack !== undefined) result.stack = sanitizeString(error.stack);
  if (error.cause !== undefined) result.cause = sanitize(error.cause, depth + 1, seen);
  return result;
}
