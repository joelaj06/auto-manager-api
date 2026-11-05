import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiRoute } from "../../adapters/routes/ApiRoute.js";
import type { IPartnerQueries } from "../../application/ports/IPartnerQueries.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

let container: Container;
let app: Express;
let admin: TestStaff;
let t: ProvisionedTenant;

const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const staff = () => ({ Authorization: `Bearer ${admin.accessToken}` });
const vehicles = (query: string) => request(app).get(`/api/v1/vehicles?${query}`).set(owner());

beforeAll(async () => {
  container = await createTestContainer();
  app = container.get<Express>(TYPES.HttpApp);
  admin = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, admin).create();
  for (let n = 0; n < 5; n += 1) {
    const res = await request(app)
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Vitz", plateNumber: `GR ${String(1000 + n)}-26` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("numbered pages", () => {
  it("gives the total, page and page size in the headers and only rows in the body", async () => {
    const res = await vehicles("pageSize=2");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers).toMatchObject({
      "x-total-count": "5",
      "x-page": "1",
      "x-page-size": "2",
    });
    expect(res.body.data).toHaveLength(2);
    expect(res.body).not.toHaveProperty("meta");
  });

  it("lets a client jump straight to any page, each row on one page", async () => {
    const last = await vehicles("page=3&pageSize=2");
    expect(last.headers).toMatchObject({ "x-total-count": "5", "x-page": "3" });
    expect(last.body.data).toHaveLength(1);

    const pages = await Promise.all([1, 2, 3].map((p) => vehicles(`page=${p}&pageSize=2`)));
    const ids = pages.flatMap((p) => (p.body.data as { id: string }[]).map((v) => v.id));
    expect(new Set(ids).size).toBe(5);
    expect(ids[4]).toBe((last.body.data as { id: string }[])[0]!.id);
  });

  it("answers past the end with no rows and the true total", async () => {
    const res = await vehicles("page=9&pageSize=2");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.headers).toMatchObject({ "x-total-count": "5", "x-page": "9" });
  });

  it("counts only what the filters leave", async () => {
    const res = await vehicles("search=GR1003&pageSize=2");
    expect(res.headers["x-total-count"]).toBe("1");
    const none = await vehicles("status=on_rent&page=2");
    expect(none.headers["x-total-count"]).toBe("0");
  });

  it.each(["page=0", "page=1.5", "page=x", "pageSize=0", "pageSize=101"])(
    "refuses %s",
    async (q) => {
      const res = await vehicles(q);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    },
  );
});

describe("every list that takes a page", () => {
  const paged = () =>
    container
      .get<ApiRoute[]>(TYPES.ApiRoutes)
      .filter((r) => r.request?.query?.shape !== undefined && "pageSize" in r.request.query.shape);

  /** Page 9 of 1-row pages is past these rows, which always runs the count. */
  const ask = (route: ApiRoute) => {
    const path = route.path
      .replace(/^(\/api\/platform\/v1\/tenants\/):id/, `$1${t.tenantId}`)
      .replace(/:[A-Za-z]+/g, randomUUID());
    return request(app)
      .get(`${path}?page=9&pageSize=1`)
      .set(route.path.startsWith("/api/platform/") ? staff() : owner());
  };

  it("answers with the headers and a list, counting without an error", async () => {
    const answered: string[] = [];
    for (const route of paged()) {
      const res = await ask(route);
      const where = `${route.path}: ${res.status} ${JSON.stringify(res.body)}`;
      expect(res.status, where).toBeLessThan(500);
      if (res.status !== 200) continue;
      answered.push(route.path);
      expect(res.headers["x-page"], where).toBe("9");
      expect(res.headers["x-page-size"], where).toBe("1");
      expect(Number(res.headers["x-total-count"]), where).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(res.body.data), where).toBe(true);
    }
    // Lists of someone else (a driver, a partner) or of one record are covered below.
    expect(paged().length).toBeGreaterThanOrEqual(88);
    expect(answered.length).toBeGreaterThanOrEqual(75);
  });

  it.each(["timeline", "status-history", "odometer"])("counts a vehicle's %s", async (list) => {
    const found = await vehicles("pageSize=1");
    const id = (found.body.data as { id: string }[])[0]!.id;
    const res = await request(app)
      .get(`/api/v1/vehicles/${id}/${list}?page=9&pageSize=1`)
      .set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(Number(res.headers["x-total-count"])).toBeGreaterThanOrEqual(0);
  });

  it("counts trips in a period", async () => {
    const res = await request(app)
      .get("/api/v1/telematics/trips")
      .query({
        from: "2026-01-01T00:00:00Z",
        to: "2026-02-01T00:00:00Z",
        page: 9,
        pageSize: 1,
      })
      .set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["x-total-count"]).toBe("0");
  });

  it("counts an account's statement lines", async () => {
    const accounts = await request(app).get("/api/v1/ledger/accounts").set(owner());
    const accountId = (accounts.body.data as { id: string }[])[0]!.id;
    const res = await request(app)
      .get(`/api/v1/reconciliation/lines?accountId=${accountId}&page=9&pageSize=1`)
      .set(owner());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["x-total-count"]).toBe("0");
  });

  it("counts a partner's tenants and applications", async () => {
    const queries = container.get<IPartnerQueries>(TYPES.PartnerQueries);
    const nobody = randomUUID();
    const page = { limit: 1, offset: 8 };
    expect(await queries.tenants(nobody, { ...page, q: "some", status: ["active"] })).toEqual({
      rows: [],
      total: 0,
    });
    expect(await queries.applications(nobody, { ...page, status: "pending_review" })).toEqual({
      rows: [],
      total: 0,
    });
  });
});
