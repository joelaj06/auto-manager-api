import { describe, expect, it } from "vitest";
import { ruleConfig } from "../notifications/NotificationRules.js";
import {
  complianceLevel,
  costPerDistance,
  inServiceSeconds,
  meanDaysBetweenFailures,
  offRoadSeconds,
  percentOf,
} from "./MaintenanceMetrics.js";

const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour));
const from = at(1);
const to = at(11);
const now = at(20);
const HOUR = 3_600;

describe("offRoadSeconds", () => {
  it("counts overlapping spells once and cuts them to the period", () => {
    expect(
      offRoadSeconds(
        [
          { start: at(2), end: at(3) },
          { start: at(2, 12), end: at(4) }, // the incident behind the same stay
          { start: at(10), end: at(12) }, // runs past the period
          { start: at(5), end: at(5) }, // empty
        ],
        from,
        to,
        now,
      ),
    ).toBe((48 + 24) * HOUR);
  });

  it("runs an open spell to now and ignores spells outside the period", () => {
    expect(offRoadSeconds([{ start: at(9), end: null }], from, to, at(10))).toBe(24 * HOUR);
    expect(offRoadSeconds([{ start: at(12), end: null }], from, to, now)).toBe(0);
  });
});

describe("inServiceSeconds", () => {
  it("counts from when the vehicle was added until it left, up to now", () => {
    expect(inServiceSeconds({ addedAt: at(3), leftAt: null }, from, to, now)).toBe(8 * 24 * HOUR);
    expect(inServiceSeconds({ addedAt: at(1), leftAt: at(6) }, from, to, now)).toBe(5 * 24 * HOUR);
    expect(inServiceSeconds({ addedAt: at(1), leftAt: null }, from, to, at(2))).toBe(24 * HOUR);
    expect(inServiceSeconds({ addedAt: at(15), leftAt: null }, from, to, now)).toBe(0);
  });
});

describe("ratios", () => {
  it("rounds percent, cost per km and mean days between failures, null without a base", () => {
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(1, 0)).toBeNull();
    expect(costPerDistance(100_000, 3_000)).toBe(33);
    expect(costPerDistance(100_000, 0)).toBeNull();
    expect(meanDaysBetweenFailures(30 * 86_400, 4)).toBe(7.5);
    expect(meanDaysBetweenFailures(30 * 86_400, 0)).toBeNull();
  });
});

describe("complianceLevel", () => {
  const none = {
    documentsExpired: 0,
    documentsExpiring: 0,
    servicesOverdue: 0,
    servicesDue: 0,
    finesOverdue: 0,
  };
  it("is red, amber or green", () => {
    expect(complianceLevel(none)).toBe("green");
    expect(complianceLevel({ ...none, documentsExpiring: 1 })).toBe("amber");
    expect(complianceLevel({ ...none, finesOverdue: 2 })).toBe("amber");
    expect(complianceLevel({ ...none, servicesDue: 1, servicesOverdue: 1 })).toBe("red");
    expect(complianceLevel({ ...none, documentsExpired: 1 })).toBe("red");
  });
});

describe("vehicle_idle rule", () => {
  it("defaults to 7 days and takes 1 to 365", () => {
    expect(ruleConfig("vehicle_idle", { enabled: true, channels: ["in_app"] })).toMatchObject({
      afterDays: 7,
    });
    expect(
      ruleConfig("vehicle_idle", { enabled: true, channels: ["in_app"], afterDays: 14 }).afterDays,
    ).toBe(14);
    expect(() =>
      ruleConfig("vehicle_idle", { enabled: true, channels: ["in_app"], afterDays: 0 }),
    ).toThrow(/1 to 365/);
    expect(
      ruleConfig("work_order_overdue", { enabled: true, channels: ["push"] }),
    ).not.toHaveProperty("afterDays");
  });
});
