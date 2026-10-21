import { describe, expect, it } from "vitest";
import { WorkPayAgreement } from "./WorkPayAgreement.js";
import { dueDates, workPayTerms } from "./WorkPayTerms.js";

const weekly = (overrides: Partial<Parameters<typeof workPayTerms>[0]> = {}) =>
  workPayTerms({
    vehicleValueMinor: 6_000_000,
    pricing: { kind: "multiplier", multiplier: "2" },
    depositMinor: 0,
    frequency: "weekly",
    periods: 156,
    firstDueOn: "2026-11-02",
    ...overrides,
  });

describe("work and pay terms", () => {
  it("put the rounding remainder on the last instalment (docs/08 §3 example)", () => {
    const t = weekly();
    expect([t.totalPriceMinor, t.financedMinor, t.instalmentMinor, t.lastInstalmentMinor]).toEqual([
      12_000_000, 12_000_000, 76_923, 76_935,
    ]);
    expect(t.schedule.reduce((sum, i) => sum + i.amountMinor, 0)).toBe(12_000_000);
    expect(t.schedule[155]).toEqual({ number: 156, dueOn: t.lastDueOn, amountMinor: 76_935 });
  });

  it("round instalments to whole cedis when asked", () => {
    const t = weekly({ roundToMinor: 100 });
    expect([t.instalmentMinor, t.lastInstalmentMinor]).toEqual([76_900, 80_500]);
  });

  it("price by multiplier, markup or total, less the deposit", () => {
    expect(weekly({ depositMinor: 1_000_000 }).financedMinor).toBe(11_000_000);
    const markup = weekly({ pricing: { kind: "markup_percent", percent: "62.5" }, periods: 10 });
    expect([markup.totalPriceMinor, markup.markupMinor]).toEqual([9_750_000, 3_750_000]);
    expect(weekly({ pricing: { kind: "total", totalMinor: 9_000_000 } }).markupMinor).toBe(
      3_000_000,
    );
    expect(weekly({ pricing: { kind: "multiplier", multiplier: "1.755" } }).totalPriceMinor).toBe(
      10_530_000,
    );
  });

  it("turn months into instalments", () => {
    expect(weekly({ periods: undefined, months: 36 }).periods).toBe(156);
    expect(weekly({ frequency: "monthly", periods: undefined, months: 24 }).periods).toBe(24);
    // November 2026 has 30 days, 4 Sundays from the 2nd.
    expect(
      weekly({ frequency: "daily", periods: undefined, months: 1, daysOff: [0] }).periods,
    ).toBe(26);
  });

  it("fall on working days, every week, or the same day each month", () => {
    // 2026-11-07 is a Saturday, 2026-11-08 a Sunday.
    expect(dueDates("2026-11-07", "daily", 3, [0])).toEqual([
      "2026-11-07",
      "2026-11-09",
      "2026-11-10",
    ]);
    expect(dueDates("2027-01-31", "monthly", 3, [])).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
    expect(dueDates("2026-12-28", "weekly", 2, [])).toEqual(["2026-12-28", "2027-01-04"]);
  });

  it("refuse terms that cannot work", () => {
    expect(() => weekly({ depositMinor: 12_000_000 })).toThrow(/less than the price/);
    expect(() => weekly({ months: 12 })).toThrow(/either/);
    expect(() => weekly({ pricing: { kind: "multiplier", multiplier: "0.5" } })).toThrow(
      /between 1 and 10/,
    );
    expect(() => weekly({ periods: 3, vehicleValueMinor: 1, roundToMinor: 100 })).toThrow(/zero/);
    expect(() => weekly({ frequency: "daily", daysOff: [0, 1, 2, 3, 4, 5, 6] })).toThrow(
      /working day/,
    );
  });
});

describe("work and pay agreements", () => {
  const now = new Date("2026-10-21T09:00:00Z");
  const draft = () =>
    WorkPayAgreement.draft({
      id: "a1",
      number: "WP-2026-000001",
      vehicleId: "v1",
      driverId: "d1",
      branchId: "b1",
      terms: weekly({ depositMinor: 500_000 }),
      graceDays: 3,
      maintenance: "driver",
      insurance: "owner",
      guarantors: [
        {
          name: "Yaw",
          phone: "+233201112222",
          ghanaCardNumber: null,
          relationship: null,
          address: null,
          signs: true,
        },
      ],
      notes: null,
      createdBy: "u1",
      now,
    });
  const activate = (a: WorkPayAgreement, today = "2026-10-25") =>
    a.activate({ assignmentId: "as1", today, userId: "u1", requireDeposit: true, now });

  it("freeze their terms while out for signature, until withdrawn", () => {
    const a = draft();
    a.sentForSignature("doc1", now);
    expect(() => a.revise({ graceDays: 5 }, now)).toThrow(/withdraw it/);
    expect(a.withdraw(now)).toBe("doc1");
    a.revise({ graceDays: 5 }, now);
    expect(a.snapshot()).toMatchObject({ status: "draft", graceDays: 5, documentId: null });
  });

  it("start once signed, with the deposit paid, before the first instalment", () => {
    const a = draft();
    a.sentForSignature("doc1", now);
    expect(() => activate(a)).toThrow(/deposit has not been paid/);
    expect(() => a.depositReceived(600_000, now)).toThrow(/more than the deposit/);
    a.depositReceived(500_000, now);
    expect(() => activate(a, "2026-11-03")).toThrow(/first instalment date has passed/);
    activate(a);
    expect(a.snapshot()).toMatchObject({
      status: "active",
      startedOn: "2026-10-25",
      assignmentId: "as1",
    });
    expect(() => a.cancel("Changed mind", now)).toThrow(/not started/);
  });

  it("check guarantors and grace", () => {
    expect(() =>
      draft().revise(
        {
          guarantors: [
            {
              name: "Yaw",
              phone: "0201112222",
              ghanaCardNumber: null,
              relationship: null,
              address: null,
              signs: false,
            },
          ],
        },
        now,
      ),
    ).toThrow(/\+233/);
    expect(() => draft().revise({ graceDays: 90 }, now)).toThrow(/0 to 60/);
  });
});
