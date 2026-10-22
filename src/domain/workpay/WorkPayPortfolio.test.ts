import { describe, expect, it } from "vitest";
import { ruleConfig, RULES } from "../notifications/NotificationRules.js";
import {
  collectionRate,
  daysInArrears,
  forecast,
  portfolioAtRisk,
  portfolioSummary,
  type PortfolioAgreement,
} from "./WorkPayPortfolio.js";

const agreement = (overrides: Partial<PortfolioAgreement>): PortfolioAgreement => ({
  status: "active",
  instalmentsMinor: 1_000_000,
  paidMinor: 0,
  outstandingMinor: 1_000_000,
  overdueMinor: 0,
  penaltiesOutstandingMinor: 0,
  chargesOutstandingMinor: 0,
  arrearsSince: null,
  ...overrides,
});

describe("work and pay portfolio", () => {
  const rows = [
    agreement({ paidMinor: 400_000, outstandingMinor: 600_000 }),
    agreement({
      status: "in_arrears",
      paidMinor: 100_000,
      outstandingMinor: 900_000,
      overdueMinor: 100_000,
      penaltiesOutstandingMinor: 5_000,
      arrearsSince: "2026-11-20",
    }),
    agreement({
      status: "defaulted",
      outstandingMinor: 500_000,
      overdueMinor: 500_000,
      arrearsSince: "2026-09-01",
    }),
    agreement({ status: "completed", paidMinor: 1_000_000, outstandingMinor: 0 }),
  ];

  it("sums the running portfolio and what was collected", () => {
    expect(portfolioSummary(rows)).toEqual({
      byStatus: { active: 1, in_arrears: 1, defaulted: 1, completed: 1 },
      running: 3,
      financedMinor: 4_000_000,
      collectedMinor: 1_500_000,
      outstandingMinor: 2_000_000,
      overdueMinor: 600_000,
      penaltiesOutstandingMinor: 5_000,
      chargesOutstandingMinor: 0,
      completionPercent: 37.5,
    });
    expect(portfolioSummary([]).completionPercent).toBeNull();
  });

  it("puts agreements at risk by days in arrears", () => {
    expect(daysInArrears("2026-11-20", "2026-12-01")).toBe(12);
    expect(daysInArrears(null, "2026-12-01")).toBe(0);
    expect(portfolioAtRisk(rows, "2026-12-01")).toEqual([
      { days: 7, agreements: 2, outstandingMinor: 1_400_000, percent: 70 },
      { days: 30, agreements: 1, outstandingMinor: 500_000, percent: 25 },
      { days: 60, agreements: 1, outstandingMinor: 500_000, percent: 25 },
      { days: 90, agreements: 1, outstandingMinor: 500_000, percent: 25 },
    ]);
  });

  it("forecasts what comes due in 7, 30 and 90 days, week by week", () => {
    const f = forecast(
      [
        { dueOn: "2026-12-01", outstandingMinor: 999 }, // today: not ahead
        { dueOn: "2026-12-02", outstandingMinor: 100 },
        { dueOn: "2026-12-08", outstandingMinor: 200 },
        { dueOn: "2026-12-09", outstandingMinor: 300 },
        { dueOn: "2027-02-20", outstandingMinor: 400 },
      ],
      "2026-12-01",
    );
    expect(f).toMatchObject({ next7Minor: 300, next30Minor: 600, next90Minor: 1_000 });
    expect(f.weeks).toHaveLength(13);
    expect(f.weeks[0]).toEqual({ from: "2026-12-02", to: "2026-12-08", amountMinor: 300 });
    expect(f.weeks[1]!.amountMinor).toBe(300);
    expect(collectionRate(400_000, 300_000)).toBe(75);
    expect(collectionRate(0, 0)).toBeNull();
  });
});

describe("work and pay notification rules", () => {
  it("remind the day before by default and keep milestone texts standard", () => {
    expect(RULES.workpay_due.defaults.daysBefore).toEqual([1]);
    expect(RULES.workpay_guarantor_alert.defaults.enabled).toBe(false);
    expect(
      ruleConfig("workpay_due", {
        enabled: true,
        channels: ["sms"],
        daysBefore: [3, 1],
        smsTemplate: "{{driverName}}: {{amount}} due {{dueOn}}",
      }),
    ).toMatchObject({ daysBefore: [3, 1] });
    expect(() =>
      ruleConfig("workpay_milestones", { enabled: true, channels: ["sms"], smsTemplate: "Hi" }),
    ).toThrow(/no SMS text/);
    expect(() =>
      ruleConfig("workpay_overdue", {
        enabled: true,
        channels: ["sms"],
        smsTemplate: "{{balance}}",
      }),
    ).toThrow(/Unknown placeholder/);
  });
});
