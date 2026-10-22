import { describe, expect, it } from "vitest";
import type { JournalDraft, SystemAccountKey } from "../finance/Journal.js";
import { Postings } from "../finance/Postings.js";
import {
  allocate,
  instalmentStatus,
  penaltiesToCharge,
  position,
  type InstalmentState,
  type PenaltyState,
} from "./WorkPayCollections.js";

const accounts = (key: SystemAccountKey) => `acc:${key}`;
const policy = { graceDays: 3, defaultAfterOverdue: 4, defaultAfterDays: 30 };

/** Weekly instalments of 1,000.00 from 2026-11-02. */
const schedule = (count: number, paid: Record<number, number> = {}): InstalmentState[] =>
  Array.from({ length: count }, (_, k) => ({
    id: `i${k + 1}`,
    number: k + 1,
    dueOn: new Date(Date.UTC(2026, 10, 2 + 7 * k)).toISOString().slice(0, 10),
    amountMinor: 100_000,
    paidMinor: paid[k + 1] ?? 0,
    waivedMinor: 0,
    status: "upcoming",
  }));

const fee = (id: string, instalmentId: string, chargedOn: string, amountMinor: number) =>
  ({ id, instalmentId, chargedOn, amountMinor, paidMinor: 0, waivedMinor: 0 }) as PenaltyState;

const sides = (entry: JournalDraft) => ({
  debits: entry.lines.reduce((sum, l) => sum + l.debitMinor, 0),
  credits: entry.lines.reduce((sum, l) => sum + l.creditMinor, 0),
});

describe("instalment status", () => {
  const i = schedule(1)[0]!; // due 2026-11-02, overdue from 2026-11-06
  it("follows the due date, the grace days and what was paid", () => {
    expect(instalmentStatus(i, "2026-11-01", 3)).toBe("upcoming");
    expect(instalmentStatus(i, "2026-11-02", 3)).toBe("due");
    expect(instalmentStatus({ ...i, paidMinor: 40_000 }, "2026-11-05", 3)).toBe("partially_paid");
    expect(instalmentStatus({ ...i, paidMinor: 40_000 }, "2026-11-06", 3)).toBe("overdue");
    expect(instalmentStatus({ ...i, paidMinor: 100_000 }, "2026-12-01", 3)).toBe("paid");
    expect(instalmentStatus({ ...i, waivedMinor: 100_000 }, "2026-12-01", 3)).toBe("waived");
    expect(
      instalmentStatus({ ...i, paidMinor: 60_000, waivedMinor: 40_000 }, "2026-12-01", 3),
    ).toBe("paid");
  });
});

describe("allocation", () => {
  it("pays late fees first, then the oldest instalments, then future ones in advance", () => {
    const instalments = schedule(4, { 1: 50_000 });
    const penalties = [fee("p2", "i1", "2026-11-07", 2_000), fee("p1", "i1", "2026-11-06", 2_000)];
    const split = allocate(255_000, instalments, penalties);
    expect(split.lines).toEqual([
      { kind: "penalty", id: "p1", amountMinor: 2_000 },
      { kind: "penalty", id: "p2", amountMinor: 2_000 },
      { kind: "instalment", id: "i1", amountMinor: 50_000 },
      { kind: "instalment", id: "i2", amountMinor: 100_000 },
      { kind: "instalment", id: "i3", amountMinor: 100_000 },
      { kind: "instalment", id: "i4", amountMinor: 1_000 },
    ]);
    expect(split).toMatchObject({
      penaltiesMinor: 4_000,
      instalmentsMinor: 251_000,
      unallocatedMinor: 0,
    });
  });

  it("leaves what nothing needs unallocated and refuses nothing", () => {
    expect(allocate(500_000, schedule(2), []).unallocatedMinor).toBe(300_000);
    expect(() => allocate(0, schedule(2), [])).toThrow(/above zero/);
  });
});

describe("late fees", () => {
  const instalments = schedule(2); // overdue from 2026-11-06 and 2026-11-13

  it("charge nothing within the grace days or without a rule", () => {
    expect(
      penaltiesToCharge(instalments, [], { kind: "flat", amountMinor: 5_000 }, "2026-11-05", 3),
    ).toEqual([]);
    expect(penaltiesToCharge(instalments, [], { kind: "none" }, "2026-12-31", 3)).toEqual([]);
  });

  it("charge a flat fee or a percentage once, on the first overdue day", () => {
    expect(
      penaltiesToCharge(instalments, [], { kind: "flat", amountMinor: 5_000 }, "2026-11-14", 3),
    ).toEqual([
      { instalmentId: "i1", chargedOn: "2026-11-06", amountMinor: 5_000 },
      { instalmentId: "i2", chargedOn: "2026-11-13", amountMinor: 5_000 },
    ]);
    const partly = [{ ...instalments[0]!, paidMinor: 40_000 }];
    expect(
      penaltiesToCharge(partly, [], { kind: "percent", percent: "5" }, "2026-11-06", 3),
    ).toEqual([{ instalmentId: "i1", chargedOn: "2026-11-06", amountMinor: 3_000 }]);
    const charged = [fee("p1", "i1", "2026-11-06", 3_000)];
    expect(
      penaltiesToCharge(partly, charged, { kind: "percent", percent: "5" }, "2026-11-20", 3),
    ).toEqual([]);
  });

  it("charge a daily fee for every overdue day, catching up missed days, up to the cap", () => {
    const rule = { kind: "daily", amountMinor: 1_000, capMinor: 2_500 } as const;
    const one = [instalments[0]!];
    const existing = [fee("p1", "i1", "2026-11-06", 1_000)];
    expect(penaltiesToCharge(one, existing, rule, "2026-11-09", 3)).toEqual([
      { instalmentId: "i1", chargedOn: "2026-11-07", amountMinor: 1_000 },
      { instalmentId: "i1", chargedOn: "2026-11-08", amountMinor: 500 },
    ]);
    expect(
      penaltiesToCharge(one, existing, { ...rule, capMinor: null }, "2026-11-08", 3),
    ).toHaveLength(2);
  });

  it("stop once the instalment is paid", () => {
    const paid = [{ ...instalments[0]!, paidMinor: 100_000 }];
    expect(
      penaltiesToCharge(paid, [], { kind: "flat", amountMinor: 5_000 }, "2026-11-20", 3),
    ).toEqual([]);
  });
});

describe("agreement position", () => {
  it("is active while nothing is overdue, with the next instalment", () => {
    const p = position(schedule(3, { 1: 100_000 }), [], "2026-11-10", policy);
    expect(p).toMatchObject({
      status: "active",
      outstandingMinor: 200_000,
      overdueCount: 0,
      arrearsSince: null,
      nextDue: { number: 2, dueOn: "2026-11-09", outstandingMinor: 100_000 },
    });
  });

  it("is in arrears from the first overdue day, defaulted past the limits", () => {
    expect(position(schedule(3), [], "2026-11-06", policy)).toMatchObject({
      status: "in_arrears",
      overdueCount: 1,
      overdueMinor: 100_000,
      arrearsSince: "2026-11-06",
    });
    // 30 days after 2026-11-06 → defaulted on days.
    expect(
      position(schedule(3), [], "2026-12-06", { ...policy, defaultAfterOverdue: 10 }).status,
    ).toBe("defaulted");
    // Four instalments overdue → defaulted on count.
    expect(position(schedule(6), [], "2026-11-27", policy)).toMatchObject({
      status: "defaulted",
      overdueCount: 4,
    });
  });

  it("is completed once every instalment and late fee is settled", () => {
    const paid = schedule(2, { 1: 100_000, 2: 100_000 });
    expect(position(paid, [], "2026-12-31", policy).status).toBe("completed");
    const owing = [fee("p1", "i1", "2026-11-06", 5_000)];
    expect(position(paid, owing, "2026-12-31", policy)).toMatchObject({
      status: "active",
      penaltiesOutstandingMinor: 5_000,
      nextDue: null,
    });
  });
});

describe("work and pay postings", () => {
  const a = { id: "a1", number: "WP-2026-000001", driverId: "d1", vehicleId: "v1", branchId: "b1" };

  it("book the price as receivable and the deposit as earned at the start", () => {
    const entry = Postings.workpayStarted(
      a,
      { priceMinor: 9_000_000, depositMinor: 1_000_000, date: "2026-11-01" },
      accounts,
    );
    expect(sides(entry)).toEqual({ debits: 11_000_000, credits: 11_000_000 });
    const on = (account: string) =>
      entry.lines
        .filter((l) => l.accountId === `acc:${account}`)
        .reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
    expect(on("workpay_receivables")).toBe(8_000_000);
    expect(on("workpay_unearned")).toBe(-8_000_000);
    expect(on("workpay_income")).toBe(-1_000_000);
    expect(on("party_credit")).toBe(1_000_000);
  });

  it("move a collection off the receivable and earn the instalment part", () => {
    const entry = Postings.workpayCollected(
      a,
      { paymentId: "pay1", instalmentsMinor: 100_000, penaltiesMinor: 5_000, date: "2026-11-02" },
      accounts,
    )!;
    expect(entry.source).toEqual({ type: "workpay_payment", id: "pay1" });
    expect(sides(entry)).toEqual({ debits: 205_000, credits: 205_000 });
    expect(
      Postings.workpayCollected(
        a,
        { paymentId: "pay1", instalmentsMinor: 0, penaltiesMinor: 0, date: "2026-11-02" },
        accounts,
      ),
    ).toBeNull();
  });

  it("charge and waive late fees and instalments against the receivable", () => {
    const charged = Postings.workpayPenaltyCharged(
      a,
      { penaltyId: "p1", amountMinor: 5_000, date: "2026-11-06" },
      accounts,
    );
    expect(sides(charged)).toEqual({ debits: 5_000, credits: 5_000 });
    const waived = Postings.workpayWaived(
      a,
      { waiverId: "w1", kind: "penalty", amountMinor: 5_000, date: "2026-11-07" },
      accounts,
    );
    expect(waived.lines.find((l) => l.debitMinor > 0)!.accountId).toBe("acc:workpay_penalties");
    const instalment = Postings.workpayWaived(
      a,
      { waiverId: "w2", kind: "instalment", amountMinor: 100_000, date: "2026-11-07" },
      accounts,
    );
    expect(instalment.lines.find((l) => l.debitMinor > 0)!.accountId).toBe("acc:workpay_unearned");
  });
});
