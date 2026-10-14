import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/** The app exactly as the container wires it, against the test databases. */
describe("HTTP app (container-wired)", () => {
  it("is ready when the platform database answers", async () => {
    const container = await createTestContainer();
    try {
      const res = await request(container.get<Express>(TYPES.HttpApp)).get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: { status: "ready", checks: [{ name: "database", status: "up" }] },
      });
    } finally {
      await disposeContainer(container);
    }
  });

  it("is not ready when the database rejects the app's credentials", async () => {
    const container = await createTestContainer({
      PLATFORM_DB_PASSWORD: "definitely-the-wrong-password",
      LOG_LEVEL: "silent",
    });
    try {
      const res = await request(container.get<Express>(TYPES.HttpApp)).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.data).toEqual({
        status: "not_ready",
        checks: [{ name: "database", status: "down" }],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|authentication/i);
    } finally {
      await disposeContainer(container);
    }
  });

  it("serves the OpenAPI document outside production", async () => {
    const container = await createTestContainer();
    try {
      const res = await request(container.get<Express>(TYPES.HttpApp)).get("/api/v1/openapi.json");
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining(["/health/live", "/health/ready", "/api/v1/openapi.json"]),
      );
    } finally {
      await disposeContainer(container);
    }
  });

  it("does not serve the OpenAPI document when disabled", async () => {
    const container = await createTestContainer({ EXPOSE_OPENAPI: "false", LOG_LEVEL: "silent" });
    try {
      const res = await request(container.get<Express>(TYPES.HttpApp)).get("/api/v1/openapi.json");
      expect(res.status).toBe(404);
    } finally {
      await disposeContainer(container);
    }
  });
});
