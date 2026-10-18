import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DocumentNumbering } from "../../application/use-cases/reference/DocumentNumbering.js";
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
let tenants: ProvisionedTenants;
let t: ProvisionedTenant;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  admin = await new StaffFixtures(container).create(["super_admin"]);
  tenants = new ProvisionedTenants(container, app, admin);
  t = await tenants.create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("currencies", () => {
  it("publishes the catalogue with per-currency minor units", async () => {
    const res = await api().get("/api/v1/currencies");
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(
      (res.body.data as { code: string; minorUnits: number }[]).map((c) => [c.code, c]),
    );
    expect(byCode.GHS).toMatchObject({ minorUnits: 2, symbol: "₵" });
    expect(byCode.XOF).toMatchObject({ minorUnits: 0 });
  });

  it("defaults the base currency from the country, enables more, and locks the base", async () => {
    const togo = await tenants.create({ country: "TG" });
    const togoSettings = await api()
      .get("/api/v1/settings/currency")
      .set({ Authorization: `Bearer ${togo.ownerAccessToken}` });
    expect(togoSettings.body.data).toMatchObject({
      baseCurrency: "XOF",
      enabledCurrencies: ["XOF"],
    });

    const settings = await api().get("/api/v1/settings/currency").set(owner());
    expect(settings.body.data).toMatchObject({
      baseCurrency: "GHS",
      enabledCurrencies: ["GHS"],
      baseCurrencyLockedAt: null,
    });
    const enabled = await api()
      .patch("/api/v1/settings/currency")
      .set(owner())
      .send({ enabledCurrencies: ["USD"] });
    expect(enabled.body.data.enabledCurrencies).toEqual(["GHS", "USD"]);
    expect(
      (await api().patch("/api/v1/settings/currency").set(owner()).send({ baseCurrency: "XYZ" }))
        .status,
    ).toBe(400);

    // The first financial transaction locks the base currency.
    await t.tenant.query("update organisation set base_currency_locked_at = now()");
    const locked = await api()
      .patch("/api/v1/settings/currency")
      .set(owner())
      .send({ baseCurrency: "USD" });
    expect([locked.status, locked.body.error.code]).toEqual([409, "CURRENCY_BASE_LOCKED"]);
    const config = await api().get(`/api/v1/public/tenant-config?slug=${t.slug}`);
    expect(config.body.data.currency).toEqual({ base: "GHS", symbol: "₵" });
  });
});

describe("tax codes", () => {
  // Example rates for the test only: real rates are entered by each business (decision 100).
  it("needs rates before use, applies the rate in force and works back inclusive prices", async () => {
    const codes = await api().get("/api/v1/tax-codes").set(owner());
    expect(codes.body.data.map((c: { code: string }) => c.code)).toEqual(
      expect.arrayContaining(["VAT", "NHIL", "GETFUND", "WHT"]),
    );
    expect(codes.body.data.every((c: { active: boolean }) => !c.active)).toBe(true);

    const early = await api().post("/api/v1/tax-codes/VAT/activate").set(owner());
    expect([early.status, early.body.error.code]).toEqual([422, "INVALID_TAX_CODE"]);

    const add = (body: Record<string, unknown>) =>
      api().post("/api/v1/tax-codes/VAT/rates").set(owner()).send(body);
    const old = await add({ key: "vat", name: "VAT", rate: "12.5", effectiveFrom: "2020-01-01" });
    expect(old.status, JSON.stringify(old.body)).toBe(200);
    const overlap = await add({ key: "vat", name: "VAT", rate: "15", effectiveFrom: "2025-01-01" });
    expect([overlap.status, overlap.body.error.code]).toEqual([422, "INVALID_TAX_CODE"]);
    const oldId = old.body.data.components[0].id as string;
    await api()
      .post(`/api/v1/tax-codes/VAT/rates/${oldId}/end`)
      .set(owner())
      .send({ effectiveTo: "2025-01-01" })
      .expect(200);
    await add({ key: "vat", name: "VAT", rate: "15", effectiveFrom: "2025-01-01" }).expect(200);
    await api().post("/api/v1/tax-codes/VAT/activate").set(owner()).expect(200);

    const preview = (body: Record<string, unknown>) =>
      api().post("/api/v1/tax-codes/VAT/preview").set(owner()).send(body);
    const now = await preview({ amount: "100", date: "2026-10-18" });
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(now.body.data).toMatchObject({
      net: { amountMinor: 10_000, currency: "GHS", formatted: "₵100.00" },
      tax: { amountMinor: 1_500 },
      gross: { amountMinor: 11_500 },
    });
    expect((await preview({ amount: "100", date: "2024-06-01" })).body.data.tax.amountMinor).toBe(
      1_250,
    );
    const inclusive = await preview({ amount: "115", date: "2026-10-18", inclusive: true });
    expect(inclusive.body.data.net.amountMinor).toBe(10_000);
    const before = await preview({ amount: "100", date: "2019-01-01" });
    expect([before.status, before.body.error.code]).toEqual([409, "TAX_RATES_MISSING"]);
    expect((await preview({ amount: "1.005", date: "2026-10-18" })).body.error.code).toBe(
      "INVALID_AMOUNT",
    );

    const custom = await api()
      .post("/api/v1/tax-codes")
      .set(owner())
      .send({ code: "exempt_rent", name: "Exempt rentals", kind: "exempt", appliesTo: ["sales"] });
    expect(custom.status, JSON.stringify(custom.body)).toBe(201);
    expect(custom.body.data.code).toBe("EXEMPT_RENT");
    await api().post("/api/v1/tax-codes/EXEMPT_RENT/activate").set(owner()).expect(200);

    const settings = await api().put("/api/v1/settings/tax").set(owner()).send({
      scheme: "standard",
      vatNumber: "C0001234567",
      pricesIncludeTax: true,
      defaultSalesTaxCode: "VAT",
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    expect((await preview({ amount: "115", date: "2026-10-18" })).body.data.net.amountMinor).toBe(
      10_000,
    );
    const inactiveDefault = await api().put("/api/v1/settings/tax").set(owner()).send({
      scheme: "standard",
      vatNumber: null,
      pricesIncludeTax: false,
      defaultSalesTaxCode: "NHIL",
    });
    expect(inactiveDefault.status).toBe(422);

    const audit = await t.tenant.query<{ action: string }>(
      "select action from audit_logs where entity_type = 'tax_code' and entity_id = 'VAT' order by id",
    );
    expect(audit.map((a) => a.action)).toEqual([
      "tax_code.rate_added",
      "tax_code.rate_ended",
      "tax_code.rate_added",
      "tax_code.activated",
    ]);
  });
});

describe("exchange rates", () => {
  it("records manual rates and suggests the latest on or before a date", async () => {
    const rate = await api()
      .post("/api/v1/fx-rates")
      .set(owner())
      .send({ quote: "USD", rate: "15.42", rateDate: "2026-10-01" });
    expect(rate.status, JSON.stringify(rate.body)).toBe(201);
    expect(rate.body.data).toMatchObject({ base: "GHS", quote: "USD", rate: "15.42" });
    const duplicate = await api()
      .post("/api/v1/fx-rates")
      .set(owner())
      .send({ quote: "USD", rate: "15.5", rateDate: "2026-10-01" });
    expect([duplicate.status, duplicate.body.error.code]).toEqual([409, "FX_RATE_EXISTS"]);
    const same = await api()
      .post("/api/v1/fx-rates")
      .set(owner())
      .send({ quote: "GHS", rate: "1", rateDate: "2026-10-01" });
    expect(same.body.error.code).toBe("FX_SAME_CURRENCY");

    const suggestion = await api()
      .get("/api/v1/fx-rates/suggestion?quote=USD&date=2026-10-10")
      .set(owner());
    expect(suggestion.body.data).toMatchObject({ rate: "15.42", rateDate: "2026-10-01" });
    const none = await api()
      .get("/api/v1/fx-rates/suggestion?quote=USD&date=2026-09-01")
      .set(owner());
    expect(none.body.data).toBeNull();

    await api().delete(`/api/v1/fx-rates/${rate.body.data.id}`).set(owner()).expect(204);
    expect((await api().get("/api/v1/fx-rates").set(owner())).body.data).toEqual([]);
  });
});

describe("expense categories", () => {
  it("offers seeded defaults as a tree and lets the business add and tidy categories", async () => {
    const tree = await api().get("/api/v1/expense-categories").set(owner());
    const codes = tree.body.data.map((c: { code: string }) => c.code);
    expect(codes).toEqual(expect.arrayContaining(["fuel", "maintenance", "insurance", "other"]));
    const maintenance = tree.body.data.find((c: { code: string }) => c.code === "maintenance");

    const sub = await api()
      .post("/api/v1/expense-categories")
      .set(owner())
      .send({ code: "brake_pads", name: "Brake pads", parentId: maintenance.id });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const deeper = await api()
      .post("/api/v1/expense-categories")
      .set(owner())
      .send({ code: "front_pads", name: "Front pads", parentId: sub.body.data.id });
    expect([deeper.status, deeper.body.error.code]).toEqual([422, "EXPENSE_CATEGORY_RULE"]);
    const duplicate = await api()
      .post("/api/v1/expense-categories")
      .set(owner())
      .send({ code: "fuel", name: "Fuel again" });
    expect(duplicate.status).toBe(422);

    await api()
      .patch(`/api/v1/expense-categories/${sub.body.data.id}`)
      .set(owner())
      .send({ active: false })
      .expect(200);
    const after = await api().get("/api/v1/expense-categories").set(owner());
    const maint = after.body.data.find((c: { code: string }) => c.code === "maintenance");
    expect(maint.children.map((c: { code: string }) => c.code)).not.toContain("brake_pads");
    const all = await api().get("/api/v1/expense-categories?includeInactive=true").set(owner());
    expect(
      all.body.data
        .find((c: { code: string }) => c.code === "maintenance")
        .children.map((c: { code: string }) => c.code),
    ).toContain("brake_pads");
  });
});

describe("vehicle makes and models", () => {
  it("lists makes and models, and staff can add to the list", async () => {
    const makes = await api().get("/api/v1/reference/vehicle-makes?q=toy").set(owner());
    expect(makes.body.data.map((m: { name: string }) => m.name)).toEqual(["Toyota"]);
    const models = await api()
      .get(`/api/v1/reference/vehicle-makes/${makes.body.data[0].id}/models`)
      .set(owner());
    expect(models.body.data.map((m: { name: string }) => m.name)).toEqual(
      expect.arrayContaining(["Corolla", "Hilux", "HiAce"]),
    );

    const staff = { Authorization: `Bearer ${admin.accessToken}` };
    const added = await api()
      .post("/api/platform/v1/reference/vehicle-makes")
      .set(staff)
      .send({ name: "Foton" });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    await api()
      .post(`/api/platform/v1/reference/vehicle-makes/${added.body.data.id}/models`)
      .set(staff)
      .send({ name: "Tunland" })
      .expect(201);
    const again = await api()
      .post("/api/platform/v1/reference/vehicle-makes")
      .set(staff)
      .send({ name: "foton" });
    expect([again.status, again.body.error.code]).toEqual([409, "VEHICLE_CATALOGUE_RULE"]);
    expect(
      (await api().get("/api/v1/reference/vehicle-makes?q=fot").set(owner())).body.data,
    ).toHaveLength(1);
  });
});

describe("document numbering", () => {
  it("numbers documents gap-free with the business's formats", async () => {
    const numbering = container.get<DocumentNumbering>(TYPES.DocumentNumbering);
    const date = new Date("2026-10-18T10:00:00Z");
    const next = (kind: string) => t.tenant.run(() => numbering.next(kind, date));
    expect(await next("invoice")).toBe("INV-2026-000001");
    expect(await next("invoice")).toBe("INV-2026-000002");
    expect(await next("vehicle")).toBe("VEH-00001");

    await api()
      .put("/api/v1/settings/numbering")
      .set(owner())
      .send({ invoice: { prefix: "AFI", padding: 4, yearly: true } })
      .expect(204);
    expect(await next("invoice")).toBe("AFI-2026-0003");
    // A rolled-back document gives its number back.
    await t.tenant
      .run(async () => {
        await numbering.next("receipt", date);
        throw new Error("rollback");
      })
      .catch(() => undefined);
    expect(await next("receipt")).toBe("RCT-2026-000001");
  });
});
