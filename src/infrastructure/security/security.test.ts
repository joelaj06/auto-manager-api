import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { InvalidAccessTokenError } from "../../application/errors/AuthErrors.js";
import { UuidV7Generator } from "../ids/UuidV7Generator.js";
import { ARGON2_OPTIONS, Argon2PasswordHasher } from "./Argon2PasswordHasher.js";
import { CryptoRefreshTokenService } from "./CryptoRefreshTokenService.js";
import { HmacOtpService } from "./HmacOtpService.js";
import { JwtAccessTokenService } from "./JwtAccessTokenService.js";

const TENANT_A = "0198f0e0-0000-7000-8000-00000000000a";
const TENANT_B = "0198f0e0-0000-7000-8000-00000000000b";

class FakeClock {
  current = new Date("2026-10-14T10:00:00Z");
  now = () => this.current;
}

const settings = {
  tenantSecret: "tenant-secret-tenant-secret-tenant-secret",
  platformSecret: "platform-secret-platform-secret-platform",
  issuer: "autoforce-test",
  ttlSeconds: 900,
};

const tenantSubject = {
  audience: "tenant" as const,
  tenantId: TENANT_A,
  userId: "0198f0e0-0000-7000-8000-000000000001",
  sessionId: "0198f0e0-0000-7000-8000-000000000002",
  permissionVersion: 3,
};

async function rejection(promise: Promise<unknown>): Promise<InvalidAccessTokenError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InvalidAccessTokenError);
  return error as InvalidAccessTokenError;
}

describe("JwtAccessTokenService", () => {
  it("round-trips a tenant token", async () => {
    const clock = new FakeClock();
    const service = new JwtAccessTokenService(settings, clock);
    const { token, expiresAt } = await service.issue(tenantSubject);

    expect(expiresAt).toEqual(new Date("2026-10-14T10:15:00Z"));
    await expect(service.verify(token, "tenant")).resolves.toEqual(tenantSubject);
  });

  it("round-trips a platform token", async () => {
    const service = new JwtAccessTokenService(settings, new FakeClock());
    const subject = {
      audience: "platform" as const,
      userId: "u",
      sessionId: "s",
      permissionVersion: 1,
    };
    const { token } = await service.issue(subject);
    await expect(service.verify(token, "platform")).resolves.toEqual(subject);
  });

  it("never accepts a token for the other audience", async () => {
    const service = new JwtAccessTokenService(settings, new FakeClock());
    const tenantToken = (await service.issue(tenantSubject)).token;
    const platformToken = (
      await service.issue({
        audience: "platform",
        userId: "u",
        sessionId: "s",
        permissionVersion: 1,
      })
    ).token;

    await rejection(service.verify(tenantToken, "platform"));
    expect((await rejection(service.verify(platformToken, "tenant"))).reason).toBe(
      "missing_tenant",
    );
  });

  it("signs each tenant with its own key, so a forged tid fails", async () => {
    const service = new JwtAccessTokenService(settings, new FakeClock());
    const { token } = await service.issue(tenantSubject);
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...claims, tid: TENANT_B })).toString("base64url");

    const error = await rejection(service.verify(`${header}.${forged}.${signature}`, "tenant"));
    expect(error.reason).toBe("bad_signature");
  });

  it("rejects expired tokens, other issuers and other secrets", async () => {
    const clock = new FakeClock();
    const service = new JwtAccessTokenService(settings, clock);
    const { token } = await service.issue(tenantSubject);

    clock.current = new Date("2026-10-14T10:15:01Z");
    expect((await rejection(service.verify(token, "tenant"))).reason).toBe("expired");

    clock.current = new Date("2026-10-14T10:00:00Z");
    const otherIssuer = new JwtAccessTokenService({ ...settings, issuer: "someone" }, clock);
    expect((await rejection(otherIssuer.verify(token, "tenant"))).reason).toBe("claim_iss");

    const otherSecret = new JwtAccessTokenService(
      { ...settings, tenantSecret: "another-secret-another-secret-another-sec" },
      clock,
    );
    expect((await rejection(otherSecret.verify(token, "tenant"))).reason).toBe("bad_signature");
  });

  it("rejects garbage, alg=none and tokens without the access-token type", async () => {
    const service = new JwtAccessTokenService(settings, new FakeClock());
    await rejection(service.verify("not-a-jwt", "tenant"));

    const unsigned = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" })).toString("base64url"),
      Buffer.from(JSON.stringify({ tid: TENANT_A, sub: "u" })).toString("base64url"),
      "",
    ].join(".");
    await rejection(service.verify(unsigned, "tenant"));

    const idToken = await new SignJWT({ tid: TENANT_A, sid: "s", ver: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    await rejection(service.verify(idToken, "tenant"));
  });
});

describe("CryptoRefreshTokenService", () => {
  const service = new CryptoRefreshTokenService();
  const sessionId = "0198f0e0-0000-7000-8000-000000000002";

  it("generates session-prefixed tokens and stores only a hash", () => {
    const { token, hash } = service.generate(sessionId);
    expect(token.startsWith(`${sessionId}.`)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.split(".")[1]);
    expect(service.parse(token)).toEqual({ sessionId, hash });
    expect(service.generate(sessionId).token).not.toBe(token);
  });

  it("refuses malformed tokens", () => {
    for (const bad of [
      "",
      "abc",
      `${sessionId}.`,
      `${sessionId}.short`,
      `not-a-uuid.${"a".repeat(43)}`,
    ]) {
      expect(service.parse(bad), bad).toBeNull();
    }
  });
});

describe("HmacOtpService", () => {
  const otp = new HmacOtpService("otp-secret-otp-secret-otp-secret-otp-sec");

  it("generates six-digit codes", () => {
    for (let i = 0; i < 50; i++) expect(otp.generateCode()).toMatch(/^\d{6}$/);
  });

  it("binds the hash to subject, purpose and secret", () => {
    const hash = otp.hash("user-1", "password_reset", "123456");
    expect(otp.matches(hash, "user-1", "password_reset", "123456")).toBe(true);
    expect(otp.matches(hash, "user-1", "password_reset", "123457")).toBe(false);
    expect(otp.matches(hash, "user-2", "password_reset", "123456")).toBe(false);
    expect(otp.matches(hash, "user-1", "login_verification", "123456")).toBe(false);
    expect(otp.matches(hash, "user-1", "password_reset", "12345")).toBe(false);
    expect(
      new HmacOtpService("x".repeat(32)).matches(hash, "user-1", "password_reset", "123456"),
    ).toBe(false);
  });
});

describe("Argon2PasswordHasher", () => {
  const hasher = new Argon2PasswordHasher();

  it("hashes with argon2id and verifies", async () => {
    const hash = await hasher.hash("correct horse battery staple");
    expect(hash.startsWith("$argon2id$v=19$m=19456,p=1,t=2$")).toBe(true);
    await expect(hasher.verify(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(hasher.verify(hash, "wrong")).resolves.toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it("treats malformed or weaker hashes safely", async () => {
    await expect(hasher.verify("not-a-hash", "x")).resolves.toBe(false);
    expect(hasher.needsRehash("not-a-hash")).toBe(true);
    const weak = await new Argon2PasswordHasher({ ...ARGON2_OPTIONS, timeCost: 1 }).hash("pw");
    expect(hasher.needsRehash(weak)).toBe(true);
  });
});

describe("UuidV7Generator", () => {
  it("produces time-ordered RFC 9562 version 7 UUIDs", () => {
    let ms = 1_760_000_000_000;
    const ids = new UuidV7Generator(() => ms++);
    const generated = Array.from({ length: 20 }, () => ids.next());

    for (const id of generated) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect([...generated].sort()).toEqual(generated);
    expect(parseInt(generated[0]!.replaceAll("-", "").slice(0, 12), 16)).toBe(1_760_000_000_000);
  });
});
