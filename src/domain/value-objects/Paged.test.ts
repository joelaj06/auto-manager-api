import { describe, expect, it } from "vitest";
import { sumRows } from "./Paged.js";

describe("sumRows", () => {
  it("adds up rows in hand: the amount, the amount by status and each measure", () => {
    const rows = [
      { status: "in_arrears", outstanding: 500, overdue: 200 },
      { status: "defaulted", outstanding: 900, overdue: 900 },
      { status: "in_arrears", outstanding: 100, overdue: 0 },
    ];
    expect(
      sumRows(rows, {
        amount: (r) => r.outstanding,
        status: (r) => r.status,
        measures: { overdue: (r) => r.overdue },
      }),
    ).toEqual({
      amount: 1500,
      byStatus: { in_arrears: 600, defaulted: 900 },
      measures: { overdue: 1100 },
    });
  });

  it("gives zeros for an empty list", () => {
    expect(sumRows([], { measures: { fees: () => 1 } })).toEqual({
      amount: 0,
      byStatus: {},
      measures: { fees: 0 },
    });
  });
});
