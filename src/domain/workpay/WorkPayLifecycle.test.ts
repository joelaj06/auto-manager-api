import { describe, expect, it } from "vitest";
import type { JournalDraft, SystemAccountKey } from "../finance/Journal.js";
import { Postings } from "../finance/Postings.js";
import { manualNextStatuses, nextStatuses } from "../vehicles/VehicleStatus.js";
import {
  allocate,
  instalmentStatus,
  position,
  type ChargeState,
  type InstalmentState,
} from "./WorkPayCollections.js";
import {
  holidayPeriodsFor,
  holidayPlan,
  restructurePlan,
  settlementFigures,
  splitAmount,
  suggestedRefund,
} from "./WorkPayLifecycle.js";

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
    rescheduledMinor: 0,
    status: "upcoming",
  }));

const charge = (id: string, amountMinor: number): ChargeState => ({
  id,
  chargedOn: "2026-11-03",
  description: "Expense EXP-1: tyres",
  amountMinor,
  paidMinor: 0,
  waivedMinor: 0,
});

const balanced = (entry: JournalDraft) => {
  const d = entry.lines.reduce((sum, l) => sum + l.debitMinor, 0);
  const c = entry.lines.reduce((sum, l) => sum + l.creditMinor, 0);
  return d === c ? d : NaN;
};

describe("splitting an amount", () => {
  it("rounds down and puts the remainder on the last instalment", () => {
    expect(splitAmount(100_050, 3, 100)).toEqual([33_300, 33_300, 33_450]);
    expect(() => splitAmount(100, 3, 100)).toThrow(/zero/);
    expect(() => splitAmount(100, 0, 1)).toThrow(/1 to 2000/);
  });
});

describe("payment holiday", () => {
  it("moves what is left of the instalments due from the date, some periods later", () => {
    const instalments = schedule(4, { 2: 40_000 });
    const plan = holidayPlan(instalments, {
      from: "2026-11-09",
      periods: 2,
      frequency: "weekly",
      daysOff: [],
    });
    expect(plan.moves).toEqual([
      { id: "i2", rescheduledMinor: 60_000 },
      { id: "i3", rescheduledMinor: 100_000 },
      { id: "i4", rescheduledMinor: 100_000 },
    ]);
    expect(plan.creates).toEqual([
      { number: 5, dueOn: "2026-11-23", amountMinor: 60_000 },
      { number: 6, dueOn: "2026-11-30", amountMinor: 100_000 },
      { number: 7, dueOn: "2026-12-07", amountMinor: 100_000 },
    ]);
  });

  it("skips days off on a daily schedule and refuses a holiday with nothing to move", () => {
    const daily: InstalmentState[] = [
      { ...schedule(1)[0]!, dueOn: "2026-11-06" }, // a Friday
    ];
    const plan = holidayPlan(daily, {
      from: "2026-11-06",
      periods: 1,
      frequency: "daily",
      daysOff: [0],
    });
    expect(plan.creates[0]!.dueOn).toBe("2026-11-07");
    const sunday = holidayPlan(daily, {
      from: "2026-11-06",
      periods: 2,
      frequency: "daily",
      daysOff: [0],
    });
    expect(sunday.creates[0]!.dueOn).toBe("2026-11-09");
    expect(() =>
      holidayPlan(schedule(1, { 1: 100_000 }), {
        from: "2026-11-01",
        periods: 1,
        frequency: "weekly",
        daysOff: [],
      }),
    ).toThrow(/No instalment/);
  });
});

describe("restructure", () => {
  it("spreads arrears and the rest over a new schedule", () => {
    const instalments = schedule(3, { 1: 30_000 });
    const plan = restructurePlan(instalments, {
      frequency: "monthly",
      periods: 4,
      firstDueOn: "2026-12-31",
      daysOff: [],
      roundToMinor: 100,
      today: "2026-11-20",
    });
    expect(plan.moves.reduce((sum, m) => sum + m.rescheduledMinor, 0)).toBe(270_000);
    expect(plan.creates).toEqual([
      { number: 4, dueOn: "2026-12-31", amountMinor: 67_500 },
      { number: 5, dueOn: "2027-01-31", amountMinor: 67_500 },
      { number: 6, dueOn: "2027-02-28", amountMinor: 67_500 },
      { number: 7, dueOn: "2027-03-31", amountMinor: 67_500 },
    ]);
  });

  it("starts today or later", () => {
    expect(() =>
      restructurePlan(schedule(2), {
        frequency: "weekly",
        periods: 2,
        firstDueOn: "2026-11-01",
        daysOff: [],
        roundToMinor: 1,
        today: "2026-11-02",
      }),
    ).toThrow(/today or later/);
  });

  it("leaves the old rows rescheduled and the agreement up to date", () => {
    const moved = schedule(2).map((i) => ({ ...i, rescheduledMinor: i.amountMinor }));
    expect(instalmentStatus(moved[0]!, "2026-12-31", 3)).toBe("rescheduled");
    const partly = { ...moved[0]!, paidMinor: 20_000, rescheduledMinor: 80_000 };
    expect(instalmentStatus(partly, "2026-12-31", 3)).toBe("rescheduled");
    const fresh = { ...schedule(1)[0]!, id: "i9", number: 9, dueOn: "2027-01-04" };
    expect(position([...moved, fresh], [], "2026-12-31", policy)).toMatchObject({
      status: "active",
      overdueCount: 0,
      outstandingMinor: 100_000,
      nextDue: { number: 9 },
    });
  });
});

describe("charges on the agreement", () => {
  it("are paid after late fees and before instalments, and keep it open until paid", () => {
    const split = allocate(150_000, schedule(2), [], [charge("c1", 20_000)]);
    expect(split.lines.map((l) => [l.kind, l.amountMinor])).toEqual([
      ["charge", 20_000],
      ["instalment", 100_000],
      ["instalment", 30_000],
    ]);
    expect(split.chargesMinor).toBe(20_000);
    const paid = schedule(1, { 1: 100_000 });
    expect(position(paid, [], "2026-12-31", policy, [charge("c1", 5_000)]).status).toBe("active");
  });
});

describe("early settlement", () => {
  it("quotes what is left less a share of the markup still in it, plus fees and charges", () => {
    const f = settlementFigures(
      schedule(4, { 1: 100_000 }),
      [
        {
          id: "p1",
          instalmentId: "i2",
          chargedOn: "2026-11-13",
          amountMinor: 5_000,
          paidMinor: 0,
          waivedMinor: 0,
        },
      ],
      [charge("c1", 20_000)],
      { totalPriceMinor: 400_000, markupMinor: 200_000 },
      "50",
    );
    expect(f).toEqual({
      instalmentsMinor: 300_000,
      penaltiesMinor: 5_000,
      chargesMinor: 20_000,
      markupMinor: 150_000,
      discountMinor: 75_000,
      payoffMinor: 250_000,
    });
    expect(() =>
      settlementFigures(schedule(1), [], [], { totalPriceMinor: 1, markupMinor: 0 }, "101"),
    ).toThrow(/0 to 100/);
    expect(suggestedRefund(300_000, "10")).toBe(30_000);
  });
});

describe("downtime", () => {
  it("suggests the whole periods the vehicle was off the road", () => {
    expect(holidayPeriodsFor("2026-11-02", "2026-11-18", "weekly", [])).toBe(2);
    expect(holidayPeriodsFor("2026-11-02", "2026-11-05", "weekly", [])).toBe(0);
    expect(holidayPeriodsFor("2026-11-06", "2026-11-10", "daily", [0])).toBe(3);
    expect(holidayPeriodsFor("2026-11-01", "2027-01-05", "monthly", [])).toBe(2);
  });
});

describe("vehicle statuses on work and pay", () => {
  it("go off the road and back, or are repossessed, only through the agreement", () => {
    expect(nextStatuses("on_workpay")).toContain("in_maintenance");
    expect(nextStatuses("in_maintenance")).toEqual(
      expect.arrayContaining(["on_workpay", "repossessed"]),
    );
    expect(nextStatuses("accident")).toContain("on_workpay");
    expect(manualNextStatuses("on_workpay")).toEqual(["accident", "impounded", "stolen"]);
    expect(manualNextStatuses("in_maintenance")).not.toContain("on_workpay");
    // Back in stock: a repossessed vehicle is moved on by hand.
    expect(manualNextStatuses("repossessed")).toEqual(
      expect.arrayContaining(["reconditioning", "available", "for_sale"]),
    );
  });
});

describe("lifecycle postings", () => {
  const a = { id: "a1", number: "WP-2026-000001", driverId: "d1", vehicleId: "v1", branchId: "b1" };

  it("write off what is left on termination, charges back to the driver ledger", () => {
    const entry = Postings.workpayClosed(
      a,
      {
        kind: "terminated",
        instalmentsMinor: 300_000,
        penaltiesMinor: 5_000,
        chargesMinor: 20_000,
        owedMinor: 50_000,
        refundMinor: 0,
        date: "2026-12-01",
      },
      accounts,
    )!;
    expect(balanced(entry)).toBe(375_000);
    const net = (account: string) =>
      entry.lines
        .filter((l) => l.accountId === `acc:${account}`)
        .reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
    expect(net("workpay_receivables")).toBe(-325_000);
    expect(net("driver_receivables")).toBe(70_000);
    expect(net("workpay_income")).toBe(-50_000);
    expect(
      Postings.workpayClosed(
        a,
        {
          kind: "repossessed",
          instalmentsMinor: 0,
          penaltiesMinor: 0,
          chargesMinor: 0,
          owedMinor: 0,
          refundMinor: 0,
          date: "2026-12-01",
        },
        accounts,
      ),
    ).toBeNull();
  });

  it("move a charge into the agreement and back, and book a settlement discount", () => {
    const added = Postings.workpayCharge(
      a,
      {
        chargeId: "c1",
        direction: "added",
        amountMinor: 20_000,
        description: "Tyres",
        date: "2026-11-03",
      },
      accounts,
    );
    expect(added.lines.find((l) => l.debitMinor > 0)!.accountId).toBe("acc:workpay_receivables");
    const cancelled = Postings.workpayCharge(
      a,
      {
        chargeId: "c1",
        direction: "cancelled",
        amountMinor: 20_000,
        description: "Tyres",
        date: "2026-11-04",
      },
      accounts,
    );
    expect(cancelled.source).toEqual({ type: "workpay_charge_cancel", id: "c1" });
    expect(cancelled.lines.find((l) => l.debitMinor > 0)!.accountId).toBe("acc:driver_receivables");
    const discount = Postings.workpaySettlementDiscount(
      a,
      { quoteId: "q1", amountMinor: 75_000, date: "2026-12-01" },
      accounts,
    )!;
    expect(discount.source).toEqual({ type: "workpay_settlement", id: "q1" });
    expect(balanced(discount)).toBe(75_000);
  });
});
