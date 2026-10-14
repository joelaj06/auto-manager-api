import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HealthController } from "../../adapters/controllers/HealthController.js";
import { defineRoute, type ApiRoute } from "../../adapters/routes/ApiRoute.js";
import { healthRoutes } from "../../adapters/routes/healthRoutes.js";
import { openApiRoutes } from "../../adapters/routes/openApiRoutes.js";
import { idParams, paginationQuery } from "../../adapters/validators/commonRequests.js";
import { TenantDatabaseMismatchError } from "../../application/errors/TenantDatabaseErrors.js";
import type { IReadinessCheck } from "../../application/ports/IReadinessCheck.js";
import { ReadinessService } from "../../application/services/ReadinessService.js";
import { DomainError } from "../../domain/errors/DomainError.js";
import type { HttpConfig } from "../../infrastructure/config/config.js";
import { AsyncLocalRequestContext } from "../../infrastructure/context/AsyncLocalRequestContext.js";
import { JsonLogger, type LogEntry } from "../logger/JsonLogger.js";
import { createApp } from "./createApp.js";

class SeatLimitReachedError extends DomainError {
  readonly code = "SEAT_LIMIT_REACHED";
  constructor() {
    super("Your plan allows 2 branches");
  }
}

const defaultHttp: HttpConfig = {
  trustProxyHops: 0,
  corsAllowedOrigins: ["https://*.autoforce.app"],
  rateLimit: { windowMs: 60_000, max: 1_000 },
  bodyLimitKb: 1,
  exposeOpenApi: true,
};

function buildApp(options: { http?: Partial<HttpConfig>; checks?: IReadinessCheck[] } = {}) {
  const logs: LogEntry[] = [];
  const requestContext = new AsyncLocalRequestContext();
  const logger = new JsonLogger({
    level: "debug",
    sink: (entry) => logs.push(entry),
    contextProvider: () => {
      const current = requestContext.current();
      return current === undefined ? undefined : { requestId: current.requestId };
    },
  });

  const testRoutes: ApiRoute[] = [
    defineRoute({
      method: "post",
      path: "/api/v1/echo/:id",
      summary: "Echo validated input",
      tags: ["test"],
      request: {
        params: idParams,
        query: paginationQuery,
        body: z.object({ name: z.string().min(2), password: z.string() }),
      },
      responses: { 200: { description: "Echo" } },
      handler: (input, _req, res) => {
        res.json({ data: input });
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/fail/domain",
      summary: "Throws a domain error",
      tags: ["test"],
      responses: {},
      handler: () => {
        throw new SeatLimitReachedError();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/fail/async",
      summary: "Rejects with an unexpected error",
      tags: ["test"],
      responses: {},
      handler: async () => {
        await Promise.resolve();
        throw new Error("connect ECONNREFUSED postgres://app:pw@db");
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/fail/mismatch",
      summary: "Tenant database mismatch",
      tags: ["test"],
      responses: {},
      handler: () => {
        throw new TenantDatabaseMismatchError("a", "b", "t_b");
      },
    }),
  ];

  const health = new HealthController(new ReadinessService(options.checks ?? [], logger, 50));
  const routes = [...healthRoutes(health), ...testRoutes];
  const app = createApp({
    http: { ...defaultHttp, ...options.http },
    logger,
    requestContext,
    routes: [...routes, ...openApiRoutes(routes, { title: "Test", version: "1.0.0" })],
  });
  return { app, logs };
}

describe("HTTP pipeline", () => {
  describe("request ids", () => {
    it("generates an id and returns it", async () => {
      const res = await request(buildApp().app).get("/health/live");
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("keeps a well-formed incoming id and replaces a malformed one", async () => {
      const { app } = buildApp();
      const kept = await request(app).get("/health/live").set("x-request-id", "client-req-123456");
      expect(kept.headers["x-request-id"]).toBe("client-req-123456");

      const replaced = await request(app)
        .get("/health/live")
        .set("x-request-id", "bad id <script>");
      expect(replaced.headers["x-request-id"]).not.toContain("script");
    });

    it("adds the request id to logs written during the request", async () => {
      const { app, logs } = buildApp();
      const res = await request(app).get("/api/v1/fail/domain");
      const requestId = res.headers["x-request-id"];
      expect(logs.some((l) => l.msg === "Request failed" && l.requestId === requestId)).toBe(true);
    });
  });

  describe("health", () => {
    it("answers liveness", async () => {
      const res = await request(buildApp().app).get("/health/live");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { status: "ok" } });
    });

    it("reports ready when checks pass and 503 when one fails, without details", async () => {
      const ok = buildApp({ checks: [{ name: "database", check: () => Promise.resolve() }] });
      const ready = await request(ok.app).get("/health/ready");
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({
        data: { status: "ready", checks: [{ name: "database", status: "up" }] },
      });

      const down = buildApp({
        checks: [{ name: "database", check: () => Promise.reject(new Error("password failed")) }],
      });
      const notReady = await request(down.app).get("/health/ready");
      expect(notReady.status).toBe(503);
      expect(notReady.body.data.status).toBe("not_ready");
      expect(JSON.stringify(notReady.body)).not.toContain("password");
    });
  });

  describe("validation", () => {
    it("passes parsed, coerced input to the handler", async () => {
      const res = await request(buildApp().app)
        .post("/api/v1/echo/0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c?limit=5")
        .send({ name: "Ama", password: "x" });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        params: { id: "0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c" },
        query: { limit: 5 },
        body: { name: "Ama", password: "x" },
      });
    });

    it("reports every invalid field at once, without echoing values", async () => {
      const res = await request(buildApp().app)
        .post("/api/v1/echo/not-a-uuid?limit=0")
        .send({ name: "A", password: 42 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual([
        "body.name",
        "body.password",
        "params.id",
        "query.limit",
      ]);
      expect(JSON.stringify(res.body)).not.toContain("not-a-uuid");
    });

    it("rejects malformed JSON and oversized bodies", async () => {
      const { app } = buildApp();
      const malformed = await request(app)
        .post("/api/v1/echo/0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c")
        .set("content-type", "application/json")
        .send('{"name": ');
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.code).toBe("INVALID_JSON");

      const huge = await request(app)
        .post("/api/v1/echo/0199e1c2-7a3b-7f1e-9a4c-8d2e5f6a7b8c")
        .send({ name: "x".repeat(4_000), password: "p" });
      expect(huge.status).toBe(413);
      expect(huge.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  describe("errors", () => {
    it("maps domain errors to 422 with their message", async () => {
      const res = await request(buildApp().app).get("/api/v1/fail/domain");
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({
        code: "SEAT_LIMIT_REACHED",
        message: "Your plan allows 2 branches",
        requestId: res.headers["x-request-id"],
      });
    });

    it("hides unexpected failures but logs them with the stack and redacted secrets", async () => {
      const { app, logs } = buildApp();
      const res = await request(app).get("/api/v1/fail/async");
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|stack|pw@/);

      const logged = logs.find((l) => l.msg === "Request failed");
      expect(logged?.level).toBe("error");
      expect(JSON.stringify(logged)).toContain("stack");
      expect(JSON.stringify(logs)).not.toContain(":pw@");
    });

    it("logs a tenant database mismatch as a security alert", async () => {
      const { app, logs } = buildApp();
      const res = await request(app).get("/api/v1/fail/mismatch");
      expect(res.status).toBe(500);
      expect(
        logs.some((l) => l.msg === "SECURITY: request failed" && l.securityAlert === true),
      ).toBe(true);
    });

    it("returns 404 in the error envelope for unknown routes, logged without a stack", async () => {
      const { app, logs } = buildApp();
      const res = await request(app).delete("/api/v1/nope");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
      const logged = logs.find((l) => l.msg === "Request failed");
      expect(logged).toMatchObject({ level: "info", reason: "No route for DELETE /api/v1/nope" });
      expect(JSON.stringify(logged)).not.toContain("stack");
    });
  });

  describe("security headers and CORS", () => {
    it("sets security headers and hides the framework", async () => {
      const res = await request(buildApp().app).get("/health/live");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });

    it("allows listed browser origins and ignores others", async () => {
      const { app } = buildApp();
      const allowed = await request(app)
        .get("/health/live")
        .set("origin", "https://acme.autoforce.app");
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://acme.autoforce.app");

      const blocked = await request(app)
        .get("/health/live")
        .set("origin", "https://evil.example.com");
      expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("rate limiting", () => {
    it("limits /api requests per client and exempts health probes", async () => {
      const { app } = buildApp({ http: { rateLimit: { windowMs: 60_000, max: 2 } } });
      await request(app).get("/api/v1/nope");
      await request(app).get("/api/v1/nope");
      const limited = await request(app).get("/api/v1/nope");
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe("RATE_LIMITED");
      expect(limited.headers).toHaveProperty("ratelimit");

      for (let i = 0; i < 5; i += 1) {
        expect((await request(app).get("/health/live")).status).toBe(200);
      }
    });
  });

  describe("OpenAPI", () => {
    it("serves a document covering every route", async () => {
      const res = await request(buildApp().app).get("/api/v1/openapi.json");
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe("3.1.0");
      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining([
          "/health/live",
          "/health/ready",
          "/api/v1/echo/{id}",
          "/api/v1/openapi.json",
        ]),
      );
    });
  });
});
