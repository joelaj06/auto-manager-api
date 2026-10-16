import { hkdfSync } from "node:crypto";
import { decodeJwt, errors as joseErrors, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { InvalidAccessTokenError } from "../../application/errors/AuthErrors.js";
import type {
  AccessTokenSubject,
  IAccessTokenService,
  IssuedAccessToken,
} from "../../application/ports/IAccessTokenService.js";
import type { IClock } from "../../application/ports/IClock.js";

export type JwtSettings = Readonly<{
  tenantSecret: string;
  platformSecret: string;
  issuer: string;
  ttlSeconds: number;
}>;

const ALGORITHM = "HS256";
const TOKEN_TYPE = "at+jwt";
const AUDIENCE = Object.freeze({ tenant: "autoforce:tenant", platform: "autoforce:platform" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_CACHE_LIMIT = 10_000;

type Audience = AccessTokenSubject["audience"];

/**
 * Short-lived HS256 access tokens (RFC 9068 style, `typ: at+jwt`).
 *
 * Tenant tokens are signed with a key derived per tenant (HKDF-SHA256 over TENANT_JWT_SECRET
 * with the tenant id as context), so a token can only ever verify for the tenant in its `tid`
 * claim. Platform-console tokens use a different secret and audience and are never accepted on
 * tenant routes (docs/16, docs/27).
 *
 * Claims: sub (user), tid (tenant), sid (session), ver (permission version), iss, aud, iat, exp.
 */
export class JwtAccessTokenService implements IAccessTokenService {
  private readonly tenantKeys = new Map<string, Uint8Array>();
  private readonly platformKey: Uint8Array;

  constructor(
    private readonly settings: JwtSettings,
    private readonly clock: IClock,
  ) {
    this.platformKey = derive(settings.platformSecret, "platform");
  }

  async issue(subject: AccessTokenSubject): Promise<IssuedAccessToken> {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const expSeconds = nowSeconds + this.settings.ttlSeconds;
    const claims: JWTPayload = { sid: subject.sessionId, ver: subject.permissionVersion };
    if (subject.audience === "tenant") claims.tid = subject.tenantId;

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITHM, typ: TOKEN_TYPE })
      .setSubject(subject.userId)
      .setIssuer(this.settings.issuer)
      .setAudience(AUDIENCE[subject.audience])
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expSeconds)
      .sign(this.keyFor(subject));
    return { token, expiresAt: new Date(expSeconds * 1000) };
  }

  async verify<A extends Audience>(
    token: string,
    audience: A,
  ): Promise<Extract<AccessTokenSubject, { audience: A }>> {
    let key: Uint8Array;
    if (audience === "tenant") {
      // The key depends on the tenant, so read `tid` before verifying; it is checked again below.
      const tid = unverifiedTenantId(token);
      if (tid === null) throw new InvalidAccessTokenError("missing_tenant");
      key = this.tenantKey(tid);
    } else {
      key = this.platformKey;
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        algorithms: [ALGORITHM],
        typ: TOKEN_TYPE,
        issuer: this.settings.issuer,
        audience: AUDIENCE[audience],
        currentDate: this.clock.now(),
        requiredClaims: ["sub", "sid", "ver", "iat", "exp"],
      }));
    } catch (error) {
      throw new InvalidAccessTokenError(reasonOf(error));
    }

    const { sub, sid, ver, tid } = payload;
    if (typeof sub !== "string" || typeof sid !== "string" || !Number.isSafeInteger(ver)) {
      throw new InvalidAccessTokenError("malformed_claims");
    }
    const common = { userId: sub, sessionId: sid, permissionVersion: ver as number };
    if (audience === "platform") {
      return { audience: "platform", ...common } as Extract<AccessTokenSubject, { audience: A }>;
    }
    if (typeof tid !== "string") throw new InvalidAccessTokenError("malformed_claims");
    return { audience: "tenant", tenantId: tid, ...common } as Extract<
      AccessTokenSubject,
      { audience: A }
    >;
  }

  private keyFor(subject: AccessTokenSubject): Uint8Array {
    return subject.audience === "tenant" ? this.tenantKey(subject.tenantId) : this.platformKey;
  }

  private tenantKey(tenantId: string): Uint8Array {
    let key = this.tenantKeys.get(tenantId);
    if (key === undefined) {
      if (this.tenantKeys.size >= KEY_CACHE_LIMIT) this.tenantKeys.clear();
      key = derive(this.settings.tenantSecret, `tenant:${tenantId}`);
      this.tenantKeys.set(tenantId, key);
    }
    return key;
  }
}

function derive(secret: string, context: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, "autoforce-access-token-v1", context, 32));
}

function unverifiedTenantId(token: string): string | null {
  try {
    const { tid } = decodeJwt(token);
    return typeof tid === "string" && UUID.test(tid) ? tid : null;
  } catch {
    return null;
  }
}

/** A short, log-friendly reason. Never sent to the client. */
function reasonOf(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return "expired";
  if (error instanceof joseErrors.JWTClaimValidationFailed) return `claim_${error.claim}`;
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return "bad_signature";
  if (error instanceof joseErrors.JOSEAlgNotAllowed) return "algorithm_not_allowed";
  if (error instanceof joseErrors.JOSEError) return error.code;
  return "malformed";
}
