import { describe, expect, it } from "vitest";
import { SessionNotActiveError } from "../errors/AuthErrors.js";
import { AuthSession } from "./AuthSession.js";

const now = new Date("2026-10-14T10:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const day = 86_400_000;

const start = () =>
  AuthSession.start({ id: "s1", userId: "u1", refreshTokenHash: "h1", now, ttlMs: 30 * day });

describe("AuthSession", () => {
  it("starts active and expires after its lifetime", () => {
    const session = start();
    expect(session.isActive(now)).toBe(true);
    expect(session.expiresAt).toEqual(later(30 * day));
    expect(session.isActive(later(30 * day))).toBe(false);
  });

  it("rotates the refresh token and remembers the previous one", () => {
    const session = start();
    session.rotate("h2", later(1_000));

    expect(session.matchRefreshToken("h2")).toBe("current");
    expect(session.matchRefreshToken("h1")).toBe("reused");
    expect(session.matchRefreshToken("other")).toBe("unknown");
  });

  it("does not extend the absolute expiry on rotation", () => {
    const session = start();
    session.rotate("h2", later(29 * day));
    expect(session.expiresAt).toEqual(later(30 * day));
  });

  it("cannot rotate once revoked or expired", () => {
    const revoked = start();
    revoked.revoke("logout", later(1));
    expect(() => revoked.rotate("h2", later(2))).toThrow(SessionNotActiveError);

    expect(() => start().rotate("h2", later(31 * day))).toThrow(SessionNotActiveError);
  });

  it("keeps the first revocation reason", () => {
    const session = start();
    session.revoke("refresh_token_reuse", later(1));
    session.revoke("logout", later(2));
    expect(session.revocationReason).toBe("refresh_token_reuse");
    expect(session.isActive(later(3))).toBe(false);
  });

  it("round-trips through a snapshot", () => {
    const session = start();
    session.rotate("h2", later(5));
    expect(AuthSession.restore(session.snapshot()).snapshot()).toEqual(session.snapshot());
  });
});
