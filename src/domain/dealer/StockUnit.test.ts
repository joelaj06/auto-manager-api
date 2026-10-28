import { describe, expect, it } from "vitest";
import {
  StockRuleError,
  StockUnit,
  ageingBucket,
  commissionOf,
  consignorPayout,
  daysInStock,
  marginOf,
  type StockTerms,
} from "./StockUnit.js";

const now = new Date("2026-10-28T09:00:00Z");
const plain: StockTerms = { holdingCostPerDayMinor: 0, consignment: null, notes: null };

const unit = (status: "incoming" | "reconditioning" | "ready" = "ready") =>
  StockUnit.add({
    vehicleId: "v1",
    source: "purchase",
    status,
    stockedOn: "2026-10-01",
    terms: plain,
    createdBy: "u1",
    now,
  });

describe("StockUnit", () => {
  it("moves from reconditioning to ready, listed and back", () => {
    const u = unit("reconditioning");
    expect(() => u.list("2026-10-02", now)).toThrow("Only a ready vehicle is listed");
    u.markReady(now);
    expect(() => u.list("2026-10-02", now)).toThrow("Set an asking price first");
    u.price(10_000_00, 9_000_00, now);
    u.list("2026-10-02", now);
    expect(u.snapshot()).toMatchObject({ status: "listed", listedOn: "2026-10-02" });
    expect(() => u.recondition(now)).toThrow("Take the vehicle off sale first");
    u.unlist(now);
    expect(u.snapshot()).toMatchObject({ status: "ready", listedOn: null });
  });

  it("keeps the minimum price at or below the asking price and logs what changed", () => {
    const u = unit();
    expect(() => u.price(100, 200, now)).toThrow("The minimum price is above the asking price");
    expect(u.price(500, 400, now)).toEqual({
      askingPriceMinor: 500,
      minimumPriceMinor: 400,
      previousAskingMinor: null,
      previousMinimumMinor: null,
    });
    expect(() => u.price(500, 400, now)).toThrow("The prices are unchanged");
    expect(u.price(450, 400, now).previousAskingMinor).toBe(500);
    u.list("2026-10-03", now);
    expect(() => u.price(null, null, now)).toThrow("A listed vehicle keeps an asking price");
  });

  it("is reserved, released, sold, delivered and returned by a deal", () => {
    const u = unit();
    u.price(500, null, now);
    u.list("2026-10-03", now);
    u.reserve(now);
    expect(() => u.withdraw("No longer for sale", "2026-10-04", now)).toThrow(
      "The vehicle is reserved",
    );
    expect(() => u.assertTransferable()).toThrow(StockRuleError);
    u.release(now);
    expect(u.status).toBe("listed");
    u.reserve(now);
    u.sell("2026-10-05", now);
    expect(u.inStock).toBe(false);
    u.deliver("2026-10-06", now);
    expect(u.snapshot()).toMatchObject({ status: "delivered", soldOn: "2026-10-05" });
    u.returnFromSale(now);
    expect(u.status).toBe("returned");
  });

  it("is withdrawn with a reason and restocked from a new date", () => {
    const u = unit();
    expect(() => u.withdraw("x", "2026-10-04", now)).toThrow("Give a reason");
    u.withdraw("Kept for the fleet", "2026-10-04", now);
    expect(u.snapshot()).toMatchObject({
      status: "withdrawn",
      withdrawReason: "Kept for the fleet",
    });
    expect(() => u.price(100, null, now)).toThrow("The vehicle is withdrawn");
    u.restock({ source: "other", status: "ready", stockedOn: "2026-10-20", terms: plain }, now);
    expect(u.snapshot()).toMatchObject({
      status: "ready",
      stockedOn: "2026-10-20",
      withdrawnOn: null,
      withdrawReason: null,
    });
    expect(() =>
      u.restock({ source: "other", status: "ready", stockedOn: "2026-10-21", terms: plain }, now),
    ).toThrow("already in stock");
  });

  it("needs a consignor and terms exactly for a consignment", () => {
    const add = (source: "consignment" | "trade_in", terms: StockTerms) =>
      StockUnit.add({
        vehicleId: "v2",
        source,
        status: "ready",
        stockedOn: "2026-10-01",
        terms,
        createdBy: null,
        now,
      });
    expect(() => add("consignment", plain)).toThrow("A consignment needs its consignor");
    const consignment = {
      consignorId: "c1",
      terms: "commission" as const,
      payoutMinor: 5,
      commissionRate: null,
    };
    expect(() => add("trade_in", { ...plain, consignment })).toThrow(
      "Only a consignment has a consignor",
    );
    expect(() => add("consignment", { ...plain, consignment })).toThrow("Give the commission rate");
    const u = add("consignment", {
      ...plain,
      consignment: { ...consignment, commissionRate: "10" },
    });
    expect(u.snapshot().consignment).toEqual({
      consignorId: "c1",
      terms: "commission",
      payoutMinor: null,
      commissionRate: "10",
    });
    expect(() =>
      add("consignment", {
        ...plain,
        consignment: { ...consignment, terms: "fixed", payoutMinor: null },
      }),
    ).toThrow("Give the consignor's payout");
  });
});

describe("stock arithmetic", () => {
  it("counts days in stock and buckets them", () => {
    expect(daysInStock("2026-10-01", "2026-10-01")).toBe(0);
    expect(daysInStock("2026-07-01", "2026-10-01")).toBe(92);
    expect([0, 30, 31, 60, 61, 90, 91].map(ageingBucket)).toEqual([
      "days0to30",
      "days0to30",
      "days31to60",
      "days31to60",
      "days61to90",
      "days61to90",
      "over90",
    ]);
  });

  it("works out commission, the consignor's payout and the margin", () => {
    expect(commissionOf(10_000_00, "7.5")).toBe(750_00);
    expect(commissionOf(333, "10")).toBe(33);
    expect(() => commissionOf(100, "101")).toThrow("A commission rate is 0 to 100%");
    expect(
      consignorPayout(
        { consignorId: "c", terms: "commission", payoutMinor: null, commissionRate: "10" },
        50_000_00,
      ),
    ).toBe(45_000_00);
    expect(
      consignorPayout(
        { consignorId: "c", terms: "fixed", payoutMinor: 40_000_00, commissionRate: null },
        50_000_00,
      ),
    ).toBe(40_000_00);
    expect(marginOf(50_000_00, 40_000_00)).toEqual({ marginMinor: 10_000_00, percent: "20.0" });
    expect(marginOf(30_000, 40_000)).toEqual({ marginMinor: -10_000, percent: "-33.3" });
    expect(marginOf(0, 100).percent).toBeNull();
  });
});
