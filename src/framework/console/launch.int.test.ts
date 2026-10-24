import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/** The go-live gate (P4-9): what the platform can check for itself before launch. */
const BASE = "/api/platform/v1";
let container: Container;
let app: Express;
let admin: TestStaff;

const api = () => request(app);
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });

type Check = { key: string; status: "pass" | "warn" | "fail"; fix: string | null };
const checks = async () => {
  const res = await api().get(`${BASE}/launch/readiness`).set(as(admin));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { ready: boolean; counts: Record<string, number>; checks: Check[] };
};
const status = (report: { checks: Check[] }, key: string) =>
  report.checks.find((c) => c.key === key)?.status;

beforeAll(async () => {
  container = await createTestContainer({ ONCALL_EMAILS: "oncall@example.com" });
  app = container.get<Express>(TYPES.HttpApp);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  await fixtures.create(["super_admin"]);
  const code = new TotpService().codeAt(admin.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${BASE}/auth/step-up`)
    .set(as(admin))
    .send({ password: admin.password, code })
    .expect(204);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("launch readiness", () => {
  it("checks billing, legal, operations and security, and says what to fix", async () => {
    await api()
      .put(`${BASE}/billing/plans/standard/price`)
      .set(as(admin))
      .send({ branchPriceMinor: 25_000, reason: "Launch price" })
      .expect(200);
    const report = await checks();
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(report.checks.length);
    expect(report.ready).toBe(report.counts.fail === 0);
    expect(status(report, "billing.price")).toBe("pass");
    expect(status(report, "ops.on_call")).toBe("pass");
    expect(status(report, "security.four_eyes")).toBe("pass");
    // Locally: the fake gateway is a warning, not production.
    expect(status(report, "billing.gateway")).toBe("warn");
    expect(status(report, "security.environment")).toBe("warn");
    for (const c of report.checks) expect(c.fix === null).toBe(c.status === "pass");
    expect(report.checks.map((c) => c.key)).toEqual(
      expect.arrayContaining([
        "billing.dry_run",
        "legal.terms",
        "ops.backups",
        "ops.drill",
        "ops.migrations",
      ]),
    );
  });
});
