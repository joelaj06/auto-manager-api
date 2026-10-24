/**
 * What staff may not do in a tenant through support access (docs/27 §3.8), whatever the mode:
 * sign in or out as the user, change passwords or devices, pay, download or export.
 */
const NEVER = [/^\/api\/v1\/auth\//, /^\/api\/v1\/me\/(password|push-devices)/];
const NO_WRITES = [/^\/api\/v1\/billing(\/|$)/];
const DOWNLOAD = /(\/export|\/download|\/pdf|\.pdf|\.csv)(\/|$)/;

export type SupportVerdict = "allowed" | "read_only" | "blocked";

export function supportVerdict(
  method: string,
  path: string,
  mode: "read" | "write",
): SupportVerdict {
  const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (NEVER.some((re) => re.test(path)) || DOWNLOAD.test(path)) return "blocked";
  if (!safe && NO_WRITES.some((re) => re.test(path))) return "blocked";
  if (!safe && mode === "read") return "read_only";
  return "allowed";
}

/** Identity and bank numbers and secrets stay masked in support mode. */
const SENSITIVE =
  /^(ghanaCardNumber|idNumber|nationalId|passportNumber|accountNumber|bankAccount|momoNumber|momoPhone|licenceNumber|tin|secret|token|apiKey|password\w*|sealedAuthorization)$/i;

export function maskSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>))
    out[key] = SENSITIVE.test(key) && typeof v === "string" ? mask(v) : maskSensitive(v);
  return out;
}

const mask = (v: string) => (v.length <= 4 ? "••••" : `••••${v.slice(-4)}`);
