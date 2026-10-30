import { describe, expect, it } from "vitest";
import { checkParams, ReportJob, ReportRuleError, type ReportParam } from "./Report.js";

const PARAMS: readonly ReportParam[] = [
  { key: "from", label: "From", type: "date", required: true },
  { key: "month", label: "Month", type: "month", required: false },
  { key: "branchId", label: "Branch", type: "uuid", required: false },
  { key: "groupBy", label: "Group by", type: "enum", required: false, options: ["day", "month"] },
];

describe("report parameters", () => {
  it("keeps the values given and leaves out the empty ones", () => {
    expect(
      checkParams(PARAMS, { from: "2026-10-01", month: "", groupBy: "month", branchId: null }),
    ).toEqual({ from: "2026-10-01", groupBy: "month" });
  });

  it("refuses unknown keys, missing required values and bad values", () => {
    expect(() => checkParams(PARAMS, { from: "2026-10-01", extra: "x" })).toThrow(
      'The report takes no parameter "extra"',
    );
    expect(() => checkParams(PARAMS, {})).toThrow("From is required");
    expect(() => checkParams(PARAMS, { from: "2026-13-01" })).toThrow(ReportRuleError);
    expect(() => checkParams(PARAMS, { from: "2026-10-01", month: "2026-1" })).toThrow(
      "Month is not a valid month",
    );
    expect(() => checkParams(PARAMS, { from: "2026-10-01", branchId: "nope" })).toThrow(
      "Branch is not a valid uuid",
    );
    expect(() => checkParams(PARAMS, { from: "2026-10-01", groupBy: "week" })).toThrow(
      "Group by is one of day, month",
    );
    expect(() => checkParams(PARAMS, { from: 20261001 })).toThrow(ReportRuleError);
    expect(() => checkParams(PARAMS, ["2026-10-01"])).toThrow("Report parameters are an object");
  });
});

describe("report job", () => {
  const now = new Date("2026-10-30T08:00:00Z");
  const job = () =>
    ReportJob.request({
      id: "j1",
      reportId: "trial_balance",
      params: {},
      format: "csv",
      requestedBy: "u1",
      now,
    });

  it("is built once, kept seven days and then expires", () => {
    const j = job();
    expect(j.start(now)).toBe(true);
    j.complete("f1", 12, now);
    expect(j.snapshot()).toMatchObject({
      status: "ready",
      fileId: "f1",
      rowCount: 12,
      expiresAt: new Date("2026-11-06T08:00:00Z"),
    });
    expect(j.start(now)).toBe(false);
    j.expire();
    expect(j.status).toBe("expired");
    expect(() => j.expire()).toThrow(ReportRuleError);
  });

  it("is taken again after a lost attempt and fails with the reason", () => {
    const j = job();
    j.start(now);
    expect(j.start(now)).toBe(true);
    j.fail("  ", now);
    expect(j.snapshot()).toMatchObject({
      status: "failed",
      error: "The report could not be built",
    });
    j.fail("later", now);
    expect(j.snapshot().error).toBe("The report could not be built");
    expect(() => j.complete("f1", 1, now)).toThrow("The report is not being built");
  });
});
