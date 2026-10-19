import { describe, expect, it } from "vitest";
import type { SystemAccountKey } from "../finance/Journal.js";
import { Postings } from "../finance/Postings.js";
import { ageShortfalls, Remittance, targetPeriods } from "./Remittance.js";

const now = new Date("2026-10-19T09:00:00Z");
const accounts = (key: SystemAccountKey) => `acc:${key}`;
const expected = (expectedMinor = 25_000) =>
  Remittance.expected({
    id: "r1",
    assignmentId: "a1",
    driverId: "d1",
    vehicleId: "v1",
    branchId: "b1",
    periodStart: "2026-10-12",
    periodEnd: "2026-10-12",
    expectedMinor,
    now,
  });

describe("target periods", () => {
  it("are working days for a daily target (Sunday off)", () => {
    // 2026-10-17 is a Saturday, 2026-10-18 a Sunday.
    expect(
      targetPeriods(
        { frequency: "daily", daysOff: [0] },
        "2026-10-16",
        null,
        "2026-10-16",
        "2026-10-19",
      ).map((p) => p.start),
    ).toEqual(["2026-10-16", "2026-10-17", "2026-10-19"]);
  });

  it("are anchored on the assignment's first day for weekly and monthly targets", () => {
    expect(
      targetPeriods(
        { frequency: "weekly", daysOff: [] },
        "2026-10-01",
        null,
        "2026-10-01",
        "2026-10-19",
      ),
    ).toEqual([
      { start: "2026-10-01", end: "2026-10-07" },
      { start: "2026-10-08", end: "2026-10-14" },
      { start: "2026-10-15", end: "2026-10-21" },
    ]);
    expect(
      targetPeriods(
        { frequency: "monthly", daysOff: [] },
        "2026-01-31",
        null,
        "2026-02-01",
        "2026-03-31",
      ),
    ).toEqual([
      { start: "2026-02-28", end: "2026-03-30" },
      { start: "2026-03-31", end: "2026-04-29" },
    ]);
  });

  it("stop at the assignment's last day", () => {
    expect(
      targetPeriods(
        { frequency: "weekly", daysOff: [] },
        "2026-10-01",
        "2026-10-10",
        "2026-10-08",
        "2026-10-19",
      ),
    ).toEqual([{ start: "2026-10-08", end: "2026-10-10" }]);
  });
});

describe("Remittance", () => {
  it("accrues the target once, settles payments and keeps the excess as credit", () => {
    const r = expected();
    expect(r.accrueTarget(now)).toBe(25_000);
    expect(r.accrueTarget(now)).toBe(0);
    expect(r.receive(20_000, now)).toEqual({ settled: 20_000, income: 0 });
    r.refresh("2026-10-12", 1, false, now);
    expect([r.snapshot().status, r.outstandingMinor]).toEqual(["partially_paid", 5_000]);
    expect(r.receive(8_000, now)).toEqual({ settled: 5_000, income: 0 });
    r.refresh("2026-10-19", 1, false, now);
    expect(r.snapshot().status).toBe("paid");
  });

  it("goes overdue after the grace days and can be waived", () => {
    const r = expected();
    r.refresh("2026-10-13", 1, false, now);
    expect(r.snapshot().status).toBe("pending");
    expect(r.isDue("2026-10-14", 1)).toBe(true);
    r.refresh("2026-10-14", 1, false, now);
    expect(r.snapshot().status).toBe("overdue");
    r.refresh("2026-10-14", 1, true, now);
    expect(r.snapshot().status).toBe("submitted");
    r.accrueTarget(now);
    expect(() => r.waive(30_000, "Sick", now)).toThrow(/at most/);
    expect(r.waive(null, "Sick day", now)).toBe(25_000);
    r.refresh("2026-10-19", 1, false, now);
    expect(r.snapshot().status).toBe("waived");
  });

  it("treats a variable period's money as its income", () => {
    const r = Remittance.variable({
      id: "r2",
      assignmentId: "a1",
      driverId: "d1",
      vehicleId: "v1",
      branchId: "b1",
      periodStart: "2026-10-18",
      periodEnd: "2026-10-18",
      now,
    });
    expect(r.receive(31_000, now)).toEqual({ settled: 31_000, income: 31_000 });
    const entry = Postings.remittanceSettled(
      r,
      { paymentId: "p1", settled: 31_000, income: 31_000, date: "2026-10-19" },
      accounts,
    )!;
    expect(entry.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["acc:driver_receivables", 31_000, 0],
      ["acc:remittance_income", 0, 31_000],
      ["acc:party_credit", 31_000, 0],
      ["acc:driver_receivables", 0, 31_000],
    ]);
  });

  it("ages shortfalls by how long ago the period ended", () => {
    expect(
      ageShortfalls(
        [
          { periodEnd: "2026-10-15", outstandingMinor: 100 },
          { periodEnd: "2026-10-01", outstandingMinor: 200 },
          { periodEnd: "2026-08-01", outstandingMinor: 300 },
        ],
        "2026-10-19",
      ),
    ).toEqual({ days0to7: 100, days8to30: 200, over30: 300 });
  });
});
