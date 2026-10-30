import { describe, expect, it } from "vitest";
import { ReportRuleError } from "./Report.js";
import {
  nextRunDay,
  periodDates,
  ReportSchedule,
  runParams,
  runsOn,
  type ScheduleDetails,
} from "./ReportSchedule.js";

const details: ScheduleDetails = {
  name: "Weekly P&L",
  reportId: "business_overview",
  params: {},
  period: "previous_week",
  format: "xlsx",
  frequency: "weekly",
  weekday: 1,
  monthDay: null,
  hour: 7,
  recipients: ["u1", "u2", "u1"],
};

describe("report schedule periods", () => {
  // 2026-10-30 is a Friday.
  it("works out the period on the run day", () => {
    expect(periodDates("previous_day", "2026-10-30")).toEqual({
      from: "2026-10-29",
      to: "2026-10-29",
    });
    expect(periodDates("previous_week", "2026-10-30")).toEqual({
      from: "2026-10-19",
      to: "2026-10-25",
    });
    expect(periodDates("previous_month", "2026-03-01")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(periodDates("previous_month", "2026-01-15")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(periodDates("week_to_date", "2026-10-30")).toEqual({
      from: "2026-10-26",
      to: "2026-10-30",
    });
    expect(periodDates("month_to_date", "2026-10-30")).toEqual({
      from: "2026-10-01",
      to: "2026-10-30",
    });
  });

  it("puts the period into the parameters the report takes", () => {
    const d = { params: { branchId: "b" }, period: "previous_month" as const };
    expect(runParams(d, ["from", "to", "branchId"], "2026-11-01")).toEqual({
      branchId: "b",
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(runParams(d, ["asOf"], "2026-11-01")).toEqual({ branchId: "b", asOf: "2026-10-31" });
    expect(runParams(d, ["month"], "2026-11-01")).toEqual({ branchId: "b", month: "2026-10" });
    expect(runParams({ params: { x: "1" }, period: null }, ["from"], "2026-11-01")).toEqual({
      x: "1",
    });
  });
});

describe("report schedule run days", () => {
  it("runs daily, on a weekday or on a day of the month", () => {
    const daily = { frequency: "daily" as const, weekday: null, monthDay: null, hour: 6 };
    const monday = { frequency: "weekly" as const, weekday: 1, monthDay: null, hour: 6 };
    const fifth = { frequency: "monthly" as const, weekday: null, monthDay: 5, hour: 6 };
    expect(runsOn(daily, "2026-10-30")).toBe(true);
    expect(runsOn(monday, "2026-11-02")).toBe(true);
    expect(runsOn(monday, "2026-10-30")).toBe(false);
    expect(nextRunDay(monday, "2026-10-30")).toBe("2026-11-02");
    expect(nextRunDay(fifth, "2026-10-30")).toBe("2026-11-05");
    expect(nextRunDay(fifth, "2026-11-05")).toBe("2026-11-05");
  });
});

describe("report schedule", () => {
  const now = new Date("2026-10-30T10:00:00Z");
  const next = new Date("2026-11-02T07:00:00Z");

  it("is created active with its recipients once each", () => {
    const s = ReportSchedule.create({ ...details, id: "s1", ownerId: "u1", nextRunAt: next, now });
    expect(s.status).toBe("active");
    expect(s.snapshot().recipients).toEqual(["u1", "u2"]);
  });

  it("checks the timing and recipients", () => {
    const create = (change: Partial<ScheduleDetails>) =>
      ReportSchedule.create({
        ...details,
        ...change,
        id: "s1",
        ownerId: "u1",
        nextRunAt: next,
        now,
      });
    expect(() => create({ weekday: null })).toThrow(ReportRuleError);
    expect(() => create({ frequency: "daily" })).toThrow("Only a weekly schedule has a weekday");
    expect(() => create({ frequency: "monthly", weekday: null, monthDay: 31 })).toThrow(
      ReportRuleError,
    );
    expect(() => create({ hour: 24 })).toThrow("The hour is 0 to 23");
    expect(() => create({ recipients: [] })).toThrow(ReportRuleError);
    expect(() => create({ name: "  " })).toThrow(ReportRuleError);
  });

  it("moves on after a run, waits after a miss, and resumes", () => {
    const s = ReportSchedule.create({ ...details, id: "s1", ownerId: "u1", nextRunAt: next, now });
    const later = new Date("2026-11-09T07:00:00Z");
    s.ran("j1", later, next);
    expect(s.snapshot()).toMatchObject({ lastJobId: "j1", lastRunAt: next, nextRunAt: later });
    s.missed("No room", later, later);
    expect(s.snapshot()).toMatchObject({ lastError: "No room", nextRunAt: later });
    s.pause("The owner may no longer run this report", later);
    expect(s.status).toBe("paused");
    expect(() => s.ran("j2", later, later)).toThrow("The schedule is paused");
    s.resume(new Date("2026-11-16T07:00:00Z"), later);
    expect(s.snapshot()).toMatchObject({ status: "active", lastError: null });
  });
});

describe("report schedule timing", () => {
  it("is checked before the next run day is looked for", () => {
    expect(() =>
      nextRunDay({ frequency: "weekly", weekday: null, monthDay: null, hour: 7 }, "2026-10-30"),
    ).toThrow(ReportRuleError);
  });
});
