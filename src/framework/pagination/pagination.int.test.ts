import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totalsHeaderNames } from "../../adapters/presenters/pageHeaders.js";
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
    let moneyLists = 0;
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
      if (route.totals !== undefined) {
        moneyLists += 1;
        expect(res.headers["x-currency"], where).toMatch(/^[A-Z]{3}$/);
        for (const name of totalsHeaderNames(route.totals).slice(1))
          expect(res.headers[name.toLowerCase()], `${where} ${name}`).toMatch(/^-?\d+$/);
      }
    }
    // Lists of someone else (a driver, a partner) or of one record are covered below.
    expect(paged().length).toBeGreaterThanOrEqual(88);
    expect(answered.length).toBeGreaterThanOrEqual(75);
    expect(moneyLists).toBeGreaterThanOrEqual(25);
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

describe("money totals", () => {
  const expenses = (query: string) => request(app).get(`/api/v1/expenses?${query}`).set(owner());

  it("adds up the whole filtered list in the base currency, by status", async () => {
    const tree = await request(app).get("/api/v1/expense-categories").set(owner());
    const categoryId = (tree.body.data as { code: string; id: string }[]).find(
      (c) => c.code === "insurance",
    )!.id;
    const supplier = await request(app)
      .post("/api/v1/suppliers")
      .set(owner())
      .send({ name: "Totals Motors", type: "parts" });
    await request(app)
      .patch("/api/v1/settings/currency")
      .set(owner())
      .send({ enabledCurrencies: ["USD"] })
      .expect(200);
    await request(app)
      .post("/api/v1/fx-rates")
      .set(owner())
      .send({ quote: "USD", rate: "15", rateDate: new Date().toISOString().slice(0, 10) })
      .expect(201);
    const create = async (amount: string, currency?: string) => {
      const res = await request(app)
        .post("/api/v1/expenses")
        .set(owner())
        .send({
          categoryId,
          description: "Cover",
          payeeType: "supplier",
          payeeId: supplier.body.data.id,
          amount,
          ...(currency === undefined ? {} : { currency }),
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.expense.id as string;
    };
    await create("100.00");
    await create("10.00", "USD");
    const submitted = await create("50.00");
    await request(app).post(`/api/v1/expenses/${submitted}/submit`).set(owner()).expect(200);

    const all = await expenses("pageSize=1");
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.data).toHaveLength(1);
    expect(all.headers).toMatchObject({
      "x-total-count": "3",
      "x-currency": "GHS",
      // 100.00 + 50.00 cedis and 10.00 dollars at 15
      "x-total-amount": "30000",
      "x-total-draft": "25000",
      "x-total-submitted": "5000",
      "x-total-approved": "0",
      "x-total-paid": "0",
      "x-total-void": "0",
      "x-total-amount-net": "30000",
      "x-total-amount-tax": "0",
    });

    const some = await expenses("status=submitted&page=5");
    expect(some.body.data).toEqual([]);
    expect(some.headers).toMatchObject({
      "x-total-count": "1",
      "x-total-amount": "5000",
      "x-total-draft": "0",
      "x-total-submitted": "5000",
    });
  });

  it("documents each list's totals", async () => {
    const doc = await request(app).get("/api/v1/openapi.json");
    expect(doc.status).toBe(200);
    const headers = doc.body.paths["/api/v1/expenses"].get.responses["200"].headers;
    expect(Object.keys(headers)).toEqual(
      expect.arrayContaining([
        "X-Total-Count",
        "X-Currency",
        "X-Total-Amount",
        "X-Total-Submitted",
      ]),
    );
  });
});
