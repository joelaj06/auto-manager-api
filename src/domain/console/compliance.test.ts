import { describe, expect, it } from "vitest";
import type { Incident } from "../repositories/IComplianceRepositories.js";
import { nextQuarterEnd, overallStatus, quarterEnd } from "./Compliance.js";

const incident = (
  impact: Incident["impact"],
  status: Incident["status"] = "investigating",
): Incident => ({
  id: "i",
  title: "Slow API",
  impact,
  status,
  components: ["api"],
  startedAt: new Date(0),
  resolvedAt: status === "resolved" ? new Date(1) : null,
  createdBy: "staff",
  updates: [],
});

describe("compliance rules", () => {
  it("finds the end of a quarter and of the next one", () => {
    expect(quarterEnd("2026-01-15")).toBe("2026-03-31");
    expect(quarterEnd("2026-11-02")).toBe("2026-12-31");
    expect(nextQuarterEnd("2026-11-02")).toBe("2027-03-31");
    expect(nextQuarterEnd("2026-06-30")).toBe("2026-09-30");
  });

  it("shows the worst unresolved incident, or maintenance", () => {
    expect(overallStatus([], false)).toBe("operational");
    expect(overallStatus([], true)).toBe("maintenance");
    expect(overallStatus([incident("minor"), incident("critical", "resolved")], false)).toBe(
      "degraded",
    );
    expect(overallStatus([incident("major"), incident("minor")], true)).toBe("partial_outage");
    expect(overallStatus([incident("critical", "monitoring")], false)).toBe("major_outage");
  });
});
