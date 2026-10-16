import { randomUUID } from "node:crypto";
import type { Container } from "inversify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PermissionGrants } from "../../../application/authorization/Principal.js";
import {
  InvalidRefreshTokenError,
  OtpVerificationFailedError,
  RefreshTokenReuseError,
} from "../../../application/errors/AuthErrors.js";
import type { IAccessTokenService } from "../../../application/ports/IAccessTokenService.js";
import type { IAuditTrail } from "../../../application/ports/IAuditTrail.js";
import type { IClock } from "../../../application/ports/IClock.js";
import type { IPermissionResolver } from "../../../application/ports/IPermissionResolver.js";
import type { IRefreshTokenService } from "../../../application/ports/IRefreshTokenService.js";
import type { IRequestContext } from "../../../application/ports/IRequestContext.js";
import type { ITenantContext } from "../../../application/ports/ITenantContext.js";
import type { ITenantDatabaseProvisioner } from "../../../application/ports/ITenantDatabaseProvisioner.js";
import type { IUnitOfWork } from "../../../application/ports/IUnitOfWork.js";
import type { IssueOtpChallenge } from "../../../application/use-cases/auth/IssueOtpChallenge.js";
import { RefreshAuthSession } from "../../../application/use-cases/auth/RefreshAuthSession.js";
import type { RevokeAuthSession } from "../../../application/use-cases/auth/RevokeAuthSession.js";
import type { StartAuthSession } from "../../../application/use-cases/auth/StartAuthSession.js";
import type { VerifyOtpChallenge } from "../../../application/use-cases/auth/VerifyOtpChallenge.js";
import type { IAuthSessionRepository } from "../../../domain/repositories/IAuthSessionRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { disposeContainer } from "../../../framework/dependency-injection/container.js";
import { TYPES } from "../../../framework/dependency-injection/types.js";
import { createTestContainer } from "../../../testing/testContainer.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";
import { PostgresTenantDirectory } from "./PostgresTenantDirectory.js";

const tenantId = TenantId.from(randomUUID());
const userId = randomUUID();
let container: Container;
let tenantContext: ITenantContext;
let unitOfWork: IUnitOfWork;
let transactions: PostgresTransactionContext;
let refresh: RefreshAuthSession;

const asTenant = <T>(work: () => Promise<T>) => tenantContext.runAs(tenantId, work);
const query = <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  asTenant(() =>
    unitOfWork.run(async () => (await transactions.current().query<R>(sql, params)).rows),
  );

/** The container has no users until P1-5; this resolver knows one user. */
const oneUser: IPermissionResolver = {
  currentVersion: (_tenantId, id) => Promise.resolve(id === userId ? 1 : null),
  resolve: (): Promise<PermissionGrants | null> =>
    Promise.resolve({ permissions: new Map(), branchIds: [] }),
};

beforeAll(async () => {
  container = await createTestContainer();
  await container
    .get<ITenantDatabaseProvisioner>(TYPES.TenantDatabaseProvisioner)
    .provision(tenantId);
  tenantContext = container.get<ITenantContext>(TYPES.TenantContext);
  unitOfWork = container.get<IUnitOfWork>(TYPES.UnitOfWork);
  transactions = container.get<PostgresTransactionContext>(TYPES.PostgresTransactionContext);
  refresh = new RefreshAuthSession({
    unitOfWork,
    tenantContext,
    sessions: container.get<IAuthSessionRepository>(TYPES.AuthSessionRepository),
    accessTokens: container.get<IAccessTokenService>(TYPES.AccessTokenService),
    refreshTokens: container.get<IRefreshTokenService>(TYPES.RefreshTokenService),
    permissions: oneUser,
    auditTrail: container.get<IAuditTrail>(TYPES.AuditTrail),
    requestContext: container.get<IRequestContext>(TYPES.RequestContext),
    clock: container.get<IClock>(TYPES.Clock),
  });
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("auth sessions (PostgreSQL)", () => {
  const start = () =>
    asTenant(() =>
      container
        .get<StartAuthSession>(TYPES.StartAuthSession)
        .execute({ userId, permissionVersion: 1, userAgent: "vitest" }),
    );

  it("stores the session with hashes only, and audits it", async () => {
    const result = await start();
    const [row] = await query<{ refresh_token_hash: string; user_agent: string }>(
      "select refresh_token_hash, user_agent from auth_sessions where id = $1",
      [result.sessionId],
    );
    expect(row?.user_agent).toBe("vitest");
    expect(row?.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(result.refreshToken.split(".")[1]);

    const audit = await query<{ action: string }>(
      "select action from audit_logs where entity_id = $1",
      [result.sessionId],
    );
    expect(audit.map((a) => a.action)).toEqual(["auth.session_started"]);
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const first = await start();
    const second = await asTenant(() => refresh.execute(first.refreshToken));
    expect(second.sessionId).toBe(first.sessionId);

    await expect(asTenant(() => refresh.execute(first.refreshToken))).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );
    // The revocation was committed even though the request failed.
    const [row] = await query<{ revocation_reason: string }>(
      "select revocation_reason from auth_sessions where id = $1",
      [first.sessionId],
    );
    expect(row?.revocation_reason).toBe("refresh_token_reuse");
    await expect(asTenant(() => refresh.execute(second.refreshToken))).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
  });

  it("serialises concurrent refreshes of one token: one wins, the other is treated as reuse", async () => {
    const { refreshToken } = await start();
    const results = await Promise.allSettled([
      asTenant(() => refresh.execute(refreshToken)),
      asTenant(() => refresh.execute(refreshToken)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(RefreshTokenReuseError);
  });

  it("revokes on logout", async () => {
    const { sessionId, refreshToken } = await start();
    await asTenant(() =>
      container
        .get<RevokeAuthSession>(TYPES.RevokeAuthSession)
        .execute({ sessionId, reason: "logout", actorId: userId }),
    );
    await expect(asTenant(() => refresh.execute(refreshToken))).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
  });

  it("refuses refresh tokens of another tenant's session", async () => {
    const other = TenantId.from(randomUUID());
    await container
      .get<ITenantDatabaseProvisioner>(TYPES.TenantDatabaseProvisioner)
      .provision(other);
    const { refreshToken } = await start();
    await expect(
      tenantContext.runAs(other, () => refresh.execute(refreshToken)),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
  });
});

describe("OTP challenges (PostgreSQL)", () => {
  const subject = "ama@example.com";
  const issue = () =>
    asTenant(() =>
      container
        .get<IssueOtpChallenge>(TYPES.IssueOtpChallenge)
        .execute({ subject, purpose: "email_verification" }),
    );
  const verify = (code: string) =>
    asTenant(() =>
      container
        .get<VerifyOtpChallenge>(TYPES.VerifyOtpChallenge)
        .execute({ subject, purpose: "email_verification", code }),
    );
  const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

  it("persists failed attempts and verifies once", async () => {
    const { code, challengeId } = await issue();
    await expect(verify(wrong(code))).rejects.toBeInstanceOf(OtpVerificationFailedError);

    const [row] = await query<{ attempts: number; code_hash: string }>(
      "select attempts, code_hash from otp_challenges where id = $1",
      [challengeId],
    );
    expect(row?.attempts).toBe(1);
    expect(row?.code_hash).not.toContain(code);

    await expect(verify(code)).resolves.toBeUndefined();
    await expect(verify(code)).rejects.toMatchObject({ code: "OTP_EXPIRED" });
  });

  it("keeps only the newest code open", async () => {
    const first = await issue();
    const second = await issue();
    const rows = await query<{ id: string; open: boolean }>(
      `select id, (consumed_at is null and invalidated_at is null) as open
         from otp_challenges where id = any($1)`,
      [[first.challengeId, second.challengeId]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.open]))).toEqual({
      [first.challengeId]: false,
      [second.challengeId]: true,
    });
  });
});

describe("PostgresTenantDirectory", () => {
  it("finds tenants by slug and id, and ignores malformed input", async () => {
    const pool = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
    const slug = `dir-${randomUUID().slice(0, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      "insert into tenants (slug, name, status) values ($1, 'Directory test', 'active') returning id",
      [slug],
    );
    const id = rows[0]!.id;
    const directory = new PostgresTenantDirectory(pool);

    await expect(directory.findBySlug(slug.toUpperCase())).resolves.toEqual({
      id,
      slug,
      status: "active",
    });
    await expect(directory.findById(id)).resolves.toMatchObject({ slug });
    await expect(directory.findBySlug("no-such-tenant")).resolves.toBeNull();
    await expect(directory.findBySlug("bad slug; drop")).resolves.toBeNull();
    await expect(directory.findById("not-a-uuid")).resolves.toBeNull();
  });
});
