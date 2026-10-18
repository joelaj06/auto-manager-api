import { DomainError } from "../errors/DomainError.js";

/**
 * Mobile connect links (docs/23 §4): a QR code or link that tells the app which backend and
 * business to connect to. Signed with the platform's Ed25519 key, which the app embeds; the
 * link is not a credential (everyone still signs in).
 *
 *   https://<link-domain>/connect?v=1&api=<url>&t=<slug>[&inv=<token>&exp=<unix>]&k=<keyId>&sig=<sig>
 *   autoforce://connect?…same parameters…   (in-app scanner, environments without app links)
 */

export const CONNECT_LINK_VERSION = 1;
export const CONNECT_PATH = "/connect";

export type ConnectPayload = Readonly<{
  version: number;
  /** Backend base URL, e.g. https://api.autoforce.example. */
  apiBaseUrl: string;
  tenantSlug: string;
  /** One-time invitation token: opens "set your password" directly. */
  invitationToken?: string;
  /** Unix seconds; invitation links expire with the invitation. */
  expiresAt?: number;
  /** Which signing key: lets the app trust several keys during a rotation. */
  keyId: string;
}>;

export type ConnectLinkFailure =
  | "malformed"
  | "unsupported_version"
  | "unknown_key"
  | "bad_signature"
  | "host_not_allowed"
  | "expired";

export class ConnectLinkError extends DomainError {
  readonly code = "INVALID_CONNECT_LINK";
  constructor(
    readonly reason: ConnectLinkFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The exact bytes that are signed: fixed order, one field per line, empty when absent. The app
 * must build the same string to verify.
 */
export function connectSigningMessage(payload: ConnectPayload): string {
  return [
    "autoforce-connect",
    `v=${payload.version}`,
    `api=${payload.apiBaseUrl}`,
    `t=${payload.tenantSlug}`,
    `inv=${payload.invitationToken ?? ""}`,
    `exp=${payload.expiresAt ?? ""}`,
    `k=${payload.keyId}`,
  ].join("\n");
}

/** The query string of a connect link (parameters in a fixed order). */
export function connectQuery(payload: ConnectPayload, signature: string): string {
  const params = new URLSearchParams();
  params.set("v", String(payload.version));
  params.set("api", payload.apiBaseUrl);
  params.set("t", payload.tenantSlug);
  if (payload.invitationToken !== undefined) params.set("inv", payload.invitationToken);
  if (payload.expiresAt !== undefined) params.set("exp", String(payload.expiresAt));
  params.set("k", payload.keyId);
  params.set("sig", signature);
  return params.toString();
}

const SLUG = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const KEY_ID = /^[a-z0-9-]{4,40}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{40,200}$/;

/** Reads a scanned or opened link (https or custom scheme); checks its shape, not its signature. */
export function parseConnectLink(
  link: string,
  scheme: string,
): Readonly<{ payload: ConnectPayload; signature: string }> {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new ConnectLinkError("malformed", "This is not a connect link");
  }
  const isScheme = url.protocol === `${scheme}:`;
  const path = isScheme ? `/${url.host}${url.pathname}`.replace(/\/$/, "") : url.pathname;
  if ((!isScheme && url.protocol !== "https:" && url.protocol !== "http:") || path !== CONNECT_PATH)
    throw new ConnectLinkError("malformed", "This is not a connect link");

  const p = url.searchParams;
  const version = Number(p.get("v"));
  if (version !== CONNECT_LINK_VERSION)
    throw new ConnectLinkError("unsupported_version", "This link needs a newer app version");
  const apiBaseUrl = p.get("api") ?? "";
  const tenantSlug = p.get("t") ?? "";
  const keyId = p.get("k") ?? "";
  const signature = p.get("sig") ?? "";
  const inv = p.get("inv");
  const exp = p.get("exp");
  if (
    !isHttpUrl(apiBaseUrl) ||
    !SLUG.test(tenantSlug) ||
    !KEY_ID.test(keyId) ||
    !SIGNATURE.test(signature) ||
    (inv !== null && !TOKEN.test(inv)) ||
    (exp !== null && !/^\d{1,12}$/.test(exp))
  )
    throw new ConnectLinkError("malformed", "This connect link is damaged");
  return {
    payload: {
      version,
      apiBaseUrl,
      tenantSlug,
      ...(inv === null ? {} : { invitationToken: inv }),
      ...(exp === null ? {} : { expiresAt: Number(exp) }),
      keyId,
    },
    signature,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/";
  } catch {
    return false;
  }
}

/**
 * Backend hosts the app may connect to (docs/23 §5): exact hosts (`api.example.com`,
 * `localhost:3000`) or one-level wildcards (`*.example.com`). Anything else is refused.
 */
export class HostAllowList {
  private readonly patterns: readonly string[];

  constructor(patterns: readonly string[]) {
    this.patterns = patterns.map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0);
  }

  get entries(): readonly string[] {
    return this.patterns;
  }

  /** `host` as in URL.host (may include a port). */
  allows(host: string): boolean {
    const candidate = host.toLowerCase();
    return this.patterns.some((pattern) => {
      if (!pattern.startsWith("*.")) return candidate === pattern;
      const suffix = pattern.slice(1); // ".example.com"
      const label = candidate.slice(0, -suffix.length);
      return candidate.endsWith(suffix) && label.length > 0 && !label.includes(".");
    });
  }

  allowsUrl(url: string): boolean {
    try {
      return this.allows(new URL(url).host);
    } catch {
      return false;
    }
  }
}
