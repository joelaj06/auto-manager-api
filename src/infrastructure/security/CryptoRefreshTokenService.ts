import { createHash, randomBytes } from "node:crypto";
import type {
  GeneratedRefreshToken,
  IRefreshTokenService,
} from "../../application/ports/IRefreshTokenService.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 32 random bytes in base64url. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * `<sessionId>.<256-bit secret>`. The session id lets the server find the session without an
 * index on the hash; the stored SHA-256 covers the whole token, so the secret cannot be moved
 * to another session.
 */
export class CryptoRefreshTokenService implements IRefreshTokenService {
  generate(sessionId: string): GeneratedRefreshToken {
    const token = `${sessionId}.${randomBytes(32).toString("base64url")}`;
    return { token, hash: sha256(token) };
  }

  parse(token: string): Readonly<{ sessionId: string; hash: string }> | null {
    const separator = token.indexOf(".");
    if (separator === -1) return null;
    const sessionId = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    if (!UUID.test(sessionId) || !SECRET.test(secret)) return null;
    return { sessionId, hash: sha256(token) };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
