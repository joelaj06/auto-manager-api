import { describe, expect, it } from "vitest";
import {
  AnalyticsRuleError,
  checkRates,
  expectedModules,
  healthScore,
  moduleCounts,
  moduleOf,
  monthlyCost,
  onboardingProgress,
  type HealthInput,
} from "./TenantAnalytics.js";

describe("modules", () => {
  it("maps audited entity types to modules by whole names", () => {
    expect(moduleOf("vehicle")).toBe("fleet");
    expect(moduleOf("vehicle_damage")).toBe("fleet");
    expect(moduleOf("rental_booking")).toBe("rentals");
    expect(moduleOf("workpay_agreement")).toBe("workpay");
    expect(moduleOf("part")).toBe("maintenance");
    expect(moduleOf("partner")).toBeNull();
    expect(moduleOf("organisation")).toBeNull();
    expect(moduleCounts({ vehicle: 3, vehicle_block: 2, remittance: 5, user: 1 })).toMatchObject({
      fleet: 5,
      drivers: 5,
      rentals: 0,
    });
  });

  it("expects the modules of the business type", () => {
    expect(expectedModules("rental")).toContain("rentals");
    expect(expectedModules("rental")).not.toContain("workpay");
    expect(expectedModules("dealer")).toContain("dealer");
    expect(expectedModules("mixed")).toHaveLength(10);
  });
});

describe("onboarding", () => {
  it("counts the steps that apply to the business", () => {
    const fleet = onboardingProgress(
      { vehicle_added: "2026-10-01", first_remittance: "2026-10-03" },
      "fleet",
    );
    expect(fleet).toMatchObject({ done: 2, total: 7, percent: 29 });
    expect(fleet.steps.map((s) => s.key)).not.toContain("first_rental");
    const dealer = onboardingProgress({}, "dealer");
    expect(dealer.steps.map((s) => s.key)).toEqual([
      "branch_added",
      "vehicle_added",
      "user_invited",
      "first_transaction",
      "app_installed",
    ]);
  });
});

describe("health score", () => {
  const healthy: HealthInput = {
    loginDays: 14,
    averageActiveUsers: 4,
    users: 4,
    recordsCreated: 14 * 20,
    vehicles: 20,
    vehiclesBefore: 15,
    modulesUsed: 8,
    modulesExpected: 8,
    billing: "paid_up",
    supportSessions: 0,
    jobs: 100,
    failedJobs: 0,
    apiCalls: 5_000,
    apiErrors: 0,
    ageDays: 120,
  };

  it("is 100 for a busy tenant paying on time, ready to expand when it grew", () => {
    expect(healthScore(healthy)).toEqual({
      score: 100,
      components: {
        logins: 20,
        activeUsers: 15,
        records: 20,
        breadth: 15,
        payments: 15,
        support: 5,
        errors: 10,
      },
      flags: ["expansion_ready"],
    });
    expect(healthScore({ ...healthy, vehiclesBefore: 19 }).flags).toEqual([]);
  });

  it("flags a quiet tenant behind on payment as at risk", () => {
    const quiet = healthScore({
      ...healthy,
      loginDays: 2,
      averageActiveUsers: 0.2,
      recordsCreated: 10,
      modulesUsed: 1,
      billing: "overdue",
      supportSessions: 3,
      failedJobs: 10,
      apiErrors: 100,
    });
    expect(quiet.score).toBeLessThan(40);
    expect(quiet.components).toMatchObject({ payments: 0, support: 0 });
    expect(quiet.flags).toEqual(["at_risk"]);
  });

  it("does not flag a tenant in its first 14 days", () => {
    expect(healthScore({ ...healthy, loginDays: 0, ageDays: 3 }).flags).toEqual(["new"]);
  });
});

describe("cost to serve", () => {
  const rates = {
    currency: "GHS",
    tenantMonthMinor: 2_000,
    databaseGbMonthMinor: 1_000,
    storageGbMonthMinor: 200,
    apiCallsThousandMinor: 5,
    jobsThousandMinor: 10,
  };

  it("adds the fixed cost, size, calls and jobs of a month", () => {
    expect(
      monthlyCost(
        {
          databaseBytes: 2 * 1024 ** 3,
          storageBytes: 5 * 1024 ** 3,
          apiCalls: 40_000,
          jobs: 3_000,
        },
        rates,
      ),
    ).toEqual({
      fixedMinor: 2_000,
      databaseMinor: 2_000,
      storageMinor: 1_000,
      apiMinor: 200,
      jobsMinor: 30,
      totalMinor: 5_230,
    });
  });

  it("checks the rates", () => {
    expect(checkRates(rates)).toBe(rates);
    expect(() => checkRates({ ...rates, jobsThousandMinor: -1 })).toThrow(AnalyticsRuleError);
    expect(() => checkRates({ ...rates, currency: "cedi" })).toThrow(AnalyticsRuleError);
  });
});
