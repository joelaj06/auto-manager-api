import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A new private-link token and the hash that is stored. */
export function newAccessToken(): Readonly<{ token: string; hash: string }> {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashAccessToken(token) };
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function accessTokenMatches(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashAccessToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/** Applicant status page; the token is in the fragment so it never reaches server logs. */
export function applicationUrl(webAppUrl: string, applicationId: string, token: string): string {
  return `${webAppUrl.replace(/\/$/, "")}/signup/application/${applicationId}#token=${token}`;
}
