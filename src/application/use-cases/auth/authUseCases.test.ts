import { beforeEach, describe, expect, it } from "vitest";
import { AuthSession } from "../../../domain/entities/AuthSession.js";
import { OtpChallenge } from "../../../domain/entities/OtpChallenge.js";
import type { OtpPurpose } from "../../../domain/enums/OtpPurpose.js";
import type { IAuthSessionRepository } from "../../../domain/repositories/IAuthSessionRepository.js";
import type { IOtpChallengeRepository } from "../../../domain/repositories/IOtpChallengeRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { PermissionGrants } from "../../authorization/Principal.js";
import type { AuditEntry } from "../../dto/AuditEntry.js";
import {
  InvalidAccessTokenError,
  InvalidRefreshTokenError,
  OtpVerificationFailedError,
  RefreshTokenReuseError,
} from "../../errors/AuthErrors.js";
import {
  TenantInactiveError,
  TenantMismatchError,
  TenantNotFoundError,
  TenantRequiredError,
} from "../../errors/TenantErrors.js";
import type { AccessTokenSubject, IAccessTokenService } from "../../ports/IAccessTokenService.js";
import type { IOtpService } from "../../ports/IOtpService.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { IRefreshTokenService } from "../../ports/IRefreshTokenService.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory, TenantSummary } from "../../ports/ITenantDirectory.js";
import { AuthenticateTenantRequest } from "./AuthenticateTenantRequest.js";
import { IssueOtpChallenge } from "./IssueOtpChallenge.js";
import { RefreshAuthSession } from "./RefreshAuthSession.js";
import { ResolveTenant } from "./ResolveTenant.js";
import { RevokeAuthSession } from "./RevokeAuthSession.js";
import { StartAuthSession } from "./StartAuthSession.js";
import { VerifyOtpChallenge } from "./VerifyOtpChallenge.js";

const TENANT_A = "0198f0e0-0000-7000-8000-00000000000a";
const TENANT_B = "0198f0e0-0000-7000-8000-00000000000b";
const DAY = 86_400_000;

// --- In-memory doubles -------------------------------------------------------------------------

class FakeClock {
  current = new Date("2026-10-14T10:00:00Z");
  now = () => this.current;
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class SequentialIds {
  private n = 0;
  next = () => `id-${++this.n}`;
}

/** Transactional enough for tests: rolls back nothing, but runs work like the real one. */
const unitOfWork = { run: <T>(work: () => Promise<T>) => work() };

const tenantContext = (tenantId: string): ITenantContext => ({
  runAs: (_id, fn) => fn(),
  currentTenantId: () => TenantId.from(tenantId),
});

const requestContext = {
  run: <T>(_data: unknown, fn: () => T) => fn(),
  current: () => ({ requestId: "req-1", ip: "203.0.113.9" }),
};

class MemorySessions implements IAuthSessionRepository {
  readonly rows = new Map<string, ReturnType<AuthSession["snapshot"]>>();
  findById = (id: string) => {
    const row = this.rows.get(id);
    return Promise.resolve(row === undefined ? null : AuthSession.restore(row));
  };
  lockById = this.findById;
  save = (session: AuthSession) => {
    this.rows.set(session.id, session.snapshot());
    return Promise.resolve();
  };
}

class MemoryChallenges implements IOtpChallengeRepository {
  readonly rows: ReturnType<OtpChallenge["snapshot"]>[] = [];
  findOpen = (subject: string, purpose: OtpPurpose) => {
    const row = this.rows
      .filter((r) => r.subject === subject && r.purpose === purpose)
      .filter((r) => r.consumedAt === null && r.invalidatedAt === null)
      .at(-1);
    return Promise.resolve(row === undefined ? null : OtpChallenge.restore(row));
  };
  lockOpen = this.findOpen;
  save = (challenge: OtpChallenge) => {
    const snapshot = challenge.snapshot();
    const index = this.rows.findIndex((r) => r.id === snapshot.id);
    if (index === -1) this.rows.push(snapshot);
    else this.rows[index] = snapshot;
    return Promise.resolve();
  };
}

class MemoryAudit {
  readonly entries: AuditEntry[] = [];
  record = (entry: AuditEntry) => {
    this.entries.push(entry);
    return Promise.resolve(`audit-${this.entries.length}`);
  };
}

/** Tokens are JSON so tests can read them; a "bad" token fails verification. */
const accessTokens: IAccessTokenService = {
  issue: (subject) =>
    Promise.resolve({
      token: JSON.stringify(subject),
      expiresAt: new Date("2026-10-14T10:15:00Z"),
    }),
  verify: <A extends AccessTokenSubject["audience"]>(token: string, audience: A) => {
    try {
      const subject = JSON.parse(token) as AccessTokenSubject;
      if (subject.audience !== audience) throw new Error("audience");
      return Promise.resolve(subject as Extract<AccessTokenSubject, { audience: A }>);
    } catch {
      return Promise.reject(new InvalidAccessTokenError("malformed"));
    }
  },
};

class CountingRefreshTokens implements IRefreshTokenService {
  private n = 0;
  generate = (sessionId: string) => {
    const secret = `secret${++this.n}`;
    return { token: `${sessionId}.${secret}`, hash: `h(${secret})` };
  };
  parse = (token: string) => {
    const [sessionId, secret, extra] = token.split(".");
    if (!sessionId || !secret || extra !== undefined) return null;
    return { sessionId, hash: `h(${secret})` };
  };
}

class FakePermissions implements IPermissionResolver {
  versions = new Map<string, number>([["user-1", 3]]);
  grants: PermissionGrants = {
    permissions: new Map([["users.list", { scope: "all" }]]),
    branchIds: [],
  };
  currentVersion = (_tenantId: string, userId: string) =>
    Promise.resolve(this.versions.get(userId) ?? null);
  resolve = (_tenantId: string, userId: string) =>
    Promise.resolve(this.versions.has(userId) ? this.grants : null);
}

class FakeDirectory implements ITenantDirectory {
  tenants: TenantSummary[] = [
    { id: TENANT_A, slug: "alpha", status: "active" },
    { id: TENANT_B, slug: "bravo", status: "active" },
  ];
  findBySlug = (slug: string) => Promise.resolve(this.tenants.find((t) => t.slug === slug) ?? null);
  findById = (id: string) => Promise.resolve(this.tenants.find((t) => t.id === id) ?? null);
  invalidate = () => undefined;
}

const otp: IOtpService = {
  generateCode: () => "123456",
  hash: (subject, purpose, code) => `${purpose}:${subject}:${code}`,
  matches: (hash, subject, purpose, code) => hash === `${purpose}:${subject}:${code}`,
};

// --- Sessions ----------------------------------------------------------------------------------

describe("auth sessions", () => {
  let clock: FakeClock;
  let sessions: MemorySessions;
  let audit: MemoryAudit;
  let permissions: FakePermissions;
  let start: StartAuthSession;
  let refresh: RefreshAuthSession;
  let revoke: RevokeAuthSession;

  beforeEach(() => {
    clock = new FakeClock();
    sessions = new MemorySessions();
    audit = new MemoryAudit();
    permissions = new FakePermissions();
    const refreshTokens = new CountingRefreshTokens();
    const common = {
      unitOfWork,
      tenantContext: tenantContext(TENANT_A),
      sessions,
      accessTokens,
      refreshTokens,
      auditTrail: audit,
      requestContext,
      clock,
    };
    start = new StartAuthSession({
      ...common,
      ids: new SequentialIds(),
      settings: { refreshTokenTtlMs: 30 * DAY },
    });
    refresh = new RefreshAuthSession({ ...common, permissions });
    revoke = new RevokeAuthSession({ ...common });
  });

  it("starts a session bound to the current tenant and audits it", async () => {
    const result = await start.execute({ userId: "user-1", permissionVersion: 3, userAgent: "ua" });

    expect(JSON.parse(result.accessToken)).toEqual({
      audience: "tenant",
      tenantId: TENANT_A,
      userId: "user-1",
      sessionId: result.sessionId,
      permissionVersion: 3,
    });
    expect(result.refreshToken.startsWith(`${result.sessionId}.`)).toBe(true);
    expect(result.refreshTokenExpiresAt).toEqual(new Date(clock.now().getTime() + 30 * DAY));
    const stored = sessions.rows.get(result.sessionId);
    expect(stored?.refreshTokenHash).not.toContain(result.refreshToken);
    expect(stored?.ip).toBe("203.0.113.9");
    expect(audit.entries.map((e) => e.action)).toEqual(["auth.session_started"]);
  });

  it("rotates the refresh token and keeps the absolute expiry", async () => {
    const first = await start.execute({ userId: "user-1", permissionVersion: 3 });
    clock.advance(DAY);
    const second = await refresh.execute(first.refreshToken);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.refreshTokenExpiresAt).toEqual(first.refreshTokenExpiresAt);
    await expect(refresh.execute(second.refreshToken)).resolves.toBeDefined();
  });

  it("issues access tokens with the current permission version on refresh", async () => {
    const first = await start.execute({ userId: "user-1", permissionVersion: 3 });
    permissions.versions.set("user-1", 4);
    const second = await refresh.execute(first.refreshToken);
    expect(JSON.parse(second.accessToken)).toMatchObject({ permissionVersion: 4 });
  });

  it("revokes the session when a rotated-away token is reused", async () => {
    const first = await start.execute({ userId: "user-1", permissionVersion: 3 });
    const second = await refresh.execute(first.refreshToken);

    await expect(refresh.execute(first.refreshToken)).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );
    expect(sessions.rows.get(first.sessionId)?.revocationReason).toBe("refresh_token_reuse");
    expect(audit.entries.map((e) => e.action)).toContain("auth.refresh_token_reused");
    // The legitimate holder of the newest token is signed out too.
    await expect(refresh.execute(second.refreshToken)).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
  });

  it("rejects malformed, unknown, expired and revoked tokens", async () => {
    await expect(refresh.execute("garbage")).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    await expect(refresh.execute("nope.secret")).rejects.toBeInstanceOf(InvalidRefreshTokenError);

    const expiring = await start.execute({ userId: "user-1", permissionVersion: 3 });
    clock.advance(31 * DAY);
    await expect(refresh.execute(expiring.refreshToken)).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );

    const revoked = await start.execute({ userId: "user-1", permissionVersion: 3 });
    await revoke.execute({ sessionId: revoked.sessionId, reason: "logout", actorId: "user-1" });
    await expect(refresh.execute(revoked.refreshToken)).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
  });

  it("revokes the session of a disabled user on refresh", async () => {
    const first = await start.execute({ userId: "user-1", permissionVersion: 3 });
    permissions.versions.delete("user-1");
    await expect(refresh.execute(first.refreshToken)).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
    expect(sessions.rows.get(first.sessionId)?.revocationReason).toBe("user_disabled");
  });

  it("revokes idempotently and audits once", async () => {
    const { sessionId } = await start.execute({ userId: "user-1", permissionVersion: 3 });
    await revoke.execute({ sessionId, reason: "logout", actorId: "user-1" });
    await revoke.execute({ sessionId, reason: "admin_revoked", actorId: "admin" });
    await revoke.execute({ sessionId: "unknown", reason: "logout", actorId: "user-1" });

    expect(sessions.rows.get(sessionId)?.revocationReason).toBe("logout");
    expect(audit.entries.filter((e) => e.action === "auth.session_revoked")).toHaveLength(1);
  });
});

// --- Request authentication --------------------------------------------------------------------

describe("AuthenticateTenantRequest", () => {
  let directory: FakeDirectory;
  let permissions: FakePermissions;
  let authenticate: AuthenticateTenantRequest;
  const token = (overrides: Partial<Extract<AccessTokenSubject, { audience: "tenant" }>> = {}) =>
    JSON.stringify({
      audience: "tenant",
      tenantId: TENANT_A,
      userId: "user-1",
      sessionId: "s-1",
      permissionVersion: 3,
      ...overrides,
    });

  beforeEach(() => {
    directory = new FakeDirectory();
    permissions = new FakePermissions();
    authenticate = new AuthenticateTenantRequest({ accessTokens, tenants: directory, permissions });
  });

  it("returns the tenant and principal", async () => {
    const { tenant, principal } = await authenticate.execute({
      accessToken: token(),
      tenantSlug: "alpha",
    });
    expect(tenant.id).toBe(TENANT_A);
    expect(principal).toMatchObject({ userId: "user-1", tenantId: TENANT_A, sessionId: "s-1" });
    expect(principal.grantFor("users.list")).toEqual({ scope: "all" });
  });

  it("takes the tenant from the token when none is addressed", async () => {
    const { tenant } = await authenticate.execute({ accessToken: token() });
    expect(tenant.slug).toBe("alpha");
  });

  it("rejects tenant A's token on tenant B", async () => {
    await expect(
      authenticate.execute({ accessToken: token(), tenantSlug: "bravo" }),
    ).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it("rejects invalid tokens, unknown and deactivated tenants", async () => {
    await expect(authenticate.execute({ accessToken: "bad" })).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
    await expect(
      authenticate.execute({ accessToken: token(), tenantSlug: "missing" }),
    ).rejects.toBeInstanceOf(TenantNotFoundError);
    await expect(
      authenticate.execute({
        accessToken: token({ tenantId: "0198f0e0-0000-7000-8000-0000000000ff" }),
      }),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);

    directory.tenants[0] = { id: TENANT_A, slug: "alpha", status: "deactivated" };
    await expect(authenticate.execute({ accessToken: token() })).rejects.toBeInstanceOf(
      TenantInactiveError,
    );
  });

  it("rejects tokens of disabled users and with stale permissions", async () => {
    permissions.versions.set("user-1", 4);
    await expect(authenticate.execute({ accessToken: token() })).rejects.toMatchObject({
      reason: "stale_permissions",
    });
    permissions.versions.delete("user-1");
    await expect(authenticate.execute({ accessToken: token() })).rejects.toMatchObject({
      reason: "user_unavailable",
    });
  });
});

describe("ResolveTenant", () => {
  const directory = new FakeDirectory();
  directory.tenants.push({
    id: "0198f0e0-0000-7000-8000-0000000000cc",
    slug: "new",
    status: "provisioning",
  });
  const resolve = new ResolveTenant(directory);

  it("resolves usable tenants by slug", async () => {
    await expect(resolve.execute("alpha")).resolves.toMatchObject({ id: TENANT_A });
  });

  it("requires a slug and hides tenants that are not ready", async () => {
    await expect(resolve.execute(undefined)).rejects.toBeInstanceOf(TenantRequiredError);
    await expect(resolve.execute("")).rejects.toBeInstanceOf(TenantRequiredError);
    await expect(resolve.execute("nobody")).rejects.toBeInstanceOf(TenantNotFoundError);
    await expect(resolve.execute("new")).rejects.toBeInstanceOf(TenantNotFoundError);
  });
});

// --- One-time codes ----------------------------------------------------------------------------

describe("OTP challenges", () => {
  let clock: FakeClock;
  let challenges: MemoryChallenges;
  let issue: IssueOtpChallenge;
  let verify: VerifyOtpChallenge;
  const subject = "user-1";
  const purpose = "password_reset" as const;

  beforeEach(() => {
    clock = new FakeClock();
    challenges = new MemoryChallenges();
    issue = new IssueOtpChallenge({
      unitOfWork,
      challenges,
      otp,
      ids: new SequentialIds(),
      clock,
      settings: { ttlMs: 600_000, maxAttempts: 3 },
    });
    verify = new VerifyOtpChallenge({ unitOfWork, challenges, otp, clock });
  });

  it("stores only a hash and verifies the code once", async () => {
    const issued = await issue.execute({ subject, purpose });
    expect(issued.code).toBe("123456");
    expect(challenges.rows[0]?.codeHash).toBe("password_reset:user-1:123456");

    await expect(verify.execute({ subject, purpose, code: "123456" })).resolves.toBeUndefined();
    await expect(verify.execute({ subject, purpose, code: "123456" })).rejects.toMatchObject({
      code: "OTP_EXPIRED",
    });
  });

  it("persists failed attempts and locks", async () => {
    await issue.execute({ subject, purpose });
    await expect(verify.execute({ subject, purpose, code: "000000" })).rejects.toMatchObject({
      code: "OTP_INVALID",
      remainingAttempts: 2,
    });
    await expect(verify.execute({ subject, purpose, code: "000000" })).rejects.toMatchObject({
      remainingAttempts: 1,
    });
    await expect(verify.execute({ subject, purpose, code: "000000" })).rejects.toMatchObject({
      code: "OTP_LOCKED",
    });
    await expect(verify.execute({ subject, purpose, code: "123456" })).rejects.toBeInstanceOf(
      OtpVerificationFailedError,
    );
  });

  it("invalidates the previous code when a new one is issued", async () => {
    await issue.execute({ subject, purpose });
    await issue.execute({ subject, purpose });
    expect(challenges.rows.map((r) => r.invalidatedAt !== null)).toEqual([true, false]);
  });

  it("expires codes and keeps purposes apart", async () => {
    await issue.execute({ subject, purpose });
    await expect(
      verify.execute({ subject, purpose: "login_verification", code: "123456" }),
    ).rejects.toMatchObject({ code: "OTP_EXPIRED" });

    clock.advance(600_000);
    await expect(verify.execute({ subject, purpose, code: "123456" })).rejects.toMatchObject({
      code: "OTP_EXPIRED",
    });
  });
});
