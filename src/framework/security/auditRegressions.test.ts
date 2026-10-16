import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineRoute } from "../../adapters/routes/ApiRoute.js";
import { access } from "../../adapters/routes/RouteAccess.js";
import { InvalidAccessTokenError } from "../../application/errors/AuthErrors.js";
import { ConfigError, loadConfig } from "../../infrastructure/config/config.js";
import { buildGuardedApp, TENANT_A, TENANT_B, USER } from "../../testing/guardedApp.js";
import { JsonLogger, type LogEntry } from "../logger/JsonLogger.js";

/**
 * Regression tests for the security findings of the v1 audit (docs/01 §3, C1–C7). Each block
 * names the finding it guards against; none of these may be weakened without a decision.
 */

const SECRET_PASSWORD = "Sup3r-Secret-Passw0rd!";

describe("C1 — tokens are bound to one tenant", () => {
  it("rejects tenant A's token on tenant B (401 TENANT_MISMATCH, security alert)", async () => {
    const { app, logs, tokenFor } = buildGuardedApp();
    const res = await request(app)
      .post("/api/v1/users/search")
      .set("Authorization", `Bearer ${await tokenFor(TENANT_A)}`)
      .set("X-Tenant", "bravo")
      .send({ name: "Ama" });
    expect([res.status, res.body.error.code]).toEqual([401, "TENANT_MISMATCH"]);
    expect(logs.some((l) => l.msg === "SECURITY: request failed")).toBe(true);
  });

  it("rejects a token whose tenant claim was rewritten (per-tenant signing keys)", async () => {
    const { app, tokenFor } = buildGuardedApp();
    const [header, payload, signature] = (await tokenFor(TENANT_A)).split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as object;
    const forged = Buffer.from(JSON.stringify({ ...claims, tid: TENANT_B })).toString("base64url");

    const res = await request(app)
      .post("/api/v1/users/search")
      .set("Authorization", `Bearer ${header}.${forged}.${signature}`)
      .send({ name: "Ama" });
    expect([res.status, res.body.error.code]).toEqual([401, "INVALID_TOKEN"]);
  });
});

describe("C2 — platform and tenant credentials are separate", () => {
  it("never accepts a tenant token for the platform audience", async () => {
    const { tokens, tokenFor } = buildGuardedApp();
    await expect(tokens.verify(await tokenFor(TENANT_A), "platform")).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
  });

  it("never accepts a platform token on tenant routes", async () => {
    const { app, platformToken } = buildGuardedApp();
    const res = await request(app)
      .post("/api/v1/users/search")
      .set("Authorization", `Bearer ${await platformToken()}`)
      .send({ name: "Ama" });
    expect(res.status).toBe(401);
  });

  it("does not let a signed-in user call a route that needs a permission they lack", async () => {
    const { app, tokenFor } = buildGuardedApp();
    const res = await request(app)
      .delete("/api/v1/roles/x")
      .set("Authorization", `Bearer ${await tokenFor(TENANT_A)}`);
    expect([res.status, res.body.error.code]).toEqual([403, "FORBIDDEN"]);
  });
});

describe("C3 — self-registration never grants elevated roles", () => {
  it.todo(
    "public sign-up creates the owner only through tenant provisioning and never looks up roles by name (P1-5, identity module)",
  );
});

describe("C4 — permission changes and disabling take effect immediately", () => {
  it("rejects a token issued before the user's roles changed", async () => {
    const { app, tokenFor, userVersions } = buildGuardedApp();
    const token = await tokenFor(TENANT_A);
    userVersions.set(USER, 2);
    const res = await request(app)
      .post("/api/v1/users/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ama" });
    expect([res.status, res.body.error.code]).toEqual([401, "INVALID_TOKEN"]);
  });

  it("rejects every token of a disabled user", async () => {
    const { app, tokenFor, userVersions } = buildGuardedApp();
    const token = await tokenFor(TENANT_A);
    userVersions.delete(USER);
    const res = await request(app)
      .post("/api/v1/users/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Ama" });
    expect(res.status).toBe(401);
  });

  it("issues short-lived access tokens (at most one hour)", () => {
    expect(() => loadConfig({ ...secrets(), ACCESS_TOKEN_TTL_SECONDS: "86400" })).toThrow(
      ConfigError,
    );
  });
});

describe("C5 — no default or weak secrets", () => {
  it("refuses to start without every secret", () => {
    const issues = configIssues({});
    for (const name of [
      "PLATFORM_DB_PASSWORD",
      "TENANT_DB_PASSWORD",
      "MIGRATOR_DB_PASSWORD",
      "BACKUP_DB_PASSWORD",
      "TENANT_JWT_SECRET",
      "PLATFORM_JWT_SECRET",
      "OTP_SECRET",
    ]) {
      expect(
        issues.some((issue) => issue.startsWith(`${name}:`)),
        name,
      ).toBe(true);
    }
  });

  it("rejects short signing keys and a platform key equal to the tenant key", () => {
    const short = configIssues({ ...secrets(), TENANT_JWT_SECRET: "secret" });
    expect(short).toEqual([expect.stringMatching(/^TENANT_JWT_SECRET:/)]);
    const same = configIssues({ ...secrets(), PLATFORM_JWT_SECRET: secrets().TENANT_JWT_SECRET });
    expect(same).toEqual([expect.stringMatching(/^PLATFORM_JWT_SECRET:/)]);
  });

  it("never echoes secret values in configuration errors", () => {
    const issues = configIssues({ ...secrets(), TENANT_JWT_SECRET: "leaky-short" });
    expect(issues.join("\n")).not.toContain("leaky-short");
  });
});

describe("C6 — no stack traces in responses, no secrets in logs", () => {
  const failing = defineRoute({
    method: "post",
    path: "/api/v1/explode",
    summary: "Throws",
    tags: ["test"],
    access: access.public(),
    responses: {},
    handler: () => {
      throw new Error(`database password ${SECRET_PASSWORD} rejected at /srv/app/db.ts:42`);
    },
  });
  const login = defineRoute({
    method: "post",
    path: "/api/v1/fake-login",
    summary: "Validates a credential body",
    tags: ["test"],
    access: access.public(),
    request: { body: z.object({ email: z.email(), password: z.string().min(64) }) },
    responses: {},
    handler: () => undefined,
  });

  it("answers server errors with a generic message and no stack", async () => {
    const { app } = buildGuardedApp({ extraRoutes: [failing] });
    const res = await request(app).post("/api/v1/explode").send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again later.",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|\.ts:\d+|Sup3r/);
  });

  it("does not echo or log submitted passwords", async () => {
    const { app, logs } = buildGuardedApp({ extraRoutes: [login] });
    const res = await request(app)
      .post("/api/v1/fake-login")
      .send({ email: "not-an-email", password: SECRET_PASSWORD });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_PASSWORD);
    expect(JSON.stringify(logs)).not.toContain(SECRET_PASSWORD);
  });

  it("redacts secret-looking fields wherever they are logged", () => {
    const entries: LogEntry[] = [];
    const logger = new JsonLogger({ level: "info", sink: (entry) => entries.push(entry) });
    logger.info("login attempt", {
      body: {
        email: "a@b.co",
        password: SECRET_PASSWORD,
        nested: { refreshToken: "rt", otp: "123456" },
      },
      authorization: "Bearer abc",
      url: "postgres://app:hunter2@db:5432/x",
    });
    const text = JSON.stringify(entries);
    for (const secret of [SECRET_PASSWORD, '"rt"', "123456", "Bearer abc", "hunter2"]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

describe("C7 — no regular expressions built from runtime input", () => {
  it("has no RegExp constructor calls in production code (also enforced by ESLint)", () => {
    const offenders = productionSources("src").filter((file) =>
      /\bRegExp\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

function secrets() {
  return {
    PLATFORM_DB_PASSWORD: "platform-secret-1234",
    TENANT_DB_PASSWORD: "tenant-secret-12345",
    MIGRATOR_DB_PASSWORD: "migrator-secret-1234",
    BACKUP_DB_PASSWORD: "backup-secret-12345",
    TENANT_JWT_SECRET: "t".repeat(40),
    PLATFORM_JWT_SECRET: "p".repeat(40),
    OTP_SECRET: "o".repeat(40),
  };
}

function configIssues(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

function productionSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}
