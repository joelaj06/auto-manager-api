import { describe, expect, it } from "vitest";
import { alertFor, duePoint, dueStatus, rebase } from "./ServiceDue.js";

const oil = {
  everyKm: 5_000,
  everyDays: 90,
  noticeKm: 1_000,
  noticeDays: 14,
  graceKm: 500,
  graceDays: 7,
};

describe("service due", () => {
  it("is due again by km and by days from its base", () => {
    expect(duePoint(oil, { km: 12_000, on: "2026-01-10" })).toEqual({
      dueKm: 17_000,
      dueOn: "2026-04-10",
    });
    // No odometer yet: only the date counts.
    expect(duePoint(oil, { km: null, on: "2026-01-10" })).toEqual({
      dueKm: null,
      dueOn: "2026-04-10",
    });
    expect(duePoint({ ...oil, everyDays: null }, { km: null, on: "2026-01-10" })).toEqual({
      dueKm: null,
      dueOn: null,
    });
  });

  it("moves from scheduled to upcoming, due and overdue on whichever comes first", () => {
    const point = { dueKm: 17_000, dueOn: "2026-04-10" };
    const at = (km: number, today: string) => dueStatus(oil, point, { km, today });
    expect(at(15_000, "2026-03-01")).toBe("scheduled");
    expect(at(16_000, "2026-03-01")).toBe("upcoming");
    expect(at(15_000, "2026-03-27")).toBe("upcoming");
    expect(at(17_000, "2026-03-01")).toBe("due");
    expect(at(15_000, "2026-04-10")).toBe("due");
    expect(at(17_500, "2026-03-01")).toBe("overdue");
    expect(at(15_000, "2026-04-18")).toBe("overdue");
    expect(at(15_000, "2026-04-17")).toBe("due");
    // The further along wins.
    expect(at(16_500, "2026-04-20")).toBe("overdue");
  });

  it("alerts each status once per due point", () => {
    expect(alertFor("scheduled", null)).toBeNull();
    expect(alertFor("upcoming", null)).toBe("upcoming");
    expect(alertFor("upcoming", "upcoming")).toBeNull();
    expect(alertFor("due", "upcoming")).toBe("due");
    expect(alertFor("overdue", null)).toBe("overdue");
    expect(alertFor("due", "overdue")).toBeNull();
  });

  it("restarts the km count after an odometer replacement", () => {
    expect(rebase({ km: 120_000, on: "2026-01-10" }, 300)).toEqual({ km: 300, on: "2026-01-10" });
    expect(rebase({ km: 120_000, on: "2026-01-10" }, 121_000)).toEqual({
      km: 120_000,
      on: "2026-01-10",
    });
  });
});
